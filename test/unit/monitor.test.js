'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { mkTmpDir, rmTmpDir } = require('./helpers');
const { globToRegExp, compileGlobs, staticPrefix } = require('../../server/monitor/glob');
const { parseStatusV2, parseNumstat, getRepoState } = require('../../server/monitor/gitState');
const { TreeWatcher, dirsOf } = require('../../server/monitor/treeWatcher');

function makeRepo(t) {
  const dir = mkTmpDir('mon');
  t.after(() => rmTmpDir(dir));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'uno\ndos\ntres\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# r\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.env\nnode_modules/\ndist/\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return { dir, git };
}

const waitFor = (emitter, event, ms = 4000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`sin evento ${event} en ${ms} ms`)), ms);
    emitter.once(event, (v) => {
      clearTimeout(timer);
      resolve(v);
    });
  });

test('glob: semantica tipo .gitignore', () => {
  const m = compileGlobs(['.env', '/root-only.txt', 'dist/**', '*.log', 'config/*.json']);
  assert.ok(m('.env'));
  assert.ok(m('apps/web/.env'));
  assert.ok(!m('.env.local'));
  assert.ok(m('root-only.txt'));
  assert.ok(m('dist/a/b.js'));
  assert.ok(!m('src/dist/a.js'));
  assert.ok(m('logs/x.log'));
  assert.ok(m('config/a.json'));
  assert.ok(!m('config/x/a.json'));
  assert.equal(globToRegExp('  '), null);
  assert.ok(compileGlobs(['src/**/*.test.js'])('src/a/b/c.test.js'));
  assert.ok(compileGlobs(['src/**/*.test.js'])('src/c.test.js'));
});

test('staticPrefix: fixed folder at the start of the pattern', () => {
  assert.equal(staticPrefix('dist/**'), 'dist');
  assert.equal(staticPrefix('/build/out/*.js'), 'build/out');
  assert.equal(staticPrefix('.env'), null);
  assert.equal(staticPrefix('**/x'), null);
});

test('parseStatusV2: branch, ahead/behind and states', () => {
  const out = [
    '# branch.oid abc',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 a a src/a.js',
    '1 A. N... 000000 100644 100644 0 b new file.txt',
    '2 R. N... 100644 100644 100644 a a R100 dst.js',
    'src.js',
    '? untracked.md',
    ''
  ].join('\0');
  const s = parseStatusV2(out);
  assert.equal(s.branch, 'main');
  assert.equal(s.ahead, 2);
  assert.equal(s.behind, 1);
  assert.deepEqual(
    s.files.map((f) => [f.path, f.status, f.staged, f.unstaged]),
    [
      ['src/a.js', 'modified', false, true],
      ['new file.txt', 'added', true, false],
      ['dst.js', 'renamed', true, false],
      ['untracked.md', 'untracked', false, true]
    ]
  );
  assert.equal(s.files[2].origPath, 'src.js');
});

test('parseNumstat: lines, binaries and renames', () => {
  const map = parseNumstat(['3\t1\ta.js', '-\t-\timg.png', '2\t0\t', 'old.js', 'new.js', ''].join('\0'));
  assert.deepEqual(map.get('a.js'), { added: 3, removed: 1, binary: false });
  assert.equal(map.get('img.png').binary, true);
  assert.deepEqual(map.get('new.js'), { added: 2, removed: 0, binary: false });
});

test('getRepoState: real changes in a repo', async (t) => {
  const { dir, git } = makeRepo(t);
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'uno\nDOS\ntres\ncuatro\n');
  fs.writeFileSync(path.join(dir, 'nuevo.txt'), 'x\n');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1\n'); // ignorado: no aparece
  git('add', 'nuevo.txt');
  const s = await getRepoState(dir);
  assert.equal(s.branch, 'main');
  assert.equal(s.dirty, true);
  assert.deepEqual(s.files.map((f) => f.path).sort(), ['nuevo.txt', 'src/a.js']);
  assert.equal(s.counts.staged, 1);
  assert.equal(s.counts.modified, 1);
  assert.deepEqual(s.lines, { added: 3, removed: 1 });
  assert.equal(s.lastCommit.subject, 'init');
});

