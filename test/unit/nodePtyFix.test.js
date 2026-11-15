'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mkTmpDir, rmTmpDir } = require('./helpers');
const { ensureSpawnHelperExecutable, resetSpawnHelperCheck } = require('../../server/bridge/nodePtyFix');

function fakePty(t) {
  const dir = mkTmpDir('node-pty');
  t.after(() => rmTmpDir(dir));
  const helper = path.join(dir, 'prebuilds', `darwin-${process.arch}`, 'spawn-helper');
  fs.mkdirSync(path.dirname(helper), { recursive: true });
  fs.writeFileSync(helper, '');
  fs.chmodSync(helper, 0o644);
  return { dir, helper };
}

test('macOS: a non-executable spawn-helper becomes executable, once', (t) => {
  const { dir, helper } = fakePty(t);
  resetSpawnHelperCheck();
  assert.deepEqual(ensureSpawnHelperExecutable({ platform: 'darwin', ptyDir: dir }), [helper]);
  assert.ok(fs.statSync(helper).mode & 0o100);
  fs.chmodSync(helper, 0o644);
  assert.deepEqual(ensureSpawnHelperExecutable({ platform: 'darwin', ptyDir: dir }), [], 'checked only once');
});

test('other platforms: nothing is touched', (t) => {
  const { dir, helper } = fakePty(t);
  resetSpawnHelperCheck();
  assert.deepEqual(ensureSpawnHelperExecutable({ platform: 'linux', ptyDir: dir }), []);
  assert.equal(fs.statSync(helper).mode & 0o111, 0);
});
