'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const issues = require('../../server/feedback/issues');
const { createLogger } = require('../../server/bridge/logger');
const { mkTmpDir, rmTmpDir } = require('./helpers');

test('secrets and home paths never reach the report', () => {
  const home = process.env.HOME;
  const text = issues.redact(
    `key AIza${'x'.repeat(35)} token=supersecret123 ${home}/repo Bearer abcdefghijklmnopqrstu https://u:pw@host/x`
  );
  assert.doesNotMatch(text, /AIza|supersecret|abcdefghijklmnop|:pw@/);
  assert.match(text, /~\/repo/);
});

test('warnings and errors of any repo are grouped by kind; free text is left out', (t) => {
  const repo = mkTmpDir('issues-repo');
  t.after(() => {
    issues.clearIssues();
    rmTmpDir(repo);
  });
  issues.clearIssues();
  const log = createLogger(repo);
  const stderr = process.stderr.write;
  process.stderr.write = () => true;
  try {
    log.warn('task.stage.denied', { taskId: 'a1b2c3d4', tool: 'Bash', command: 'rm -rf dist', text: 'private words' });
    log.warn('task.stage.denied', { taskId: 'ffff0000', tool: 'Bash', command: 'rm -rf build', text: 'more' });
    log.error('task.worktree_error', { error: 'no se pudo crear el worktree: fatal 128' });
    log.info('chat.user', { text: 'hello' });
  } finally {
    process.stderr.write = stderr;
  }
  issues.recordIssue({ level: 'signal', event: 'suggest.accepted', data: { kind: 'skill', id: 'unslop' } });
  const s = issues.summary();
  assert.equal(s.total, 3);
  assert.equal(s.groups[0].event, 'task.stage.denied');
  assert.equal(s.groups[0].count, 2);
  assert.equal(s.groups[0].sample.text, undefined);
  assert.equal(s.signals['suggest.accepted:skill'], 1);
  const exported = issues.exportReport();
  assert.equal(exported.format, 'faradia-issues');
  assert.equal(exported.entries.length, 4);
});
