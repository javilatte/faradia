'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { mkTmpDir, rmTmpDir } = require('./helpers');

function setup(t) {
  const data = mkTmpDir('tl-data');
  const cfg = mkTmpDir('tl-cfg');
  const prev = [process.env.XDG_DATA_HOME, process.env.XDG_CONFIG_HOME];
  process.env.XDG_DATA_HOME = data;
  process.env.XDG_CONFIG_HOME = cfg;
  const { Timeline, timelineFile } = require('../../server/monitor/timeline');
  const tl = new Timeline();
  t.after(() => {
    tl.stop();
    [process.env.XDG_DATA_HOME, process.env.XDG_CONFIG_HOME] = prev;
    rmTmpDir(data);
    rmTmpDir(cfg);
  });
  return { tl, Timeline, timelineFile };
}

const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();

test('recordFiles: agrupa lotes seguidos del mismo repo en una entrada', (t) => {
  const { tl } = setup(t);
  const a = tl.recordFiles({ projectId: 'p', name: 'r', paths: ['a.js'], at: iso() });
  const b = tl.recordFiles({ projectId: 'p', name: 'r', paths: ['b.js', 'a.js'], at: iso() });
  assert.equal(a.id, b.id);
  assert.deepEqual(b.paths, ['b.js', 'a.js']); // lo mas reciente primero
  assert.equal(b.count, 2);
  // Otro repo u otro worktree: entrada distinta
  assert.notEqual(tl.recordFiles({ projectId: 'p', taskId: 't1', name: 'r', paths: ['c.js'], at: iso() }).id, a.id);
  assert.equal(tl.query({ kinds: ['files'] }).length, 2);
});

test('recordState: detecta commits nuevos y cambios de rama', (t) => {
  const { tl } = setup(t);
  const prev = { branch: 'main', lastCommit: { sha: 'a1' }, dirty: true };
  const next = { branch: 'feat', lastCommit: { sha: 'b2', subject: 'feat: x', author: 'yo' }, dirty: false };
  tl.recordState({ projectId: 'p', name: 'r', state: next, previous: prev });
  const kinds = tl.query().map((e) => e.kind);
  assert.deepEqual(kinds.sort(), ['branch', 'commit']);
  assert.equal(tl.query({ kinds: ['commit'] })[0].subject, 'feat: x');
});

test('checkOrphans: avisa una vez de cambios sin tocar desde hace N minutos', (t) => {
  const { tl } = setup(t);
  const repo = { projectId: 'p', name: 'r', lastActivity: iso(45 * 60000), state: { dirty: true, files: [{}, {}] } };
  const found = tl.checkOrphans([repo]);
  assert.equal(found.length, 1);
  assert.equal(found[0].files, 2);
  assert.equal(tl.checkOrphans([repo]).length, 0); // no se repite
  assert.equal(tl.checkOrphans([{ ...repo, lastActivity: iso(5 * 60000) }]).length, 0);
});

test('query: filtra por repo, tipo, extension y fechas', (t) => {
  const { tl } = setup(t);
  tl.recordFiles({ projectId: 'a', name: 'a', paths: ['x.css'], at: iso() });
  tl.recordFiles({ projectId: 'b', name: 'b', paths: ['y.js'], at: iso() });
  tl.recordWatch({ projectId: 'a', name: 'a', path: '.env', kind: 'created', size: 3 });
  assert.equal(tl.query({ projectIds: ['a'] }).length, 2);
  assert.equal(tl.query({ ext: 'js' }).length, 1);
  assert.equal(tl.query({ ext: '.css,.js' }).length, 2);
  assert.equal(tl.query({ since: iso(-60000) }).length, 0);
  assert.equal(tl.query({ kinds: ['watch'] })[0].change, 'created');
});

test('persistencia: las entradas sobreviven a un reinicio', (t) => {
  const { tl, Timeline, timelineFile } = setup(t);
  tl.recordSignal({ projectId: 'p', name: 'r', rule: 'secret', severity: 'high', message: 'posible secreto' });
  tl.recordTask('p', 'r', { id: 't', title: 'x', status: 'ready_to_test' }, 'in_progress');
  assert.ok(fs.existsSync(timelineFile()));
  const again = new Timeline();
  assert.deepEqual(
    again.query().map((e) => e.kind),
    ['agent', 'signal']
  );
});
