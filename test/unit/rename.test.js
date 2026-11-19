'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { mkTmpDir, rmTmpDir } = require('./helpers');
const { adoptLegacyEnv, migrateGlobal, migrateRepo } = require('../../server/migrate/rename');

test('OPTIMIA_* variables are read as FARADIA_*, without overriding the new ones', () => {
  const env = { OPTIMIA_PORT: '4000', OPTIMIA_NO_OPEN: '1', FARADIA_NO_OPEN: '0', PATH: '/bin' };
  adoptLegacyEnv(env);
  assert.equal(env.FARADIA_PORT, '4000');
  assert.equal(env.FARADIA_NO_OPEN, '0');
});

test('the global optimia folders move to Faradia, never over an existing one', (t) => {
  const home = mkTmpDir('rename-home');
  t.after(() => rmTmpDir(home));
  const env = { XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data') };
  fs.mkdirSync(path.join(env.XDG_CONFIG_HOME, 'optimia', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(env.XDG_CONFIG_HOME, 'optimia', 'settings.json'), '{"ui":{}}');
  fs.mkdirSync(path.join(env.XDG_DATA_HOME, 'optimia'), { recursive: true });
  fs.mkdirSync(path.join(env.XDG_DATA_HOME, 'faradia'), { recursive: true });
  const moved = migrateGlobal(env);
  assert.deepEqual(moved, [[path.join(env.XDG_CONFIG_HOME, 'optimia'), path.join(env.XDG_CONFIG_HOME, 'faradia')]]);
  assert.ok(fs.existsSync(path.join(env.XDG_CONFIG_HOME, 'faradia', 'settings.json')));
  assert.ok(fs.existsSync(path.join(env.XDG_DATA_HOME, 'optimia')), 'left alone: Faradia already existed');
  assert.deepEqual(migrateGlobal(env), [], 'once');
});

test("a repo's .optimia becomes .faradia, and its task worktrees keep working with git", (t) => {
  const home = mkTmpDir('rename-repo-home');
  const repo = mkTmpDir('rename-repo');
  t.after(() => {
    rmTmpDir(repo);
    rmTmpDir(home);
  });
  const env = { XDG_DATA_HOME: path.join(home, 'data') };
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  fs.mkdirSync(path.join(repo, '.optimia', '.codegraph'), { recursive: true });
  fs.symlinkSync(path.join(repo, '.optimia', '.codegraph'), path.join(repo, '.codegraph'));
  const oldWt = path.join(repo, '.optimia', 'worktrees', 'task-1');
  git('worktree', 'add', '-q', '-b', 'optimia/task-1', oldWt);
  fs.writeFileSync(
    path.join(repo, '.optimia', 'tasks.json'),
    JSON.stringify([{ id: 'task-1', worktreePath: oldWt }], null, 2)
  );

  assert.equal(migrateRepo(repo, env), true);
  const newWt = path.join(repo, '.faradia', 'worktrees', 'task-1');
  assert.ok(!fs.existsSync(path.join(repo, '.optimia')));
  const tasks = JSON.parse(fs.readFileSync(path.join(repo, '.faradia', 'tasks.json'), 'utf8'));
  assert.equal(tasks[0].worktreePath, newWt);
  // git knows the worktree's new place: it works from there and is listed there.
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: newWt, encoding: 'utf8' }), '');
  assert.match(git('worktree', 'list'), new RegExp(newWt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(fs.readlinkSync(path.join(repo, '.codegraph')), path.join(repo, '.faradia', '.codegraph'));
  assert.equal(migrateRepo(repo, env), false, 'once');
});

test('when .faradia already exists, the old folder merges into it without overwriting anything', (t) => {
  const repo = mkTmpDir('rename-merge');
  t.after(() => rmTmpDir(repo));
  fs.mkdirSync(path.join(repo, '.optimia', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.optimia', 'tasks.json'), '[{"id":"old"}]');
  fs.writeFileSync(path.join(repo, '.optimia', 'logs', 'optimia.log'), 'old log');
  fs.mkdirSync(path.join(repo, '.faradia', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.faradia', 'logs', 'optimia.log'), 'new log');
  assert.equal(migrateRepo(repo, {}), true);
  assert.equal(fs.readFileSync(path.join(repo, '.faradia', 'tasks.json'), 'utf8'), '[{"id":"old"}]');
  assert.equal(fs.readFileSync(path.join(repo, '.faradia', 'logs', 'optimia.log'), 'utf8'), 'new log');
  // Only what would have overwritten something is left behind.
  assert.equal(fs.readFileSync(path.join(repo, '.optimia', 'logs', 'optimia.log'), 'utf8'), 'old log');
});
