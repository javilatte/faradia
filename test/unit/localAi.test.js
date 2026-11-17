'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { identify, listModelsAt, detectLocalServers, localSessionEnv } = require('../../server/bridge/localAi');

// A fake local server: `routes` maps a path to the JSON it answers (anything else is a 404).
async function fakeServer(t, routes) {
  const server = http.createServer((req, res) => {
    const body = routes[req.url];
    if (body === undefined) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

const LMSTUDIO = {
  '/api/v1/models': {
    models: [
      { type: 'llm', key: 'google/gemma-4-12b', size_bytes: 7556572366, loaded_instances: [] },
      { type: 'embedding', key: 'text-embedding-nomic-embed-text-v1.5', size_bytes: 84110000 }
    ]
  },
  '/v1/models': { data: [{ id: 'google/gemma-4-12b' }, { id: 'text-embedding-nomic-embed-text-v1.5' }] }
};
const OLLAMA = {
  '/api/tags': { models: [{ name: 'qwen2.5-coder:7b', size: 4683087332 }, { name: 'nomic-embed-text:latest' }] },
  '/v1/models': { data: [{ id: 'qwen2.5-coder:7b' }] }
};

test('identify: tells Ollama, LM Studio and other OpenAI-compatible servers apart', async (t) => {
  assert.equal(await identify(await fakeServer(t, OLLAMA)), 'ollama');
  assert.equal(await identify(await fakeServer(t, LMSTUDIO)), 'lmstudio');
  assert.equal(await identify(await fakeServer(t, { '/v1/models': { data: [] } })), 'openai-compatible');
});

test('listModelsAt: chat models only, embedding models are left out', async (t) => {
  const lm = await listModelsAt(await fakeServer(t, LMSTUDIO));
  assert.deepEqual(lm, [{ name: 'google/gemma-4-12b', size: 7556572366, loaded: false }]);
  const ol = await listModelsAt(`${await fakeServer(t, OLLAMA)}/`);
  assert.deepEqual(
    ol.map((m) => m.name),
    ['qwen2.5-coder:7b']
  );
  const other = await listModelsAt(await fakeServer(t, { '/v1/models': { data: [{ id: 'mistral' }] } }));
  assert.deepEqual(other, [{ name: 'mistral' }]);
});

test('detectLocalServers: finds the configured server and skips the ones that are not running', async (t) => {
  const url = await fakeServer(t, LMSTUDIO);
  const servers = await detectLocalServers({ configuredUrl: url, lmsPort: async () => 1 });
  const mine = servers.find((s) => s.url === url);
  assert.equal(mine.provider, 'lmstudio');
  assert.equal(mine.label, 'LM Studio');
  assert.deepEqual(
    mine.models.map((m) => m.name),
    ['google/gemma-4-12b']
  );
  assert.ok(!servers.some((s) => s.url === 'http://127.0.0.1:1'), 'nothing listens on port 1');
});

test('localSessionEnv: the account credentials never reach the local server', () => {
  const env = localSessionEnv(
    { PATH: '/bin', ANTHROPIC_API_KEY: 'account-key-placeholder' },
    { baseUrl: 'http://127.0.0.1:1234', model: 'google/gemma-4-12b' }
  );
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:1234');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'optimia-local');
  assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, 'google/gemma-4-12b');
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'google/gemma-4-12b');
  assert.equal(env.PATH, '/bin');
  assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, undefined);
  const withHeader = localSessionEnv({}, { baseUrl: 'http://x', authHeader: 'X-Key: 1' });
  assert.equal(withHeader.ANTHROPIC_CUSTOM_HEADERS, 'X-Key: 1');
});
