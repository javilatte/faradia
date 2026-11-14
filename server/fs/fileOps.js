'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataDir } = require('../store/globalPaths');
const { FsError, resolveRepoPath } = require('./explorer');

// Operaciones de ficheros que pide el usuario (nunca el monitor): renombrar, copiar,
// mover y borrar. Ninguna sobrescribe nada y todas se pueden deshacer:
//   - borrar mueve a la papelera de optimia (~/.local/share/optimia/trash), con
//     manifiesto para restaurar; nada se elimina de verdad hasta vaciarla;
//   - cada operacion devuelve la operacion inversa (`undo`) para el boton Deshacer.

function trashDir() {
  return path.join(dataDir(), 'trash');
}

function manifestPath() {
  return path.join(trashDir(), 'manifest.json');
}

function loadManifest() {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(), 'utf8'));
  } catch {
    return [];
  }
}

function saveManifest(items) {
  fs.mkdirSync(trashDir(), { recursive: true });
  const tmp = `${manifestPath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2) + '\n');
  fs.renameSync(tmp, manifestPath());
}

// rename que funciona entre discos distintos (el repo y la papelera pueden no estar
// en el mismo sistema de ficheros): si falla con EXDEV, copia y borra.
function moveAcross(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.cpSync(from, to, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

function sizeOf(abs) {
  const stat = fs.statSync(abs);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const e of fs.readdirSync(abs)) total += sizeOf(path.join(abs, e));
  return total;
}

function assertFree(abs, rel) {
  if (fs.existsSync(abs)) throw new FsError(409, `ya existe ${rel}`);
}

function validName(name) {
  if (typeof name !== 'string' || !name.trim() || /[/\\\0]/.test(name) || name === '.' || name === '..') {
    throw new FsError(400, 'nombre no valido');
  }
  return name.trim();
}

function rename(root, rel, newName) {
  const src = resolveRepoPath(root, rel, { allowRoot: false });
  const name = validName(newName);
  const destRel = path.posix.join(path.posix.dirname(src.rel), name).replace(/^\.\//, '');
  const dest = resolveRepoPath(root, destRel, { mustExist: false, allowRoot: false });
  assertFree(dest.abs, dest.rel);
  fs.renameSync(src.abs, dest.abs);
  return { path: dest.rel, undo: { op: 'move', from: dest.rel, to: src.rel } };
}

/** Mueve `rel` dentro de la carpeta `destDir` (relativa; "" = raiz). */
function move(root, rel, destDir) {
  const src = resolveRepoPath(root, rel, { allowRoot: false });
  const dir = resolveRepoPath(root, destDir || '');
  if (!fs.statSync(dir.abs).isDirectory()) throw new FsError(400, 'el destino no es una carpeta');
  const destRel = dir.rel ? `${dir.rel}/${path.basename(src.abs)}` : path.basename(src.abs);
  if (destRel === src.rel) throw new FsError(400, 'ya esta en esa carpeta');
  if (destRel.startsWith(`${src.rel}/`)) throw new FsError(400, 'no se puede mover una carpeta dentro de si misma');
  const dest = resolveRepoPath(root, destRel, { mustExist: false });
  assertFree(dest.abs, dest.rel);
  moveAcross(src.abs, dest.abs);
  return { path: dest.rel, undo: { op: 'move', from: dest.rel, to: src.rel } };
}

/** Copia `rel` dentro de `destDir`; si el nombre existe, anade " (copia)", " (copia 2)"... */
function copy(root, rel, destDir) {
  const src = resolveRepoPath(root, rel, { allowRoot: false });
  const dir = resolveRepoPath(root, destDir || '');
  if (!fs.statSync(dir.abs).isDirectory()) throw new FsError(400, 'el destino no es una carpeta');
  const ext = fs.statSync(src.abs).isDirectory() ? '' : path.extname(src.abs);
  const stem = path.basename(src.abs, ext);
  let n = 0;
  let destRel;
  do {
    const suffix = n === 0 ? '' : n === 1 ? ' (copia)' : ` (copia ${n})`;
    destRel = path.posix.join(dir.rel, `${stem}${suffix}${ext}`);
    n++;
  } while (fs.existsSync(path.join(root, destRel)));
  if (destRel.startsWith(`${src.rel}/`)) throw new FsError(400, 'no se puede copiar una carpeta dentro de si misma');
  const dest = resolveRepoPath(root, destRel, { mustExist: false });
  fs.cpSync(src.abs, dest.abs, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
  return { path: dest.rel, undo: { op: 'trash', path: dest.rel } };
}

/** Borra moviendo a la papelera de optimia. Devuelve el id del elemento en la papelera. */
function trash(root, rel, { projectId } = {}) {
  const src = resolveRepoPath(root, rel, { allowRoot: false });
  const id = crypto.randomUUID();
  const stored = path.join(trashDir(), id, path.basename(src.abs));
  const item = {
    id,
    projectId: projectId || null,
    repoRoot: path.resolve(root),
    path: src.rel,
    name: path.basename(src.abs),
    dir: fs.statSync(src.abs).isDirectory(),
    size: sizeOf(src.abs),
    deletedAt: new Date().toISOString()
  };
  moveAcross(src.abs, stored);
  saveManifest([...loadManifest(), item]);
  return { trashId: id, undo: { op: 'restore', trashId: id } };
}

function listTrash({ repoRoot } = {}) {
  return loadManifest()
    .filter((i) => !repoRoot || i.repoRoot === path.resolve(repoRoot))
    .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

/** Devuelve un elemento a su sitio; si alli ya hay algo, lo deja al lado con " (restaurado)". */
function restore(trashId) {
  const items = loadManifest();
  const item = items.find((i) => i.id === trashId);
  if (!item) throw new FsError(404, 'no esta en la papelera');
  const stored = path.join(trashDir(), item.id, item.name);
  let rel = item.path;
  const ext = item.dir ? '' : path.extname(rel);
  let n = 1;
  while (fs.existsSync(path.join(item.repoRoot, rel))) {
    const base = item.path.slice(0, item.path.length - ext.length);
    rel = `${base} (restaurado${n > 1 ? ` ${n}` : ''})${ext}`;
    n++;
  }
  const dest = resolveRepoPath(item.repoRoot, rel, { mustExist: false, allowRoot: false });
  moveAcross(stored, dest.abs);
  fs.rmSync(path.join(trashDir(), item.id), { recursive: true, force: true });
  saveManifest(items.filter((i) => i.id !== trashId));
  return { path: dest.rel, repoRoot: item.repoRoot, undo: { op: 'trash', path: dest.rel } };
}

/** Elimina de verdad elementos de la papelera (todos, o los de un repo). */
function purge({ ids, repoRoot } = {}) {
  const items = loadManifest();
  const gone = items.filter((i) => (ids ? ids.includes(i.id) : !repoRoot || i.repoRoot === path.resolve(repoRoot)));
  for (const i of gone) fs.rmSync(path.join(trashDir(), i.id), { recursive: true, force: true });
  saveManifest(items.filter((i) => !gone.includes(i)));
  return gone.length;
}

/** Aplica la operacion inversa que devolvio una operacion anterior. */
function undo(root, descriptor, { projectId } = {}) {
  if (!descriptor || typeof descriptor !== 'object') throw new FsError(400, 'nada que deshacer');
  if (descriptor.op === 'move') {
    const src = resolveRepoPath(root, descriptor.from, { allowRoot: false });
    const dest = resolveRepoPath(root, descriptor.to, { mustExist: false, allowRoot: false });
    assertFree(dest.abs, dest.rel);
    moveAcross(src.abs, dest.abs);
    return { path: dest.rel };
  }
  if (descriptor.op === 'trash') return trash(root, descriptor.path, { projectId });
  if (descriptor.op === 'restore') return restore(descriptor.trashId);
  throw new FsError(400, 'operacion de deshacer desconocida');
}

module.exports = { trashDir, rename, move, copy, trash, listTrash, restore, purge, undo, moveAcross };
