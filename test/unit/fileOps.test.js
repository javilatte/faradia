'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mkTmpDir, rmTmpDir } = require('./helpers');
const { resolveRepoPath, listDir, preview } = require('../../server/fs/explorer');

function setup(t) {
  const data = mkTmpDir('fs-data');
  const repo = mkTmpDir('fs-repo');
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = data;
  t.after(() => {
    process.env.XDG_DATA_HOME = prev;
    rmTmpDir(data);
    rmTmpDir(repo);
  });
  fs.mkdirSync(path.join(repo, '.git'));
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'a');
  fs.writeFileSync(path.join(repo, 'README.md'), '# hola');
  return { repo, ops: require('../../server/fs/fileOps') };
}

test('resolveRepoPath: never leaves the repo or touches .git', (t) => {
  const { repo } = setup(t);
  assert.equal(resolveRepoPath(repo, 'src/a.js').rel, 'src/a.js');
  assert.equal(resolveRepoPath(repo, '/src/a.js/').rel, 'src/a.js'); // extra slashes
  assert.throws(() => resolveRepoPath(repo, '../fuera'), /sale del repo/);
  assert.throws(() => resolveRepoPath(repo, 'src/../../fuera'), /sale del repo/);
  assert.throws(() => resolveRepoPath(repo, '.git/config', { mustExist: false }), /\.git/);
  assert.throws(() => resolveRepoPath(repo, '.optimia/tasks.json', { mustExist: false }), /\.optimia/);
  assert.throws(() => resolveRepoPath(repo, 'no/existe'), /no existe/);
  assert.throws(() => resolveRepoPath(repo, '', { allowRoot: false }), /raíz/);
  fs.symlinkSync('/etc', path.join(repo, 'etc-link'));
  assert.throws(() => resolveRepoPath(repo, 'etc-link'), /fuera del repo/);
});

test('listDir and preview: folders first, without .git or .optimia, and preview kinds', (t) => {
  const { repo } = setup(t);
  fs.mkdirSync(path.join(repo, '.optimia'));
  const { entries } = listDir(repo, '');
  assert.deepEqual(
    entries.map((e) => [e.name, e.dir]),
    [
      ['src', true],
      ['README.md', false]
    ]
  );
  assert.equal(preview(repo, 'README.md').kind, 'markdown');
  assert.equal(preview(repo, 'src/a.js').kind, 'text');
  fs.writeFileSync(path.join(repo, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]));
  assert.equal(preview(repo, 'img.png').kind, 'image');
  fs.writeFileSync(path.join(repo, 'bin.dat'), Buffer.from([1, 0, 2]));
  assert.equal(preview(repo, 'bin.dat').kind, 'none');
});

test('rename, move y copy no sobrescriben y devuelven su deshacer', (t) => {
  const { repo, ops } = setup(t);
  const r = ops.rename(repo, 'README.md', 'LEEME.md');
  assert.ok(fs.existsSync(path.join(repo, 'LEEME.md')));
  ops.undo(repo, r.undo);
  assert.ok(fs.existsSync(path.join(repo, 'README.md')));
  assert.throws(() => ops.rename(repo, 'README.md', 'src'), /ya existe/);
  assert.throws(() => ops.rename(repo, 'README.md', '../x'), /nombre no válido/);

  const m = ops.move(repo, 'README.md', 'src');
  assert.equal(m.path, 'src/README.md');
  ops.undo(repo, m.undo);
  assert.ok(fs.existsSync(path.join(repo, 'README.md')));
  assert.throws(() => ops.move(repo, 'src', 'src'), /si misma|ya esta/);

  assert.equal(ops.copy(repo, 'src/a.js', 'src').path, 'src/a (copia).js');
  assert.equal(ops.copy(repo, 'src/a.js', 'src').path, 'src/a (copia 2).js');
  const c = ops.copy(repo, 'src', '');
  assert.equal(c.path, 'src (copia)');
  ops.undo(repo, c.undo); // undoing a copy sends it to the trash
  assert.ok(!fs.existsSync(path.join(repo, 'src (copia)')));
});

test('trash: delete, list, restore (without overwriting) and empty', (t) => {
  const { repo, ops } = setup(t);
  const { trashId, undo } = ops.trash(repo, 'src', { projectId: 'p' });
  assert.ok(!fs.existsSync(path.join(repo, 'src')));
  const items = ops.listTrash({ repoRoot: repo });
  assert.equal(items.length, 1);
  assert.equal(items[0].dir, true);
  assert.equal(items[0].path, 'src');
  assert.equal(undo.trashId, trashId);

  fs.mkdirSync(path.join(repo, 'src')); // alguien creo otra src mientras tanto
  const restored = ops.restore(trashId);
  assert.equal(restored.path, 'src (restaurado)');
  assert.ok(fs.existsSync(path.join(repo, 'src (restaurado)', 'a.js')));
  assert.equal(ops.listTrash().length, 0);

  ops.trash(repo, 'README.md');
  assert.equal(ops.purge({ repoRoot: repo }), 1);
  assert.equal(ops.listTrash().length, 0);
  assert.throws(() => ops.restore('nope'), /papelera/);
});

test('moveAcross: if rename fails across disks (EXDEV), copies and deletes', (t) => {
  const { repo, ops } = setup(t);
  const original = fs.renameSync;
  t.after(() => {
    fs.renameSync = original;
  });
  fs.renameSync = () => {
    const err = new Error('cross-device');
    err.code = 'EXDEV';
    throw err;
  };
  ops.moveAcross(path.join(repo, 'src'), path.join(repo, 'otro', 'src'));
  fs.renameSync = original;
  assert.ok(fs.existsSync(path.join(repo, 'otro', 'src', 'a.js')));
  assert.ok(!fs.existsSync(path.join(repo, 'src')));
});
