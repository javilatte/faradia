'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Local model servers that speak the Anthropic Messages API (/v1/messages), which is what the claude
// CLI needs behind ANTHROPIC_BASE_URL:
//   - Ollama >= 0.14 (default port 11434)
//   - LM Studio >= 0.4 (default port 1234; `lms server status --json` tells the real one)
// Both also list their models in the OpenAI format at /v1/models. The current claude CLI sends the
// model name as is (verified with 2.1.x), so "google/gemma-4-12b" or "qwen2.5-coder:7b" work as
// --model and several agents can use different local models at the same time.

const OLLAMA_URL = 'http://127.0.0.1:11434';
const LMSTUDIO_DEFAULT_PORT = 1234;
const EMBEDDING_RE = /(^|[-_/.])(embed|embedding|bge|e5|minilm|nomic-embed)([-_/.:]|$)/i;

async function getJson(url, { timeoutMs = 2500, fetcher = fetch } = {}) {
  const res = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

const trimUrl = (url) => String(url || '').replace(/\/+$/, '');

// Which server is behind a URL, from what it answers.
async function identify(url, opts) {
  const base = trimUrl(url);
  try {
    const tags = await getJson(`${base}/api/tags`, opts);
    if (Array.isArray(tags?.models)) return 'ollama';
  } catch {
    /* not Ollama */
  }
  try {
    const lm = await getJson(`${base}/api/v1/models`, opts);
    if (Array.isArray(lm?.models)) return 'lmstudio';
  } catch {
    /* not LM Studio */
  }
  return 'openai-compatible';
}

/**
 * Chat models a local server offers: [{name, size?, loaded?}]. Embedding models are left out, they
 * cannot answer a conversation.
 */
async function listModelsAt(url, opts = {}) {
  const base = trimUrl(url);
  if (!base) return [];
  const provider = opts.provider || (await identify(base, opts));
  if (provider === 'ollama') {
    const { models = [] } = await getJson(`${base}/api/tags`, opts);
    return models.map((m) => ({ name: m.name, size: m.size })).filter((m) => m.name && !EMBEDDING_RE.test(m.name));
  }
  if (provider === 'lmstudio') {
    const { models = [] } = await getJson(`${base}/api/v1/models`, opts);
    return models
      .filter((m) => m.type !== 'embedding' && m.key)
      .map((m) => ({ name: m.key, size: m.size_bytes, loaded: (m.loaded_instances || []).length > 0 }));
  }
  const { data = [] } = await getJson(`${base}/v1/models`, opts);
  return data.map((m) => ({ name: m.id })).filter((m) => m.name && !EMBEDDING_RE.test(m.name));
}

// LM Studio's port: its CLI knows it (the app may move it off 1234 when that port is busy).
function lmStudioPort({ home = os.homedir(), runner = execFile } = {}) {
  const candidates = [path.join(home, '.lmstudio', 'bin', 'lms'), 'lms'];
  const lms = candidates.find((c) => c === 'lms' || fs.existsSync(c));
  return new Promise((resolve) => {
    runner(lms, ['server', 'status', '--json'], { encoding: 'utf8', timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      const line = String(stdout).trim().split('\n').pop();
      try {
        const status = JSON.parse(line);
        resolve(status.running && Number(status.port) ? Number(status.port) : null);
      } catch {
        resolve(null);
      }
    });
  });
}

/**
 * Local servers running on this machine, with their models:
 * [{provider, label, url, models: [...]}]. `configuredUrl` (Settings > Local AI) is checked too.
 */
async function detectLocalServers({ configuredUrl, fetcher, lmsPort = lmStudioPort } = {}) {
  const port = await lmsPort();
  const candidates = [
    { provider: 'ollama', url: OLLAMA_URL },
    { provider: 'lmstudio', url: `http://127.0.0.1:${port || LMSTUDIO_DEFAULT_PORT}` }
  ];
  const own = trimUrl(configuredUrl);
  if (own && !candidates.some((c) => c.url === own)) candidates.unshift({ provider: null, url: own });
  const found = await Promise.all(
    candidates.map(async (c) => {
      try {
        const provider = c.provider ? await confirm(c, { fetcher }) : await identify(c.url, { fetcher });
        if (!provider) return null;
        const models = await listModelsAt(c.url, { provider, fetcher });
        return { provider, label: LABELS[provider], url: c.url, models };
      } catch {
        return null;
      }
    })
  );
  return found.filter(Boolean);
}

const LABELS = { ollama: 'Ollama', lmstudio: 'LM Studio', 'openai-compatible': 'Servidor local' };

// The expected server really answers at its usual address.
async function confirm({ provider, url }, opts) {
  const probe = provider === 'ollama' ? '/api/tags' : '/api/v1/models';
  await getJson(`${url}${probe}`, opts);
  return provider;
}

/**
 * Environment for a claude session that talks to a local server. The account's credentials never
 * travel to it: a placeholder token replaces the claude.ai login and ANTHROPIC_API_KEY is dropped.
 * Background requests (titles, summaries) use the same local model, since the server does not know
 * the Claude model names. `authHeader` ("Name: value") is for servers behind a proxy that asks for
 * one.
 */
function localSessionEnv(env, { baseUrl, authHeader, model }) {
  const out = { ...env };
  delete out.ANTHROPIC_API_KEY;
  out.ANTHROPIC_BASE_URL = baseUrl;
  out.ANTHROPIC_AUTH_TOKEN = 'optimia-local';
  if (authHeader) out.ANTHROPIC_CUSTOM_HEADERS = authHeader;
  if (model) {
    out.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
    out.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
    out.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
    out.ANTHROPIC_SMALL_FAST_MODEL = model;
  }
  out.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  return out;
}

module.exports = {
  OLLAMA_URL,
  identify,
  listModelsAt,
  lmStudioPort,
  detectLocalServers,
  localSessionEnv
};
