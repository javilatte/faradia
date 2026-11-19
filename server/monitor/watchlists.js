'use strict';

const fs = require('fs');
const path = require('path');
const { configDir } = require('../store/globalPaths');

// Plane 2: per repo, file patterns watched even if git ignores them (secrets, generated
// configuration, builds). Stored outside the repos, in ~/.config/faradia/watchlists.json, keyed by
// the repo's real path.

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
    if (p.length > 200 || p.includes('..') || p.includes('\0')) throw new Error(`patrón no válido: ${p}`);
  }
  const all = loadAll();
  all[repoPath] = clean;
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(all, null, 2) + '\n');
  return clean;
}

module.exports = { DEFAULT_PATTERNS, getWatchlist, setWatchlist };
