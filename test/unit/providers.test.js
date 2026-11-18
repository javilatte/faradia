'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { mkTmpDir, rmTmpDir } = require('./helpers');
const proxy = require('../../server/ai/anthropicProxy');
const fallback = require('../../server/ai/fallback');
const suggest = require('../../server/ai/suggest');
const gemini = require('../../server/ai/gemini');
const { buildSessionOptions, engineFor } = require('../../server/bridge/sessionOptions');
const { defaultSettings } = require('../../server/store/settingsStore');

const memorySignatures = () => {
  const m = new Map();
  return { get: (k) => m.get(k), set: (k, v) => m.set(k, v) };
};

test('an Anthropic request becomes a Gemini one: roles, tools, results and signatures', () => {
  const sigs = memorySignatures();
  sigs.set('toolu_1', 'SIG');
  const req = proxy.toGeminiRequest(
    {
      system: [{ type: 'text', text: 'Be brief' }],
      max_tokens: 1000,
      tools: [{ name: 'Bash', description: 'run', input_schema: { $schema: 'x', type: 'object', properties: {} } }],
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'secret', signature: 'anthropic' },
            { type: 'text', text: 'running' },
            { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
            { type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'pwd' } }
          ]
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'a.txt' }] },
            { type: 'tool_result', tool_use_id: 'toolu_2', content: 'boom', is_error: true }
          ]
        }
      ]
    },
    sigs
  );
  assert.deepEqual(req.systemInstruction, { parts: [{ text: 'Be brief' }] });
  assert.deepEqual(
    req.contents.map((c) => c.role),
    ['user', 'model', 'user']
  );
  const model = req.contents[1].parts;
  assert.equal(model.length, 3, 'thinking blocks are dropped');
  assert.equal(model[1].thoughtSignature, 'SIG');
  assert.equal(model[2].thoughtSignature, proxy.SKIP_SIGNATURE, 'history from Claude has no signature');
  assert.deepEqual(req.contents[2].parts[0].functionResponse, {
    id: 'toolu_1',
    name: 'Bash',
    response: { output: 'a.txt' }
  });
  assert.deepEqual(req.contents[2].parts[1].functionResponse.response, { error: 'boom' });
  assert.equal(req.tools[0].functionDeclarations[0].parametersJsonSchema.$schema, undefined);
  assert.equal(req.generationConfig.maxOutputTokens, 1000);
});

test('Gemini parts become Anthropic blocks and keep the function call signature', () => {
  const sigs = memorySignatures();
  const blocks = proxy.partsToBlocks(
    [
      { text: 'thinking…', thought: true },
      { text: 'a' },
      { text: 'b' },
      { functionCall: { name: 'Read', args: { file_path: 'x' } }, thoughtSignature: 'S2' }
    ],
    sigs
  );
  assert.equal(blocks[0].text, 'ab');
  assert.equal(blocks[1].type, 'tool_use');
  assert.equal(sigs.get(blocks[1].id), 'S2');
});

