'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mkTmpDir, rmTmpDir } = require('./helpers');
const { SignalEngine, scanText, sensitiveRule, TEST_FILES } = require('../../server/monitor/signals');
const { Metrics } = require('../../server/monitor/metrics');

function prefsDir(t) {
  const cfg = mkTmpDir('sig-cfg');
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = cfg;
  t.after(() => {
    process.env.XDG_CONFIG_HOME = prev;
    rmTmpDir(cfg);
  });
}

// Fake secrets built in pieces: this file never contains one literally (so the repo's own secret
// scanner does not fire).
const fake = {
  aws: 'AKIA' + 'ABCDEFGHIJKLMNOP',
  github: 'ghp_' + 'a'.repeat(36),
  anthropic: 'sk-ant-' + 'b'.repeat(30),
  pem: '-----BEGIN RSA ' + 'PRIVATE KEY-----'
};

test('scanText: finds known secrets with their line and never returns the value', () => {
  const text = [
    'const a = 1;',
    `const key = "${fake.aws}";`,
    `token: ${fake.github}`,
    fake.pem,
    `x = '${fake.anthropic}'`
  ].join('\n');
  const found = scanText(text);
  assert.deepEqual(
    found.map((f) => [f.rule, f.line]),
    [
      ['aws-access-key', 2],
      ['github-token', 3],
      ['private-key', 4],
      ['anthropic-key', 5]
    ]
  );
  assert.ok(!JSON.stringify(found).includes(fake.aws));
  assert.equal(scanText('const password = "corta";').length, 0); // fewer than 12 characters
  assert.equal(scanText('const apiKey = "abcdefghijklmnop";')[0].rule, 'generic-secret');
});

test('sensitiveRule and TEST_FILES', () => {
  assert.equal(sensitiveRule('.env').severity, 'high');
  assert.equal(sensitiveRule('apps/api/.env.production').severity, 'high');
  assert.equal(sensitiveRule('.github/workflows/ci.yml').severity, 'medium');
  assert.equal(sensitiveRule('src/index.js'), null);
  assert.ok(TEST_FILES('src/a.test.js'));
  assert.ok(TEST_FILES('test/unit/x.js'));
  assert.ok(!TEST_FILES('src/testing.js'));
});

test('onActivity: sensitive files, tests, and secrets only in files git would commit', async (t) => {
  prefsDir(t);
  const root = mkTmpDir('sig-root');
  t.after(() => rmTmpDir(root));
  fs.writeFileSync(path.join(root, 'config.js'), `module.exports = { key: "${fake.aws}" };\n`);
  fs.writeFileSync(path.join(root, '.env'), `AWS=${fake.aws}\n`);
  const engine = new SignalEngine();
  const got = [];
  engine.on('signal', (s) => got.push(s));
  await engine.onActivity({
    projectId: 'p',
    name: 'r',
    taskId: 'task-1',
    paths: ['.env', 'config.js', 'test/a.test.js'],
    root,
    committable: async (rel) => rel !== '.env' // .env is ignored by git
  });
  const rules = got.map((s) => `${s.rule}:${s.path}`).sort();
  assert.deepEqual(rules, ['secret:config.js', 'sensitive:.env', 'tests:test/a.test.js']);
  const secret = got.find((s) => s.rule === 'secret');
  assert.equal(secret.line, 1);
  assert.match(secret.message, /config\.js:1/);
  assert.ok(!JSON.stringify(got).includes(fake.aws));
  const sensitive = got.find((s) => s.rule === 'sensitive');
  assert.match(sensitive.message, /agente/);
  assert.equal(sensitive.exposed, false); // .env is ignored

  // A .env that git does NOT ignore is flagged as exposed
  await engine.onActivity({ projectId: 'q', name: 'r', paths: ['.env'], root, committable: async () => true });
  const exposed = got.find((s) => s.projectId === 'q' && s.rule === 'sensitive');
  assert.equal(exposed.exposed, true);
  assert.match(exposed.message, /git NO lo ignora/);

  // The same signal is not repeated right away
  await engine.onActivity({ projectId: 'p', name: 'r', paths: ['.env'], root, committable: async () => false });
  assert.equal(got.filter((s) => s.rule === 'sensitive' && s.projectId === 'p').length, 1);
});

test('onState: large delete compared with the previous state', (t) => {
  prefsDir(t);
  const engine = new SignalEngine();
  const got = [];
  engine.on('signal', (s) => got.push(s));
  const st = (removed, deleted) => ({
    lines: { added: 0, removed },
    counts: { deleted },
    at: new Date().toISOString()
  });
  engine.onState({ projectId: 'p', name: 'r', previous: st(10, 0), state: st(50, 1) });
  assert.equal(got.length, 0);
  engine.onState({ projectId: 'p', name: 'r', previous: st(10, 0), state: st(400, 0) });
  assert.equal(got[0].rule, 'largeDelete');
  assert.match(got[0].message, /390 líneas/);
  engine.onState({ projectId: 'q', name: 'r', previous: st(0, 0), state: st(0, 30) });
  assert.equal(got[1].severity, 'high');
});

test('preferences: a disabled rule does not signal', async (t) => {
  prefsDir(t);
  const { savePrefs } = require('../../server/store/globalPrefs');
  savePrefs({ signals: { sensitive: false } });
  const engine = new SignalEngine();
  const got = [];
  engine.on('signal', (s) => got.push(s));
  await engine.onActivity({ projectId: 'p', name: 'r', paths: ['.env'] });
  assert.equal(got.length, 0);
});

test('Metrics: hourly frequency and agent sessions', (t) => {
  const repoDir = mkTmpDir('met');
  t.after(() => rmTmpDir(repoDir));
  fs.mkdirSync(path.join(repoDir, '.faradia'));
  fs.writeFileSync(
    path.join(repoDir, '.faradia', 'tasks.json'),
    JSON.stringify([
      {
        id: 't',
        title: 'x',
        stageRuns: [
          {
            stage: 'implement',
            agentName: 'Implementador',
            finishedAt: new Date().toISOString(),
            filesTouched: 4,
            costUsd: 0.12
          }
        ]
      }
    ])
  );
  const m = new Metrics();
  const now = Date.now();
  m.recordActivity({ projectId: 'p', paths: ['a', 'b'], at: new Date(now).toISOString() });
  m.recordActivity({ projectId: 'p', paths: ['c'], at: new Date(now - 2 * 3600 * 1000).toISOString() });
  const r = m.forRepo({ projectId: 'p', name: 'r', path: repoDir, state: { lines: { added: 3, removed: 1 } } }, now);
  assert.equal(r.changesLastHour, 2);
  assert.equal(r.changesToday, 3);
  assert.equal(r.hourly.length, 24);
  assert.equal(r.hourly[21], 1);
  assert.equal(r.agentFilesTouched, 4);
  assert.equal(r.agentSessions[0].agentName, 'Implementador');
});
