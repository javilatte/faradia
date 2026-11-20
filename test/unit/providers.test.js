'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkTmpDir, rmTmpDir } = require('./helpers');
const fallback = require('../../server/ai/fallback');
const suggest = require('../../server/ai/suggest');
const { engineFor } = require('../../server/bridge/sessionOptions');
const { defaultSettings } = require('../../server/store/settingsStore');

test('Claude out of usage: detected from the stream, then sessions use the local model', (t) => {
  const data = mkTmpDir('fallback');
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = data;
  fallback._reset();
  t.after(() => {
    process.env.XDG_DATA_HOME = prev;
    fallback._reset();
    rmTmpDir(data);
  });
  const now = 1_800_000_000_000;
  const resets = now / 1000 + 3600;
  assert.equal(fallback.limitHit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }, now), 0);
  assert.equal(
    fallback.limitHit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: resets } }, now),
    resets * 1000
  );
  assert.ok(fallback.limitHit({ type: 'result', is_error: true, result: "You've hit your limit · resets 3pm" }, now));
  assert.equal(fallback.limitHit({ type: 'result', is_error: true, result: 'Bash failed' }, now), 0);
  assert.equal(
    fallback.limitHit({ type: 'result', is_error: true, api_error_status: 429, result: 'Rate limit exceeded' }, now),
    0,
    'a short rate limit is not running out of usage'
  );

  const settings = defaultSettings();
  assert.equal(fallback.fallbackEngine(settings), null);
  settings.ai.localAi = { url: 'http://127.0.0.1:1234', model: 'gemma', authHeader: '' };
  assert.equal(fallback.fallbackEngine(settings), 'local');

  assert.equal(engineFor(settings), 'claude');
  fallback.markClaudeBlocked(Date.now() + 60_000);
  assert.equal(engineFor(settings), 'local');
  assert.equal(engineFor(settings, { engine: 'local', model: 'm' }), 'local', 'an agent on another engine keeps it');
  fallback.clearClaudeBlock();
  assert.equal(engineFor(settings), 'claude', 'back to Claude when it is available');
});

test('suggestions keep only catalog entries and shortlist the relevant ones', () => {
  const catalog = [
    { kind: 'task', id: 'bugfix', description: 'fix a bug', core: true },
    { kind: 'skill', id: 'security-audit', description: 'Security review', core: true },
    { kind: 'agent', id: 'ecc-database-reviewer', description: 'PostgreSQL database specialist' },
    { kind: 'agent', id: 'ecc-go-reviewer', description: 'Go code review' }
  ];
  assert.deepEqual(
    suggest.parseSuggestions(
      'Here: {"suggestions":[{"kind":"skill","id":"security-audit","reason":"seguridad"},{"kind":"skill","id":"made-up"},{"kind":"skill","id":"security-audit"}]}',
      catalog
    ),
    [{ kind: 'skill', id: 'security-audit', reason: 'seguridad' }]
  );
  assert.equal(suggest.parseSuggestions('no json', catalog), null);
  const short = suggest.shortlist('la migración de la base de datos falla', catalog).map((c) => c.id);
  assert.deepEqual(short, ['bugfix', 'security-audit', 'ecc-database-reviewer']);
});

test('suggestions try the local model, then Claude, and skip short messages', async () => {
  const settings = defaultSettings();
  const catalog = [{ kind: 'task', id: 'bugfix', description: 'fix a bug', core: true }];
  const tried = [];
  const engines = [
    ['local', async () => (tried.push('local'), Promise.reject(new Error('down')))],
    ['claude', async () => (tried.push('claude'), '{"suggestions":[{"kind":"task","id":"bugfix","reason":"r"}]}')]
  ];
  const r = await suggest.suggest({
    text: 'el carrito vacío rompe el pago ahora',
    projectRoot: '/x',
    settings,
    deps: { catalog, engines }
  });
  assert.deepEqual(tried, ['local', 'claude']);
  assert.equal(r.engine, 'claude');
  assert.equal(r.suggestions[0].id, 'bugfix');
  const none = await suggest.suggest({ text: 'hola', projectRoot: '/x', settings, deps: { catalog, engines } });
  assert.deepEqual(none.suggestions, []);
  settings.suggestions.mode = 'off';
  assert.equal((await suggest.suggest({ text: 'a b c d e', projectRoot: '/x', settings })).off, true);
});

