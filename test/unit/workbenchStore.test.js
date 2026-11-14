'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mkTmpDir, rmTmpDir } = require('./helpers');

// Cada test usa su propio XDG_CONFIG_HOME: nunca se toca el ~/.config real.
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
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return fs.realpathSync(dir);
}

test('ensureLaunchRepo: crea "Por defecto" con el repo y lo deja activo', (t) => {
  const wb = freshStore(t);
  const repo = mkTmpDir('wb-launch');
  t.after(() => rmTmpDir(repo));
  const store = wb.ensureLaunchRepo(repo);
  assert.equal(store.workbenches.length, 1);
  assert.equal(store.workbenches[0].name, wb.DEFAULT_NAME);
  assert.deepEqual(store.workbenches[0].repos, [fs.realpathSync(repo)]);
  assert.equal(store.activeWorkbenchId, store.workbenches[0].id);
  // Lanzar otra vez desde el mismo repo no lo duplica
  assert.equal(wb.ensureLaunchRepo(repo).workbenches[0].repos.length, 1);
});

test('crear, renombrar, activar y borrar workbenches', (t) => {
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
  assert.throws(() => wb.deleteWorkbench(a.id), /unico workbench/);
  assert.throws(() => wb.createWorkbench('   '), /vacio/);
  assert.throws(() => wb.renameWorkbench('nope', 'x'), /no encontrado/);
});

test('addRepos/removeRepo: sin duplicados, y un repo puede estar en varios workbenches', (t) => {
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

test('scanForRepos: encuentra repos, no entra en ellos ni en carpetas pesadas, respeta la profundidad', (t) => {
  const wb = freshStore(t);
  const root = mkTmpDir('wb-scan');
  t.after(() => rmTmpDir(root));
  const a = makeRepo(root, 'a');
  const b = makeRepo(root, 'grupo/b');
  makeRepo(root, 'a/dentro'); // dentro de otro repo: no cuenta
  makeRepo(root, 'node_modules/paquete'); // carpeta pesada: no se recorre
  makeRepo(root, 'x/y/z/w/muy-hondo'); // mas alla de maxDepth=3
  assert.deepEqual(wb.scanForRepos(root, { maxDepth: 3 }), [a, b].sort());
  assert.throws(() => wb.scanForRepos(path.join(root, 'nada')), /no existe/);
});
