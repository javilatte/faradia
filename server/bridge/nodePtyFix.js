'use strict';

const fs = require('fs');
const path = require('path');

// node-pty 1.1.0 ships its macOS prebuilds with `spawn-helper` lacking the
// executable bit, so every pty spawn on macOS fails with "posix_spawnp failed".
// On Linux node-pty is compiled at install time and the helper is fine. Before
// the first pty spawn on macOS, the helper is made executable; if that is not
// possible (e.g. a root-owned global install), the error says how to fix it.

let checked = false;

function spawnHelpers(ptyDir) {
  const candidates = [
    path.join(ptyDir, 'prebuilds', `darwin-${process.arch}`, 'spawn-helper'),
    path.join(ptyDir, 'build', 'Release', 'spawn-helper')
  ];
  return candidates.filter((file) => fs.existsSync(file));
}

/** Makes node-pty's spawn-helper executable on macOS. Returns the files it fixed. */
function ensureSpawnHelperExecutable({ platform = process.platform, ptyDir } = {}) {
  if (platform !== 'darwin' || checked) return [];
  checked = true;
  const dir = ptyDir || path.dirname(require.resolve('node-pty/package.json'));
  const fixed = [];
  for (const file of spawnHelpers(dir)) {
    const mode = fs.statSync(file).mode;
    if (mode & 0o111) continue;
    try {
      fs.chmodSync(file, mode | 0o755);
      fixed.push(file);
    } catch (err) {
      throw new Error(
        `node-pty's ${file} is not executable and optimia could not fix it (${err.code}). ` + `Run: chmod +x "${file}"`
      );
    }
  }
  return fixed;
}

// For tests: run the check again.
function resetSpawnHelperCheck() {
  checked = false;
}

module.exports = { ensureSpawnHelperExecutable, resetSpawnHelperCheck };
