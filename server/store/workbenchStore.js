'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { configDir } = require('./globalPaths');

// A workbench is a named set of repos looked at together ("Work", "Client X"...). A repo can be in
// several. Stored in ~/.config/optimia/workbenches.json, outside any repo.

const DEFAULT_NAME = 'Por defecto';
// Folders never walked when looking for repos: heavy or generated.
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.optimia',
  '.cache',
  '.npm',
  '.cargo',
  '.rustup',
  'target',
  'dist',
  'build',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  'Library',
  'AppData'
]);

function storePath() {
  return path.join(configDir(), 'workbenches.json');
}

function emptyStore() {
  return { version: 1, activeWorkbenchId: null, workbenches: [] };
}

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    if (!Array.isArray(data.workbenches)) return emptyStore();
    return { ...emptyStore(), ...data };
  } catch {
    return emptyStore();
  }
}

function save(store) {
  fs.mkdirSync(configDir(), { recursive: true });
  const tmp = `${storePath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n');
  fs.renameSync(tmp, storePath());
}

function normalizeRepo(p) {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

function findWorkbench(store, id) {
  const wb = store.workbenches.find((w) => w.id === id);
  if (!wb) throw new Error('workbench no encontrado');
  return wb;
}

function cleanName(name) {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n) throw new Error('el nombre no puede estar vacío');
  if (n.length > 60) throw new Error('el nombre es demasiado largo (maximo 60 caracteres)');
  return n;
}

function listWorkbenches() {
  return load();
}

function createWorkbench(name) {
  const store = load();
  const wb = { id: crypto.randomUUID(), name: cleanName(name), repos: [], createdAt: new Date().toISOString() };
  store.workbenches.push(wb);
  if (!store.activeWorkbenchId) store.activeWorkbenchId = wb.id;
  save(store);
  return wb;
}

function renameWorkbench(id, name) {
  const store = load();
  const wb = findWorkbench(store, id);
  wb.name = cleanName(name);
  save(store);
  return wb;
}

function deleteWorkbench(id) {
  const store = load();
  findWorkbench(store, id);
  if (store.workbenches.length === 1) throw new Error('no se puede borrar el único workbench');
  store.workbenches = store.workbenches.filter((w) => w.id !== id);
  if (store.activeWorkbenchId === id) store.activeWorkbenchId = store.workbenches[0].id;
  save(store);
  return store;
}

function setActiveWorkbench(id) {
  const store = load();
  findWorkbench(store, id);
  store.activeWorkbenchId = id;
  save(store);
  return store;
}

// Root of the git repo that contains `dir` (a subfolder picked by mistake counts as its repo), or
// null if it is not inside one.
function gitRoot(dir) {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
    return normalizeRepo(top.trim());
  } catch {
    return null;
  }
}

function addRepos(id, paths) {
  const store = load();
  const wb = findWorkbench(store, id);
  const added = [];
  for (const p of paths) {
    const dir = normalizeRepo(String(p).replace(/^~(?=$|\/)/, process.env.HOME || ''));
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`no existe la carpeta ${dir}`);
    // Tasks need git (worktrees, branches, commits): a folder outside a repo is not accepted.
    const repo = gitRoot(dir);
    if (!repo) {
      throw new Error(
        `${dir} no es un repositorio git. Si contiene varios repos, usa «Buscar repos en una carpeta»; si es un proyecto nuevo, ejecuta git init en él.`
      );
    }
    if (!wb.repos.includes(repo)) {
      wb.repos.push(repo);
      added.push(repo);
    }
  }
  save(store);
  return { workbench: wb, added };
}

function removeRepo(id, repoPath) {
  const store = load();
  const wb = findWorkbench(store, id);
  const repo = normalizeRepo(repoPath);
  wb.repos = wb.repos.filter((r) => r !== repo);
  save(store);
  return wb;
}

// The project optimia is launched from is always in some workbench: if it is in none, it goes into
// "Por defecto" (created if needed).
function ensureLaunchRepo(root) {
  const store = load();
  const repo = normalizeRepo(root);
  if (store.workbenches.some((w) => w.repos.includes(repo))) {
    if (!store.activeWorkbenchId) store.activeWorkbenchId = store.workbenches[0].id;
    save(store);
    return store;
  }
  let wb = store.workbenches.find((w) => w.name === DEFAULT_NAME);
  if (!wb) {
    wb = { id: crypto.randomUUID(), name: DEFAULT_NAME, repos: [], createdAt: new Date().toISOString() };
    store.workbenches.push(wb);
  }
  wb.repos.push(repo);
  if (!store.activeWorkbenchId) store.activeWorkbenchId = wb.id;
  save(store);
  return store;
}

/**
 * Looks for git repos under `root` down to `maxDepth` levels. Does not go inside a repo it found
 * (its submodules and worktrees are not separate repos here) nor into heavy or hidden folders.
 * Stops at `limit` results.
 */
function scanForRepos(root, { maxDepth = 4, limit = 500 } = {}) {
  const start = normalizeRepo(root);
  if (!fs.existsSync(start) || !fs.statSync(start).isDirectory()) throw new Error(`no existe la carpeta ${start}`);
  const found = [];
  const walk = (dir, depth) => {
    if (found.length >= limit) return;
    if (fs.existsSync(path.join(dir, '.git'))) {
      found.push(dir);
      return;
    }
    if (depth >= maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // no permission
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      if (SKIP_DIRS.has(e.name) || (e.name.startsWith('.') && depth > 0)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(start, 0);
  return found.sort();
}

module.exports = {
  DEFAULT_NAME,
  storePath,
  listWorkbenches,
  createWorkbench,
  renameWorkbench,
  deleteWorkbench,
  setActiveWorkbench,
  addRepos,
  removeRepo,
  ensureLaunchRepo,
  scanForRepos
};