test('the proxy answers the claude CLI protocol, streamed, and only with its token', async (t) => {
  const dir = mkTmpDir('proxy');
  const fetcher = async () =>
    new Response(
      new ReadableStream({
        start(c) {
          const chunk = {
            candidates: [{ content: { parts: [{ text: 'hola' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 }
          };
          c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\r\n\r\n`));
          c.close();
        }
      }),
      { status: 200 }
    );
  const p = proxy.createProxy({
    getConfig: () => ({ apiKey: 'k', model: 'gemini-x' }),
    fetcher,
    signaturesFile: path.join(dir, 's.json')
  });
  await p.listen();
  t.after(async () => {
    await p.close();
    rmTmpDir(dir);
  });
  const denied = await fetch(`${p.url}/gemini/v1/messages`, { method: 'POST', body: '{}' });
  assert.equal(denied.status, 401);
  const res = await fetch(`${p.url}/gemini/v1/messages?beta=true`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${p.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-haiku',
      stream: true,
      max_tokens: 10,
      messages: [{ role: 'user', content: 'hi' }]
    })
  });
  const text = await res.text();
  const events = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(events, [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop'
  ]);
  assert.match(text, /"model":"gemini-x"/, 'Claude model names map to the chosen Gemini model');
});

test('a Gemini quota error reaches the CLI as a rate limit', async (t) => {
  const dir = mkTmpDir('proxy-429');
  const p = proxy.createProxy({
    getConfig: () => ({ apiKey: 'k', model: 'gemini-x' }),
    fetcher: async () => new Response(JSON.stringify({ error: { message: 'quota' } }), { status: 429 }),
    signaturesFile: path.join(dir, 's.json')
  });
  await p.listen();
  t.after(async () => {
    await p.close();
    rmTmpDir(dir);
  });
  const res = await fetch(`${p.url}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': p.token },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
  });
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error.type, 'rate_limit_error');
});

test('Claude out of usage: detected from the stream, then sessions use Gemini or the local model', (t) => {
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

  const settings = defaultSettings();
  assert.equal(fallback.fallbackEngine(settings), null);
  settings.ai.localAi = { url: 'http://127.0.0.1:1234', model: 'gemma', authHeader: '' };
  assert.equal(fallback.fallbackEngine(settings), 'local');
  settings.providers.gemini = { apiKey: 'k', model: 'gemini-x' };
  assert.equal(fallback.fallbackEngine(settings), 'gemini');

  assert.equal(engineFor(settings), 'claude');
  fallback.markClaudeBlocked(Date.now() + 60_000);
  assert.equal(engineFor(settings), 'gemini');
  assert.equal(engineFor(settings, { engine: 'local', model: 'm' }), 'local', 'an agent on another engine keeps it');
  fallback.clearClaudeBlock();
  assert.equal(engineFor(settings), 'claude', 'back to Claude when it is available');
});

test('a Gemini session goes through the local proxy with its token, never the account', (t) => {
  const dir = mkTmpDir('gemini-session');
  t.after(() => {
    proxy.setSharedProxy(null);
    rmTmpDir(dir);
  });
  const settings = defaultSettings();
  settings.ai.mode = 'gemini';
  assert.throws(() => buildSessionOptions(settings, dir), /Ajustes › Gemini/);
  settings.providers.gemini = { apiKey: 'k', model: 'gemini-x' };
  proxy.setSharedProxy({ url: 'http://127.0.0.1:9', token: 'tok' });
  const opts = buildSessionOptions(settings, dir);
  assert.equal(opts.engine, 'gemini');
  assert.equal(opts.baseUrl, 'http://127.0.0.1:9/gemini');
  assert.equal(opts.authToken, 'tok');
  assert.equal(opts.model, 'gemini-x');
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

test('suggestions try Gemini, then the local model, then Claude, and skip short messages', async () => {
  const settings = defaultSettings();
  const catalog = [{ kind: 'task', id: 'bugfix', description: 'fix a bug', core: true }];
  const tried = [];
  const engines = [
    ['gemini', async () => (tried.push('gemini'), null)],
    ['local', async () => (tried.push('local'), Promise.reject(new Error('down')))],
    ['claude', async () => (tried.push('claude'), '{"suggestions":[{"kind":"task","id":"bugfix","reason":"r"}]}')]
  ];
  const r = await suggest.suggest({
    text: 'el carrito vacío rompe el pago ahora',
    projectRoot: '/x',
    settings,
    deps: { catalog, engines }
  });
  assert.deepEqual(tried, ['gemini', 'local', 'claude']);
  assert.equal(r.engine, 'claude');
  assert.equal(r.suggestions[0].id, 'bugfix');
  const none = await suggest.suggest({ text: 'hola', projectRoot: '/x', settings, deps: { catalog, engines } });
  assert.deepEqual(none.suggestions, []);
  settings.suggestions.mode = 'off';
  assert.equal((await suggest.suggest({ text: 'a b c d e', projectRoot: '/x', settings })).off, true);
});

test('the recommended Gemini model is Hydrogen when offered, else the newest Flash', () => {
  assert.equal(
    gemini.recommendedModel([{ id: 'gemini-3-pro' }, { id: 'gemini-3-flash' }, { id: 'gemini-4-hydrogen' }]),
    'gemini-4-hydrogen'
  );
  assert.equal(
    gemini.recommendedModel([{ id: 'gemini-3-pro' }, { id: 'gemini-3-flash-lite' }, { id: 'gemini-3-flash' }]),
    'gemini-3-flash'
  );
});
