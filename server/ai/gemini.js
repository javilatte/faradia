'use strict';

// Google's Gemini API (generativelanguage.googleapis.com) with a Google AI Studio key. Used for quick
// one-shot calls (suggestions) and, through ai/anthropicProxy.js, as a fallback engine for sessions.
// The key travels only in the x-goog-api-key header, never in the URL (it would end up in logs).

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const NOT_CHAT = /(embedding|aqa|imagen|veo|tts|native-audio|live|image-generation|learnlm|robotics)/i;

class GeminiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(pathname, { apiKey, method = 'GET', body, timeoutMs = 10000, fetcher = fetch } = {}) {
  if (!apiKey) throw new GeminiError('falta la API key de Gemini', 401);
  const res = await fetcher(`${BASE}${pathname}`, {
    method,
    headers: { 'x-goog-api-key': apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const msg = data?.error?.message || text.slice(0, 200) || `HTTP ${res.status}`;
    throw new GeminiError(msg, res.status);
  }
  return data;
}

/**
 * Chat models the key can use, newest first: [{id, name, inputTokens, outputTokens}]. Also checks
 * that the key works (a wrong key answers 400/403).
 */
async function listModels(apiKey, opts = {}) {
  const out = [];
  let token = '';
  for (let page = 0; page < 5; page++) {
    const q = `?pageSize=200${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`;
    const data = await request(`/models${q}`, { apiKey, ...opts });
    for (const m of data.models || []) {
      const id = String(m.name || '').replace(/^models\//, '');
      if (!id || NOT_CHAT.test(id)) continue;
      if (!(m.supportedGenerationMethods || []).includes('generateContent')) continue;
      out.push({
        id,
        name: m.displayName || id,
        inputTokens: m.inputTokenLimit || 0,
        outputTokens: m.outputTokenLimit || 0
      });
    }
    token = data.nextPageToken;
    if (!token) break;
  }
  // Newest versions first; "latest"/preview aliases after the stable one of the same family.
  return out.sort((a, b) => b.id.localeCompare(a.id, 'en', { numeric: true }));
}

/**
 * The one we propose: a Hydrogen model when the key offers one (Google's free-tier model), else the
 * newest Flash (fast and cheap), else the first one.
 */
function recommendedModel(models) {
  const hydrogen = models.find((m) => /hydrogen/i.test(m.id));
  if (hydrogen) return hydrogen.id;
  const flash = models.filter((m) => /flash/i.test(m.id) && !/lite|thinking|exp/i.test(m.id));
  return (flash[0] || models[0] || {}).id || '';
}

function textOf(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('');
}

/** One question, a JSON answer (as text). Thinking off where the model allows it, for speed. */
async function askJson({ apiKey, model, system, user, timeoutMs = 8000, fetcher }) {
  const body = (thinking) => ({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 400,
      responseMimeType: 'application/json',
      ...(thinking ? {} : { thinkingConfig: { thinkingBudget: 0 } })
    }
  });
  const path = `/models/${encodeURIComponent(model)}:generateContent`;
  try {
    return textOf(await request(path, { apiKey, method: 'POST', body: body(false), timeoutMs, fetcher }));
  } catch (err) {
    // Models that always think reject a zero budget: ask again without it.
    if (err.status === 400 && /thinking/i.test(err.message)) {
      return textOf(await request(path, { apiKey, method: 'POST', body: body(true), timeoutMs, fetcher }));
    }
    throw err;
  }
}

module.exports = { BASE, GeminiError, listModels, recommendedModel, askJson, request };
