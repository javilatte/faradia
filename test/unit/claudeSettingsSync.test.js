'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { mkTmpDir, rmTmpDir } = require('./helpers');
const {
  syncClaudeSettings,
  claudeSettingsPath,
  optimiaClaudeSettingsPath,
  buildClaudeSettings,
  DEFAULT_ALLOW,
  DEFAULT_MODE
} = require('../../server/bridge/claudeSettingsSync');

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('syncClaudeSettings: writes .optimia/claude-settings.json and never touches the repo .claude/', (t) => {
  const dir = mkTmpDir('claudesync');
  t.after(() => rmTmpDir(dir));

  const noGo = ['Read(**/.env*)', 'Bash(rm -rf *)'];
  const file = syncClaudeSettings(dir, noGo);

  assert.equal(file, optimiaClaudeSettingsPath(dir));
  const onDisk = readJson(file);
  assert.deepEqual(onDisk.permissions.deny, noGo);
  assert.deepEqual(onDisk.permissions.allow, DEFAULT_ALLOW);
  assert.equal(onDisk.permissions.defaultMode, DEFAULT_MODE);
  assert.equal(onDisk.enableAllProjectMcpServers, true);
  assert.equal(fs.existsSync(path.join(dir, '.claude')), false);
});

test('syncClaudeSettings: the deny list follows what was passed in, even if it is empty', (t) => {
  const dir = mkTmpDir('claudesync');
  t.after(() => rmTmpDir(dir));

  syncClaudeSettings(dir, ['a']);
  const file = syncClaudeSettings(dir, []);
  assert.deepEqual(readJson(file).permissions.deny, []);
});

test('syncClaudeSettings: a repo .claude/settings.json of its own is left untouched', (t) => {
  const dir = mkTmpDir('claudesync');
  t.after(() => rmTmpDir(dir));

  const own = {
    someOtherKey: 'keep-me',
    permissions: { allow: ['Read'], deny: ['Bash(curl *)'], defaultMode: 'plan' }
  };
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(claudeSettingsPath(dir), JSON.stringify(own));

  syncClaudeSettings(dir, ['new-deny']);
  assert.deepEqual(readJson(claudeSettingsPath(dir)), own);
});

test('syncClaudeSettings: removes the untracked .claude/settings.json an older optimia generated', (t) => {
  const dir = mkTmpDir('claudesync');
  t.after(() => rmTmpDir(dir));
  execFileSync('git', ['init', '-q'], { cwd: dir });

  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(claudeSettingsPath(dir), JSON.stringify(buildClaudeSettings(['Read(**/.env*)'])));

  // Su deny aun no esta en la lista de optimia: se conserva para poder importarlo.
  syncClaudeSettings(dir, []);
  assert.equal(fs.existsSync(claudeSettingsPath(dir)), true);

  syncClaudeSettings(dir, ['Read(**/.env*)']);
  assert.equal(fs.existsSync(claudeSettingsPath(dir)), false);
  assert.equal(fs.existsSync(path.join(dir, '.claude')), false);
});

test('syncClaudeSettings: a generated .claude/settings.json that git tracks is kept', (t) => {
  const dir = mkTmpDir('claudesync');
  t.after(() => rmTmpDir(dir));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');

  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(claudeSettingsPath(dir), JSON.stringify(buildClaudeSettings([])));
  git('add', '.claude/settings.json');
  git('commit', '-qm', 'claude settings');

  syncClaudeSettings(dir, []);
  assert.equal(fs.existsSync(claudeSettingsPath(dir)), true);
});