test('dirsOf: folders of a list of files', () => {
  assert.deepEqual([...dirsOf(['a/b/c.js', 'a/d.js', 'x.js'])].sort(), ['', 'a', 'a/b']);
});

// Both watching modes run everywhere: per-folder (Linux default) and native
// recursive (macOS and Windows default; Node also supports it on Linux).
for (const recursive of [false, true]) {
  const mode = recursive ? 'recursive' : 'per-folder';

  test(`TreeWatcher (${mode}): batches changes, watches new folders and skips ignored ones`, async (t) => {
    const { dir } = makeRepo(t);
    fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
    const w = await new TreeWatcher(dir, { debounceMs: 100, recursive }).start();
    t.after(() => w.close());
    if (!recursive) assert.ok(![...w.watchers.keys()].some((k) => k.startsWith('node_modules')));

    let batch = waitFor(w, 'change');
    fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'cambio\n');
    fs.writeFileSync(path.join(dir, 'README.md'), 'cambio\n');
    fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'ignored\n');
    assert.deepEqual((await batch).paths.sort(), ['README.md', 'src/a.js']);

    batch = waitFor(w, 'change');
    fs.mkdirSync(path.join(dir, 'lib'));
    await batch;
    await new Promise((r) => setTimeout(r, 150)); // the new folder is watched after checking git
    batch = waitFor(w, 'change');
    fs.writeFileSync(path.join(dir, 'lib', 'b.js'), 'x');
    assert.ok((await batch).paths.includes('lib/b.js'));
  });

  // macOS coalesces these events (FSEvents): the per-folder mode can miss the file there,
  // which is why macOS uses the recursive mode.
  const racy = !recursive && process.platform === 'darwin' ? { skip: 'per-folder mode is not used on macOS' } : {};
  test(`TreeWatcher (${mode}): a file created right after its folder is not missed`, racy, async (t) => {
    const { dir } = makeRepo(t);
    const w = await new TreeWatcher(dir, { debounceMs: 100, recursive }).start();
    t.after(() => w.close());
    const seen = new Set();
    w.on('change', ({ paths }) => paths.forEach((p) => seen.add(p)));
    fs.mkdirSync(path.join(dir, 'test'));
    fs.writeFileSync(path.join(dir, 'test', 'a.test.js'), 'x'); // before the watch on test/ is in place
    const deadline = Date.now() + 3000;
    while (!seen.has('test/a.test.js') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.ok(seen.has('test/a.test.js'));
  });

  test(`TreeWatcher (${mode}): a commit shows up as a git change`, async (t) => {
    const { dir, git } = makeRepo(t);
    const w = await new TreeWatcher(dir, { debounceMs: 100, recursive }).start();
    t.after(() => w.close());
    const batch = waitFor(w, 'change');
    git('commit', '-q', '--allow-empty', '-m', 'vacio');
    assert.equal((await batch).git, true);
  });
}

test('MonitorService: initial state, refresh after a change and plane 2 events', async (t) => {
  const cfg = mkTmpDir('mon-cfg');
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = cfg;
  t.after(() => {
    process.env.XDG_CONFIG_HOME = prev;
    rmTmpDir(cfg);
  });
  const { MonitorService } = require('../../server/monitor/monitorService');
  const { dir } = makeRepo(t);
  const mon = new MonitorService({ getRepos: () => [{ projectId: 'p1', name: 'r', path: dir }], debounceMs: 80 });
  t.after(() => mon.stop());
  await mon.start();
  assert.equal(mon.snapshot()[0].state.dirty, false);

  const stateEv = waitFor(mon, 'state');
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'otro\n');
  const { state } = await stateEv;
  assert.equal(state.dirty, true);
  assert.equal(state.files[0].path, 'src/a.js');

  // .env is in .gitignore, but in the default plane 2 watchlist
  const created = waitFor(mon, 'watch_event');
  fs.writeFileSync(path.join(dir, '.env'), 'A=1\n');
  const ev = await created;
  assert.equal(ev.path, '.env');
  assert.equal(ev.kind, 'created');
  const deleted = waitFor(mon, 'watch_event');
  fs.unlinkSync(path.join(dir, '.env'));
  assert.equal((await deleted).kind, 'deleted');
  assert.equal(mon.recentWatchEvents('p1').length, 2);
});

