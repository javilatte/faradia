'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { git } = require('./gitState');

// Watches a repo (or a task worktree) without a recursive fs.watch: on Linux that mode puts an
// inotify watch on EVERY subfolder, node_modules included, and with several repos it exhausts the
// system limit. Only the folders that matter are watched: those with tracked or new non-ignored
// files, those of the watchlist (plane 2) and the git metadata (HEAD, index, refs). Changes are
// debounced and emitted as a batch:
//   'change' { paths: [relative paths], git: boolean (change in HEAD/index/refs) }

const SELF_DIRS = ['.faradia', '.optimia', '.codegraph'];

// Files in .git/ whose change means a commit, checkout or staging change.
const GIT_META = ['HEAD', 'index', 'packed-refs', 'FETCH_HEAD', 'ORIG_HEAD'];

// Native recursive watching: cheap on macOS (FSEvents) and Windows. On Linux it
// would put one inotify watch on every subfolder (node_modules included), so
// there Faradia watches only the folders that matter, one by one.
const NATIVE_RECURSIVE = process.platform === 'darwin' || process.platform === 'win32';

// Which of `dirs` (relative) git ignores. One `git check-ignore --stdin` call.
function checkIgnored(root, dirs) {
  return new Promise((resolve) => {
    const child = spawn('git', ['check-ignore', '--stdin'], {
      cwd: root,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.on('error', () => resolve(new Set()));
    // exit 0 = some ignored, 1 = none ignored, 128 = not a git repo
    child.on('close', () => resolve(new Set(out.split('\n').filter(Boolean))));
    child.stdin.end(dirs.join('\n') + '\n');
  });
}

function isSelf(rel) {
  return SELF_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`));
}

// Ephemeral files from editors and atomic writes (created and renamed right away): changes nobody
// wants to see in the timeline or in the signals.
const TRANSIENT = [
  /\.tmp\.\d+\.[0-9a-f]+$/i, // atomic write (file.tmp.<pid>.<hash>)
  /\.(swp|swo|swx)$/, // vim
  /~$/, // backup copies
  /(^|\/)\.#/, // emacs
  /(^|\/)4913$/, // vim's write test
  /\.crswap$/ // Chrome
];

function isTransient(rel) {
  return TRANSIENT.some((re) => re.test(rel));
}

function dirsOf(files) {
  const dirs = new Set(['']);
  for (const f of files) {
    let d = path.posix.dirname(f);
    while (d && d !== '.' && !dirs.has(d)) {
      dirs.add(d);
      d = path.posix.dirname(d);
    }
  }
  return dirs;
}

function walkDirs(root, rel, out, limit) {
  if (out.size >= limit) return;
  out.add(rel);
  let entries = [];
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory() && !e.isSymbolicLink() && e.name !== '.git')
      walkDirs(root, path.posix.join(rel, e.name), out, limit);
  }
}

class TreeWatcher extends EventEmitter {
  /**
   * extraDirs: folders (relative) watched entirely even if git ignores them, e.g. "dist" for a
   * plane 2 pattern "dist/**".
   */
  constructor(
    root,
    { extraDirs = [], maxDirs = 4000, debounceMs = 300, watchGitMeta = true, recursive = NATIVE_RECURSIVE } = {}
  ) {
    super();
    this.recursive = recursive;
    this.ignoredDirs = new Map(); // recursive mode: dir -> ignored by git?
    this.root = root;
    this.extraDirs = extraDirs;
    this.maxDirs = maxDirs;
    this.debounceMs = debounceMs;
    this.watchGitMeta = watchGitMeta;
    this.watchers = new Map(); // rel -> FSWatcher
    this.pending = new Set();
    this.gitChanged = false;
    this.timer = null;
    this.truncated = false;
    this.closed = false;
  }

  async start() {
    if (this.recursive) return this.startRecursive();
    let tracked = [];
    let untracked = [];
    try {
      tracked = (await git(this.root, ['ls-files', '-z'])).split('\0').filter(Boolean);
      untracked = (await git(this.root, ['ls-files', '-z', '--others', '--exclude-standard']))
        .split('\0')
        .filter(Boolean);
    } catch {
      /* not a git repo: only the root */
    }
    const dirs = dirsOf([...tracked, ...untracked].filter((f) => !isSelf(f)));
    for (const extra of this.extraDirs) {
      if (fs.existsSync(path.join(this.root, extra))) walkDirs(this.root, extra, dirs, this.maxDirs);
    }
    for (const rel of dirs) {
      if (this.watchers.size >= this.maxDirs) {
        this.truncated = true;
        break;
      }
      this.watchDir(rel);
    }
    if (this.watchGitMeta) this.watchGit();
    return this;
  }

  // macOS and Windows: one native recursive watch (FSEvents / ReadDirectoryChangesW)
  // costs next to nothing and sees files created right after their folder, which
  // per-folder watches can miss there. Events inside folders git ignores are
  // filtered out when the batch is flushed (see filterIgnored).
  startRecursive() {
    try {
      const w = fs.watch(this.root, { recursive: true }, (_event, name) => this.onRecursiveEvent(name));
      w.on('error', () => w.close());
      this.watchers.set('', w);
    } catch {
      /* the folder vanished */
    }
    return this;
  }

  onRecursiveEvent(name) {
    if (!name) return;
    const rel = String(name).split(path.sep).join('/');
    if (rel === '.git' || rel.startsWith('.git/')) {
      const sub = rel.slice('.git/'.length);
      const meta = GIT_META.includes(sub) || sub.startsWith('refs/heads/');
      if (this.watchGitMeta && meta && !sub.endsWith('.lock')) {
        this.gitChanged = true;
        this.schedule();
      }
      return;
    }
    if (isSelf(rel)) return;
    // A changed .gitignore can change which folders are ignored.
    if (rel === '.gitignore' || rel.endsWith('/.gitignore')) this.ignoredDirs.clear();
    this.pending.add(rel);
    this.schedule();
  }

  // Drops paths inside folders git ignores (node_modules, build output...) and
  // those folders themselves (FSEvents also reports the folder when something
  // inside changes), except the plane 2 extraDirs. Ignored files such as .env
  // are kept: the plane 2 watchlist needs them. Answers are cached per folder.
  async filterIgnored(paths) {
    const isExtra = (d) => this.extraDirs.some((x) => d === x || d.startsWith(`${x}/`));
    const isDir = (p) => {
      try {
        return fs.statSync(path.join(this.root, p)).isDirectory();
      } catch {
        return false;
      }
    };
    const ancestors = (p) => {
      const out = [];
      for (let d = path.posix.dirname(p); d && d !== '.'; d = path.posix.dirname(d)) out.unshift(d);
      if (isDir(p)) out.push(p);
      return out;
    };
    const unknown = new Set();
    for (const p of paths) {
      for (const d of ancestors(p)) if (!isExtra(d) && !this.ignoredDirs.has(d)) unknown.add(d);
    }
    if (unknown.size) {
      const ignored = await checkIgnored(this.root, [...unknown]);
      for (const d of unknown) this.ignoredDirs.set(d, ignored.has(d));
    }
    return paths.filter((p) => !ancestors(p).some((d) => !isExtra(d) && this.ignoredDirs.get(d)));
  }

  watchGit() {
    const gitDir = path.join(this.root, '.git');
    try {
      if (!fs.statSync(gitDir).isDirectory()) return; // worktree: .git is a file
    } catch {
      return;
    }
    const watch = (abs) => {
      try {
        const w = fs.watch(abs, (_event, name) => {
          if (!name || name.endsWith('.lock')) return;
          if (abs === gitDir && !GIT_META.includes(String(name))) return;
          this.gitChanged = true;
          this.schedule();
        });
        w.on('error', () => w.close());
        this.watchers.set(`\0git:${abs}`, w);
      } catch {
        /* folder vanished */
      }
    };
    watch(gitDir);
    const refs = path.join(gitDir, 'refs', 'heads');
    const stack = [refs];
    while (stack.length && this.watchers.size < this.maxDirs) {
      const dir = stack.pop();
      watch(dir);
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true }))
          if (e.isDirectory()) stack.push(path.join(dir, e.name));
      } catch {
        /* no branches yet */
      }
    }
  }

  watchDir(rel) {
    if (this.closed || this.watchers.has(rel) || isSelf(rel)) return;
    const abs = path.join(this.root, rel);
    try {
      const w = fs.watch(abs, (event, name) => this.onEvent(rel, event, name));
      w.on('error', () => {
        w.close();
        this.watchers.delete(rel);
      });
      this.watchers.set(rel, w);
    } catch {
      /* vanished between the listing and the watch */
    }
  }

  onEvent(dirRel, event, name) {
    if (!name) return;
    const rel = dirRel ? `${dirRel}/${name}` : String(name);
    if (rel === '.git' || rel.startsWith('.git/') || isSelf(rel)) return;
    this.pending.add(rel);
    // New folder: watched unless git ignores it (or it is in the plane 2 watchlist).
    if (event === 'rename' && !this.watchers.has(rel)) this.maybeWatchNewDir(rel);
    this.schedule();
  }

  /**
   * Watches `rel` (and reports the files already inside) when it exists and is not watched yet: a
   * folder created while the watcher was starting produced no event. Per-folder mode only (a native
   * recursive watch sees every folder).
   */
  ensureWatched(rel) {
    if (this.recursive || this.closed || !rel || this.watchers.has(rel)) return Promise.resolve();
    return this.maybeWatchNewDir(rel);
  }

  async maybeWatchNewDir(rel) {
    const abs = path.join(this.root, rel);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      return; // it was a deletion
    }
    if (!stat.isDirectory() || this.watchers.size >= this.maxDirs) return;
    const extra = this.extraDirs.some((d) => rel === d || rel.startsWith(`${d}/`));
    if (!extra) {
      try {
        await git(this.root, ['check-ignore', '-q', rel]);
        return; // ignored by git
      } catch {
        /* exit 1 = not ignored: watch it */
      }
    }
    const dirs = new Set();
    walkDirs(this.root, rel, dirs, this.maxDirs - this.watchers.size);
    for (const d of dirs) this.watchDir(d);
    // Whatever was written inside before the watch was in place (e.g. mkdir and a file right after)
    // produced no event: it is reported now.
    let reported = 0;
    for (const d of dirs) {
      let entries = [];
      try {
        entries = fs.readdirSync(path.join(this.root, d), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isFile() || reported >= 500) continue;
        this.pending.add(`${d}/${e.name}`);
        reported++;
      }
    }
    if (reported) this.schedule();
  }

  schedule() {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  flush() {
    this.timer = null;
    const paths = [...this.pending].filter((p) => !isTransient(p));
    const gitChanged = this.gitChanged;
    this.pending.clear();
    this.gitChanged = false;
    const emit = (kept) => {
      if (!this.closed && (kept.length || gitChanged)) this.emit('change', { paths: kept, git: gitChanged });
    };
    if (!this.recursive) return emit(paths);
    this.filterIgnored(paths).then(emit, () => emit(paths));
  }

  get size() {
    return this.watchers.size;
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
  }
}

module.exports = {
  isTransient,
  TreeWatcher,
  dirsOf,
  isSelf
};
