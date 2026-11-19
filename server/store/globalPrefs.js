'use strict';

const fs = require('fs');
const path = require('path');
const { configDir } = require('./globalPaths');

// Global supervision preferences (not tied to a project):
// ~/.config/faradia/preferences.json

const DEFAULTS = {
  // Uncommitted changes untouched for this long = orphaned changes.
  orphanMinutes: 30,
  signals: {
    largeDeleteLines: 200, // deleting more lines than this in one batch is a large delete
    largeDeleteFiles: 5, // or deleting more files than this
    sensitive: true,
    secrets: true,
    tests: true,
    notify: { largeDelete: true, sensitive: true, secrets: true, tests: false, orphan: true }
  }
};

function file() {
  return path.join(configDir(), 'preferences.json');
}

function mergeDeep(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (!(k in base)) continue; // known keys only
    out[k] = base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) ? mergeDeep(base[k], v) : v;
  }
  return out;
}

function sanitize(prefs) {
  const p = mergeDeep(DEFAULTS, prefs);
  const num = (v, min, max, def) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : def);
  p.orphanMinutes = num(p.orphanMinutes, 1, 24 * 60, DEFAULTS.orphanMinutes);
  p.signals.largeDeleteLines = num(p.signals.largeDeleteLines, 1, 100000, DEFAULTS.signals.largeDeleteLines);
  p.signals.largeDeleteFiles = num(p.signals.largeDeleteFiles, 1, 10000, DEFAULTS.signals.largeDeleteFiles);
  for (const k of ['sensitive', 'secrets', 'tests']) p.signals[k] = p.signals[k] !== false;
  for (const k of Object.keys(DEFAULTS.signals.notify)) p.signals.notify[k] = p.signals.notify[k] === true;
  return p;
}

function loadPrefs() {
  try {
    return sanitize(JSON.parse(fs.readFileSync(file(), 'utf8')));
  } catch {
    return sanitize({});
  }
}

function savePrefs(patch) {
  const next = sanitize(mergeDeep(loadPrefs(), patch));
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(next, null, 2) + '\n');
  return next;
}

module.exports = { DEFAULTS, loadPrefs, savePrefs, sanitize };
