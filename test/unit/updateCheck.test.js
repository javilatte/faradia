'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkTmpDir, rmTmpDir } = require('./helpers');
const { compareVersions, checkForUpdate } = require('../../server/config/updateCheck');
const pkg = require('../../package.json');

function isolated(t) {
  const cfg = mkTmpDir('update');
  const prev = { cfg: process.env.XDG_CONFIG_HOME, off: process.env.OPTIMIA_NO_UPDATE_CHECK };
  process.env.XDG_CONFIG_HOME = cfg;
  delete process.env.OPTIMIA_NO_UPDATE_CHECK;
  t.after(() => {
    process.env.XDG_CONFIG_HOME = prev.cfg;
    if (prev.off !== undefined) process.env.OPTIMIA_NO_UPDATE_CHECK = prev.off;
    rmTmpDir(cfg);
  });
}

test('compareVersions: semver order, prereleases before the release', () => {
  assert.equal(compareVersions('2.0.1', '2.0.0'), 1);
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
  assert.equal(compareVersions('1.9.9', '2.0.0'), -1);
  assert.equal(compareVersions('2.10.0', '2.9.0'), 1);
  assert.equal(compareVersions('2.0.0-beta.1', '2.0.0'), -1);
  assert.equal(compareVersions('v2.1.0', '2.0.9'), 1);
});

test('checkForUpdate: reports a newer version and caches it for a day', async (t) => {
  isolated(t);
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return '99.0.0';
  };
  const now = Date.parse('2026-11-15T10:00:00Z');
  const first = await checkForUpdate({ fetcher, now });
  assert.equal(first.updateAvailable, true);
  assert.equal(first.current, pkg.version);
  assert.equal(first.latest, '99.0.0');
  assert.match(first.installCommand, /npm install -g @javilatte\/optimia@latest/);
  assert.match(first.releaseUrl, /releases\/tag\/v99\.0\.0$/);

  await checkForUpdate({ fetcher, now: now + 60 * 60 * 1000 });
  assert.equal(calls, 1, 'cached within the day');
  await checkForUpdate({ fetcher, now: now + 25 * 60 * 60 * 1000 });
  assert.equal(calls, 2, 'asked again the next day');
  await checkForUpdate({ fetcher, now: now + 25 * 60 * 60 * 1000, force: true });
  assert.equal(calls, 3, 'force asks right away');
});

test('checkForUpdate: no request when disabled, last good answer when offline', async (t) => {
  isolated(t);
  let calls = 0;
  const disabled = await checkForUpdate({ enabled: false, fetcher: async () => calls++ });
  assert.equal(disabled.disabled, true);
  assert.equal(calls, 0);

  await checkForUpdate({ fetcher: async () => '99.0.0', force: true });
  const offline = await checkForUpdate({
    force: true,
    fetcher: async () => {
      throw new Error('sin red');
    }
  });
  assert.equal(offline.latest, '99.0.0');
  assert.equal(offline.error, 'sin red');
  const older = await checkForUpdate({ force: true, fetcher: async () => '0.1.0' });
  assert.equal(older.updateAvailable, false);
});
