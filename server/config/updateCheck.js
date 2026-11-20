'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { configDir } = require('../store/globalPaths');
const pkg = require('../../package.json');

// Is there a newer Faradia? Asks the public npm registry (where Faradia is
// installed from) at most once a day and caches the answer in
// ~/.config/faradia/update-check.json. The request carries nothing about the user.
// Disabled from Settings (updates.check) or with FARADIA_NO_UPDATE_CHECK=1.

const REGISTRY_URL = `https://registry.npmjs.org/${pkg.name.replace('/', '%2f')}/latest`;
const RELEASES_URL = 'https://github.com/javilatte/faradia/releases';
const DAY = 24 * 60 * 60 * 1000;

function cacheFile() {
  return path.join(configDir(), 'update-check.json');
}

/** -1, 0 or 1 comparing semver versions (x.y.z; a -prerelease sorts before the release). */
function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre = ''] = String(v || '0.0.0')
      .replace(/^v/, '')
      .split('-', 2);
    return { nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre > y.pre ? 1 : -1;
}

function fetchLatest(url = REGISTRY_URL, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { accept: 'application/json', 'user-agent': 'faradia' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`el registro respondió ${res.statusCode}`));
        return;
      }
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        raw += c;
        if (raw.length > 1_000_000) req.destroy(new Error('respuesta demasiado grande'));
      });
      res.on('end', () => {
        try {
          const version = JSON.parse(raw).version;
          if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) throw new Error('versión no válida');
          resolve(version);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('sin respuesta del registro')));
    req.on('error', reject);
  });
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
  } catch {
    return null;
  }
}

function view(latest, checkedAt, error) {
  const updateAvailable = Boolean(latest) && compareVersions(latest, pkg.version) > 0;
  return {
    current: pkg.version,
    latest: latest || null,
    updateAvailable,
    checkedAt: checkedAt || null,
    error: error || null,
    installCommand: `npm install -g ${pkg.name}@latest`,
    releaseUrl: updateAvailable ? `${RELEASES_URL}/tag/v${latest}` : RELEASES_URL
  };
}

/**
 * Update status. Uses the cached answer if it is less than a day old (`force`
 * asks right away). `enabled: false` makes no request at all.
 */
async function checkForUpdate({ enabled = true, force = false, fetcher = fetchLatest, now = Date.now() } = {}) {
  if (!enabled || process.env.FARADIA_NO_UPDATE_CHECK === '1') return { ...view(null, null, null), disabled: true };
  const cache = readCache();
  if (!force && cache?.checkedAt && now - Date.parse(cache.checkedAt) < DAY) {
    return view(cache.latest, cache.checkedAt, cache.error);
  }
  const checkedAt = new Date(now).toISOString();
  try {
    const latest = await fetcher();
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(cacheFile(), JSON.stringify({ latest, checkedAt }, null, 2) + '\n');
    return view(latest, checkedAt);
  } catch (err) {
    // Offline or the registry failed: keep the last good answer.
    return view(cache?.latest || null, cache?.checkedAt || null, err.message);
  }
}

module.exports = { compareVersions, checkForUpdate, fetchLatest, REGISTRY_URL };
