'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { git } = require('./gitState');

// Vigila un repo (o el worktree de una tarea) sin fs.watch recursivo: en Linux ese
// modo pone un watch de inotify en CADA subcarpeta, node_modules incluido, y con
// varios repos agota el limite del sistema. Aqui solo se vigilan las carpetas que
// importan: las que tienen ficheros versionados o nuevos no ignorados, las de la
// lista de vigilancia (plano 2) y los metadatos de git (HEAD, index, ramas).
// Los cambios se agrupan (debounce) y se emiten como un lote:
//   'change' { paths: [rutas relativas], git: boolean (cambio en HEAD/index/refs) }

const SELF_DIRS = ['.optimia', '.codegraph'];

function isSelf(rel) {
  return SELF_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`));
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
   * extraDirs: carpetas (relativas) a vigilar enteras aunque git las ignore,
   * p. ej. "dist" para un patron "dist/**" del plano 2.
   */
  constructor(root, { extraDirs = [], maxDirs = 4000, debounceMs = 300, watchGitMeta = true } = {}) {
    super();
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
    let tracked = [];
    let untracked = [];
    try {
      tracked = (await git(this.root, ['ls-files', '-z'])).split('\0').filter(Boolean);
      untracked = (await git(this.root, ['ls-files', '-z', '--others', '--exclude-standard']))
        .split('\0')
        .filter(Boolean);
    } catch {
      /* no es un repo git: solo la raiz */
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

  watchGit() {
    const gitDir = path.join(this.root, '.git');
    try {
      if (!fs.statSync(gitDir).isDirectory()) return; // worktree: .git es un fichero
    } catch {
      return;
    }
    const watch = (abs) => {
      try {
        const w = fs.watch(abs, (_event, name) => {
          if (!name || name.endsWith('.lock')) return;
          if (abs === gitDir && !['HEAD', 'index', 'packed-refs', 'FETCH_HEAD', 'ORIG_HEAD'].includes(String(name)))
            return;
          this.gitChanged = true;
          this.schedule();
        });
        w.on('error', () => w.close());
        this.watchers.set(`\0git:${abs}`, w);
      } catch {
        /* carpeta desaparecida */
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
        /* sin ramas aun */
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
      /* desaparecio entre el listado y el watch */
    }
  }

  onEvent(dirRel, event, name) {
    if (!name) return;
    const rel = dirRel ? `${dirRel}/${name}` : String(name);
    if (rel === '.git' || rel.startsWith('.git/') || isSelf(rel)) return;
    this.pending.add(rel);
    // Carpeta nueva: se vigila si git no la ignora (o si es de la lista del plano 2).
    if (event === 'rename' && !this.watchers.has(rel)) this.maybeWatchNewDir(rel);
    this.schedule();
  }

  async maybeWatchNewDir(rel) {
    const abs = path.join(this.root, rel);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      return; // era un borrado
    }
    if (!stat.isDirectory() || this.watchers.size >= this.maxDirs) return;
    const extra = this.extraDirs.some((d) => rel === d || rel.startsWith(`${d}/`));
    if (!extra) {
      try {
        await git(this.root, ['check-ignore', '-q', rel]);
        return; // ignorada por git
      } catch {
        /* exit 1 = no ignorada: se vigila */
      }
    }
    const dirs = new Set();
    walkDirs(this.root, rel, dirs, this.maxDirs - this.watchers.size);
    for (const d of dirs) this.watchDir(d);
    // Lo que se escribio dentro antes de que el watch estuviera puesto (p. ej. mkdir y
    // un fichero justo despues) no genero evento: se informa ahora.
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
    const paths = [...this.pending];
    const gitChanged = this.gitChanged;
    this.pending.clear();
    this.gitChanged = false;
    if (paths.length || gitChanged) this.emit('change', { paths, git: gitChanged });
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

module.exports = { TreeWatcher, dirsOf, isSelf };
