'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { mkTmpDir, rmTmpDir } = require('./helpers');

// Each test uses its own XDG_CONFIG_HOME: the real ~/.config is never touched.
function freshStore(t) {
  const cfg = mkTmpDir('wb-cfg');
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = cfg;
  t.after(() => {
    process.env.XDG_CONFIG_HOME = prev;
    rmTmpDir(cfg);
  });
  return require('../../server/store/workbenchStore');
}

function makeRepo(parent, rel) {
  const dir = path.join(parent, rel);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return fs.realpathSync(dir);
}

test('ensureLaunchRepo: creates "Mi espacio" with the repo and makes it active', (t) => {
  const wb = freshStore(t);
  const repo = mkTmpDir('wb-launch');
  t.after(() => rmTmpDir(repo));
  const store = wb.ensureLaunchRepo(repo);
  assert.equal(store.workbenches.length, 1);
  assert.equal(store.workbenches[0].name, wb.DEFAULT_NAME);
  assert.deepEqual(store.workbenches[0].repos, [fs.realpathSync(repo)]);
  assert.equal(store.activeWorkbenchId, store.workbenches[0].id);
  // Launching again from the same repo does not duplicate it
  assert.equal(wb.ensureLaunchRepo(repo).workbenches[0].repos.length, 1);
});

test('create, rename, activate and delete workbenches', (t) => {
  const wb = freshStore(t);
  const a = wb.createWorkbench('Trabajo');
  const b = wb.createWorkbench('  Cliente X  ');
  assert.equal(b.name, 'Cliente X');
  assert.equal(wb.listWorkbenches().activeWorkbenchId, a.id);
  wb.setActiveWorkbench(b.id);
  assert.equal(wb.listWorkbenches().activeWorkbenchId, b.id);
  wb.renameWorkbench(a.id, 'Oficina');
  assert.equal(wb.listWorkbenches().workbenches[0].name, 'Oficina');
  wb.deleteWorkbench(b.id);
  assert.equal(wb.listWorkbenches().activeWorkbenchId, a.id);
  assert.throws(() => wb.deleteWorkbench(a.id), /único workbench/);
  assert.throws(() => wb.createWorkbench('   '), /vacío/);
  assert.throws(() => wb.renameWorkbench('nope', 'x'), /no encontrado/);
});

test('addRepos/removeRepo: no duplicates, and a repo can be in several workbenches', (t) => {
  const wb = freshStore(t);
  const root = mkTmpDir('wb-repos');
  t.after(() => rmTmpDir(root));
  const repo = makeRepo(root, 'uno');
  const a = wb.createWorkbench('A');
  const b = wb.createWorkbench('B');
  assert.deepEqual(wb.addRepos(a.id, [repo, `${repo}/`]).added, [repo]);
  wb.addRepos(b.id, [repo]);
  const all = wb.listWorkbenches().workbenches;
  assert.deepEqual(
    all.map((w) => w.repos),
    [[repo], [repo]]
  );
  wb.removeRepo(a.id, repo);
  assert.deepEqual(wb.listWorkbenches().workbenches[0].repos, []);
  assert.throws(() => wb.addRepos(a.id, [path.join(root, 'no-existe')]), /no existe/);
});

test('addRepos: a subfolder counts as its repo; a folder outside git is refused with a way out', (t) => {
  const wb = freshStore(t);
  const root = mkTmpDir('wb-git');
  t.after(() => rmTmpDir(root));
  const repo = makeRepo(root, 'api');
  fs.mkdirSync(path.join(repo, 'src', 'lib'), { recursive: true });
  const a = wb.createWorkbench('A');
  assert.deepEqual(wb.addRepos(a.id, [path.join(repo, 'src', 'lib')]).added, [repo]);
  fs.mkdirSync(path.join(root, 'plain'));
  assert.throws(() => wb.addRepos(a.id, [path.join(root, 'plain')]), /no es un repositorio git.*Buscar repos/);
});

test('scanForRepos: finds repos, does not go into them or into heavy folders, respects the depth', (t) => {
  const wb = freshStore(t);
  const root = mkTmpDir('wb-scan');
  t.after(() => rmTmpDir(root));
  const a = makeRepo(root, 'a');
  const b = makeRepo(root, 'grupo/b');
  makeRepo(root, 'a/dentro'); // dentro de otro repo: no cuenta
  makeRepo(root, 'node_modules/paquete'); // heavy folder: not walked
  makeRepo(root, 'x/y/z/w/muy-hondo'); // beyond maxDepth=3
  assert.deepEqual(wb.scanForRepos(root, { maxDepth: 3 }), [a, b].sort());
  assert.throws(() => wb.scanForRepos(path.join(root, 'nada')), /no existe/);
});
