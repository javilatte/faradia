'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mkTmpDir, rmTmpDir } = require('./helpers');
const logger = require('../../server/bridge/logger');

test('logger: writes one JSON event per line to .faradia/logs/faradia.log', (t) => {
  const dir = mkTmpDir('logger-lines');
  t.after(() => rmTmpDir(dir));
  logger.initLogger(dir);
  logger.info('task.stage.start', { taskId: 't1', stage: 'plan' });
  logger.warn('task.stage.denied', { taskId: 't1', tool: 'Bash' });

  const lines = fs
    .readFileSync(path.join(dir, '.faradia', 'logs', 'faradia.log'), 'utf8')
    .trim()
    .split('\n');
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.event, 'task.stage.start');
  assert.equal(first.level, 'info');
  assert.equal(first.stage, 'plan');
  assert.match(first.ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(JSON.parse(lines[1]).level, 'warn');
});

test('logger: without init it neither throws nor writes anything', () => {
  logger.initLogger(mkTmpDir('logger-noinit'));
  assert.doesNotThrow(() => logger.info('server.start', { url: 'x' }));
});

test('logger: rotates the file at 5 MB', (t) => {
  const dir = mkTmpDir('logger-rotate');
  t.after(() => rmTmpDir(dir));
  logger.initLogger(dir);
  const file = path.join(dir, '.faradia', 'logs', 'faradia.log');
  fs.writeFileSync(file, 'x'.repeat(5 * 1024 * 1024 + 10));
  logger.info('server.start', { url: 'http://127.0.0.1:1' });
  assert.ok(fs.existsSync(`${file}.1`));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8').trim()).event, 'server.start');
});

test('readRecent: returns the newest entries first, with a limit', (t) => {
  const dir = mkTmpDir('logger-recent');
  t.after(() => rmTmpDir(dir));
  logger.initLogger(dir);
  logger.info('a.first', {});
  logger.info('b.second', {});
  logger.info('c.third', {});
  const recent = logger.readRecent(2);
  assert.deepEqual(
    recent.map((e) => e.event),
    ['c.third', 'b.second']
  );
});

test('createLogger: each project writes to its own log', (t) => {
  const a = mkTmpDir('logger-a');
  const b = mkTmpDir('logger-b');
  t.after(() => {
    rmTmpDir(a);
    rmTmpDir(b);
  });
  const la = logger.createLogger(a);
  const lb = logger.createLogger(b);
  la.info('solo.a', {});
  lb.info('solo.b', {});
  assert.deepEqual(
    la.readRecent().map((e) => e.event),
    ['solo.a']
  );
  assert.deepEqual(
    lb.readRecent().map((e) => e.event),
    ['solo.b']
  );
});
