'use strict';

const fs = require('fs');
const path = require('path');
const { configDir } = require('../store/globalPaths');

// Plano 2: por repo, patrones de ficheros que se vigilan aunque git los ignore
// (secretos, configuraciones generadas, builds). Se guarda fuera de los repos, en
// ~/.config/optimia/watchlists.json, indexado por la ruta real del repo.

const DEFAULT_PATTERNS = ['.env', '.env.*', '*.pem', '*.key', '.npmrc'];

function file() {
  return path.join(configDir(), 'watchlists.json');
}

function loadAll() {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    return {};
  }
}

function getWatchlist(repoPath) {
  const all = loadAll();
  return Array.isArray(all[repoPath]) ? all[repoPath] : [...DEFAULT_PATTERNS];
}

function setWatchlist(repoPath, patterns) {
  if (!Array.isArray(patterns)) throw new Error('patterns debe ser una lista');
  const clean = [...new Set(patterns.map((p) => String(p).trim()).filter(Boolean))];
  if (clean.length > 100) throw new Error('como maximo 100 patrones');
  for (const p of clean) {
    if (p.length > 200 || p.includes('..') || p.includes('\0')) throw new Error(`patron no valido: ${p}`);
  }
  const all = loadAll();
  all[repoPath] = clean;
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(all, null, 2) + '\n');
  return clean;
}

module.exports = { DEFAULT_PATTERNS, getWatchlist, setWatchlist };