test('diff: hunks with line numbers, a new untracked file and full mode', async (t) => {
  const { getDiff, parseUnifiedDiff, safeRel } = require('../../server/monitor/diff');
  const { dir } = makeRepo(t);
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'uno\nDOS\ntres\n');
  const d = await getDiff(dir, { path: 'src/a.js', mode: 'head', context: 0 });
  assert.equal(d.files.length, 1);
  const lines = d.files[0].hunks[0].lines;
  assert.deepEqual(
    lines.map((l) => [l.type, l.text, l.oldNo, l.newNo]),
    [
      ['del', 'dos', 2, undefined],
      ['add', 'DOS', undefined, 2]
    ]
  );
  const full = await getDiff(dir, { path: 'src/a.js', mode: 'head', context: 'full' });
  assert.equal(full.files[0].hunks[0].lines.length, 4); // uno, -dos, +DOS, tres

  fs.writeFileSync(path.join(dir, 'nuevo.md'), 'a\nb\n');
  const nuevo = await getDiff(dir, { path: 'nuevo.md' });
  assert.equal(nuevo.files[0].status, 'untracked');
  assert.equal(nuevo.files[0].added, 2);

  await assert.rejects(getDiff(dir, { path: '../fuera' }), /ruta no valida/);
  await assert.rejects(getDiff(dir, { mode: 'commit', ref: 'HEAD; rm -rf' }), /commit no válido/);
  assert.equal(safeRel('/etc/passwd'), null);
  assert.equal(parseUnifiedDiff('').length, 0);
});

test('listCommits: commits with files and lines', async (t) => {
  const { listCommits } = require('../../server/monitor/diff');
  const { dir, git } = makeRepo(t);
  fs.writeFileSync(path.join(dir, 'b.txt'), '1\n2\n');
  git('add', '.');
  git('commit', '-q', '-m', 'segundo commit');
  const commits = await listCommits(dir, { limit: 5 });
  assert.equal(commits.length, 2);
  assert.equal(commits[0].subject, 'segundo commit');
  assert.equal(commits[0].files, 1);
  assert.equal(commits[0].added, 2);
  assert.match(commits[0].sha, /^[0-9a-f]{40}$/);
});

test('isTransient: ignores atomic writes and editor files, not regular ones', () => {
  const { isTransient } = require('../../server/monitor/treeWatcher');
  for (const p of ['README.md.tmp.147857.98b65491f150', 'src/.a.js.swp', 'a.txt~', 'src/.#notas.md', '4913'])
    assert.equal(isTransient(p), true, p);
  for (const p of ['README.md', 'src/tmp/a.js', 'notes.tmp', 'docs/api.md']) assert.equal(isTransient(p), false, p);
});

test('MonitorService: a change whose event was lost is reported after the watchers change', async (t) => {
  const cfg = mkTmpDir('mon-catchup');
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = cfg;
  t.after(() => {
    process.env.XDG_CONFIG_HOME = prev;
    rmTmpDir(cfg);
  });
  const { MonitorService } = require('../../server/monitor/monitorService');
  const { dir } = makeRepo(t);
  const mon = new MonitorService({ getRepos: () => [{ projectId: 'p1', name: 'r', path: dir }], debounceMs: 80 });
  t.after(() => mon.stop());
  await mon.start();
  const activity = [];
  mon.on('activity', (e) => activity.push(e));

  // A change seen by the watcher is reported once, not again by the catch-up.
  const seenState = waitFor(mon, 'state');
  fs.writeFileSync(path.join(dir, 'visto.js'), 'a\n');
  await seenState;
  mon.watchersChanged();
  await waitFor(mon, 'state');
  assert.deepEqual(
    activity.map((e) => [e.paths, Boolean(e.catchUp)]),
    [[['visto.js'], false]]
  );

  // As macOS does while its FSEvents stream restarts: the change produces no event.
  mon.entry('p1').watcher.close();
  fs.writeFileSync(path.join(dir, 'config.js'), "module.exports = { token: 'x' };\n");
  mon.watchersChanged();
  await waitFor(mon, 'state');
  const caught = activity.find((e) => e.catchUp);
  assert.deepEqual(caught?.paths, ['config.js']);
});