test('the local model answers suggestions only while it is fast; after a failure Claude takes over for a while', async () => {
  suggest._resetLocal();
  const settings = defaultSettings();
  settings.ai.localAi = { url: 'http://127.0.0.1:11434', model: 'qwen', authHeader: '' };
  const catalog = [{ kind: 'task', id: 'bugfix', description: 'fix a bug', core: true }];
  let localCalls = 0;
  let slow = true;
  const fetcher = async (url, init) => {
    localCalls++;
    if (slow) {
      // Behaves like a model that does not answer in time: the 3 s timeout aborts it.
      return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"suggestions":[]}' } }] }) };
  };
  const claude = [];
  const spawnFn = () => {
    const { EventEmitter } = require('events');
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.kill = () => {};
    proc.stdin = {
      on: () => {},
      end: () => {
        claude.push(1);
        setImmediate(() => {
          proc.stdout.emit('data', JSON.stringify({ result: '{"suggestions":[{"kind":"task","id":"bugfix"}]}' }));
          proc.emit('exit', 0);
        });
      }
    };
    return proc;
  };
  // The 3 s timeout timer does not keep the process alive by itself.
  const keepAlive = setInterval(() => {}, 1000);
  const ask = (text) => suggest.suggest({ text, projectRoot: '/y', settings, deps: { catalog, fetcher, spawnFn } });
  const started = Date.now();
  const first = await ask('el pago falla con el carrito vacío');
  assert.ok(Date.now() - started < 4500, 'a slow local model is given up within about 3 s');
  assert.equal(first.engine, 'claude');
  slow = false;
  const second = await ask('el login falla con correos en mayúsculas');
  assert.equal(second.engine, 'claude', 'the local model is skipped for a while after failing');
  assert.equal(localCalls, 1);
  suggest._resetLocal();
  const third = await ask('la búsqueda devuelve resultados repetidos siempre');
  assert.equal(third.engine, 'local');
  assert.equal(claude.length, 2);
  clearInterval(keepAlive);
});

test('suggestions never go to Claude when the chat uses the local model, nor while Claude is out of usage', async () => {
  const catalog = [{ kind: 'task', id: 'bugfix', description: 'fix a bug', core: true }];
  let spawned = 0;
  const spawnFn = () => {
    spawned++;
    throw new Error('should not run');
  };
  const settings = defaultSettings();
  settings.ai.mode = 'local';
  const engines = [['claude', (s, sys, user, opts) => suggest._viaClaude(s, sys, user, opts)]];
  const r = await suggest.suggest({
    text: 'revisa la seguridad del login ahora',
    projectRoot: '/z',
    settings,
    deps: { catalog, engines, spawnFn }
  });
  assert.deepEqual(r.suggestions, []);
  settings.ai.mode = 'claude';
  const blocked = await suggest._viaClaude(settings, 's', 'u', { spawnFn, blockedUntil: () => Date.now() + 1000 });
  assert.equal(blocked, null);
  assert.equal(spawned, 0);
});

test('at most two Haiku suggestions run per repo: a third stops the oldest', async () => {
  const { EventEmitter } = require('events');
  const procs = [];
  const spawnFn = () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stdin = { on: () => {}, end: () => {} };
    proc.killed = false;
    proc.kill = () => {
      proc.killed = true;
      setImmediate(() => proc.emit('exit', null));
    };
    procs.push(proc);
    return proc;
  };
  const settings = defaultSettings();
  const ask = () =>
    suggest._viaClaude(settings, 's', 'u', { spawnFn, cwd: '/repo', blockedUntil: () => 0 }).catch((e) => e);
  const first = ask();
  ask();
  ask();
  assert.equal(procs[0].killed, true);
  assert.equal(procs[1].killed, false);
  assert.ok((await first) instanceof Error);
  for (const p of procs.slice(1)) {
    p.stdout.emit('data', JSON.stringify({ result: '{}' }));
    p.emit('exit', 0);
  }
});
