'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const gemini = require('./gemini');
const { dataDir } = require('../store/globalPaths');

// A local endpoint that speaks the Anthropic Messages API (what the claude CLI needs behind
// ANTHROPIC_BASE_URL) and answers with Gemini. With it the chat and the agents run on Gemini with
// the same tools, the same session files and the same history as with Claude: switching provider in
// the middle of a conversation keeps all its context (claude --resume replays the transcript to
// whichever model is behind the URL).
//
//   POST /v1/messages               stream or not, tools included
//   POST /v1/messages/count_tokens  an estimate (Gemini counts differently)
//
// Only callers holding the per-run token get through: the Gemini key never leaves this process.
//
// Gemini 3 attaches a "thought signature" to its function calls and wants it back in the next turn.
// They are kept by tool_use id (in memory and on disk, so a restart does not lose them); history
// that came from Claude has none, and gets the placeholder Google documents for injected history.

const SKIP_SIGNATURE = 'skip_thought_signature_validator';
const MAX_SIGNATURES = 5000;

function signatureStore(file) {
  let map = new Map();
  try {
    map = new Map(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    /* first run */
  }
  let timer = null;
  const persist = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify([...map].slice(-MAX_SIGNATURES)));
      } catch {
        /* best effort */
      }
    }, 500);
    timer.unref?.();
  };
  return {
    get: (id) => map.get(id),
    set(id, sig) {
      map.set(id, sig);
      if (map.size > MAX_SIGNATURES) map.delete(map.keys().next().value);
      persist();
    }
  };
}

// ---------- Anthropic request -> Gemini request ----------

function blocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  return blocks(content)
    .map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
}

// JSON Schema keywords Gemini rejects inside parametersJsonSchema.
function cleanSchema(schema) {
  if (Array.isArray(schema)) return schema.map(cleanSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === '$schema' || k === '$id' || k === '$comment') continue;
    out[k] = cleanSchema(v);
  }
  return out;
}

function toGeminiRequest(body, signatures) {
  const names = new Map(); // tool_use id -> tool name, for the results
  const contents = [];
  for (const msg of body.messages || []) {
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const parts = [];
    for (const b of blocks(msg.content)) {
      if (b.type === 'text' && b.text) parts.push({ text: b.text });
      else if (b.type === 'image' && b.source?.type === 'base64') {
        parts.push({ inlineData: { mimeType: b.source.media_type, data: b.source.data } });
      } else if (b.type === 'document' && b.source?.type === 'base64') {
        parts.push({ inlineData: { mimeType: b.source.media_type || 'application/pdf', data: b.source.data } });
      } else if (b.type === 'tool_use') {
        names.set(b.id, b.name);
        parts.push({
          functionCall: { id: b.id, name: b.name, args: b.input || {} },
          thoughtSignature: signatures.get(b.id) || SKIP_SIGNATURE
        });
      } else if (b.type === 'tool_result') {
        const text = toolResultText(b.content);
        parts.push({
          functionResponse: {
            id: b.tool_use_id,
            name: names.get(b.tool_use_id) || 'tool',
            response: b.is_error ? { error: text } : { output: text }
          }
        });
      }
      // thinking / redacted_thinking: signed by Anthropic, meaningless to Gemini.
    }
    if (!parts.length) continue;
    // Gemini wants alternating roles: merge consecutive messages of the same role.
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  }
  const system = typeof body.system === 'string' ? body.system : toolResultText(body.system);
  const req = {
    contents,
    generationConfig: {
      maxOutputTokens: Math.min(Number(body.max_tokens) || 8192, 65536),
      ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
      ...(Array.isArray(body.stop_sequences) && body.stop_sequences.length
        ? { stopSequences: body.stop_sequences.slice(0, 5) }
        : {})
    }
  };
  if (system) req.systemInstruction = { parts: [{ text: system }] };
  const tools = (body.tools || []).filter((t) => t.name && t.input_schema);
  if (tools.length) {
    req.tools = [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description || '',
          parametersJsonSchema: cleanSchema(t.input_schema)
        }))
      }
    ];
    const choice = body.tool_choice?.type;
    if (choice === 'any' || choice === 'tool') {
      req.toolConfig = {
        functionCallingConfig: {
          mode: 'ANY',
          ...(choice === 'tool' ? { allowedFunctionNames: [body.tool_choice.name] } : {})
        }
      };
    } else if (choice === 'none') req.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
  }
  return req;
}

// ---------- Gemini response -> Anthropic response ----------

const STOP = { STOP: 'end_turn', MAX_TOKENS: 'max_tokens' };

function usageOf(meta = {}) {
  return {
    input_tokens: meta.promptTokenCount || 0,
    output_tokens: (meta.candidatesTokenCount || 0) + (meta.thoughtsTokenCount || 0),
    cache_read_input_tokens: meta.cachedContentTokenCount || 0
  };
}

const newToolId = () => `toolu_g${crypto.randomBytes(12).toString('hex')}`;

/** Turns Gemini parts into Anthropic content blocks (and keeps the signatures). */
function partsToBlocks(parts, signatures) {
  const out = [];
  for (const p of parts || []) {
    if (p.thought) continue;
    if (typeof p.text === 'string' && p.text) {
      const last = out[out.length - 1];
      if (last && last.type === 'text') last.text += p.text;
      else out.push({ type: 'text', text: p.text });
    } else if (p.functionCall) {
      const id = p.functionCall.id || newToolId();
      if (p.thoughtSignature) signatures.set(id, p.thoughtSignature);
      out.push({ type: 'tool_use', id, name: p.functionCall.name, input: p.functionCall.args || {} });
    }
  }
  return out;
}

function errorBody(status, message) {
  const type =
    status === 429
      ? 'rate_limit_error'
      : status === 401 || status === 403
        ? 'authentication_error'
        : status === 400
          ? 'invalid_request_error'
          : status >= 500
            ? 'api_error'
            : 'api_error';
  return { type: 'error', error: { type, message: `Gemini: ${message}` } };
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ---------- the server ----------

function createProxy({ getConfig, fetcher = fetch, signaturesFile } = {}) {
  const token = crypto.randomBytes(24).toString('hex');
  const signatures = signatureStore(signaturesFile || path.join(dataDir(), 'gemini-signatures.json'));

  async function callGemini(model, apiKey, req, stream) {
    const method = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    return fetcher(`${gemini.BASE}/models/${encodeURIComponent(model)}:${method}`, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(req)
    });
  }

  async function messages(body, res) {
    const { apiKey, model: defaultModel } = getConfig();
    if (!apiKey) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(errorBody(401, 'no hay API key de Gemini (Ajustes › Gemini)')));
    }
    // The CLI sends the model it was given; Claude names (background calls) map to the chosen one.
    const model = /^gemini|^gemma|hydrogen/i.test(body.model || '') ? body.model : defaultModel;
    const req = toGeminiRequest(body, signatures);
    const upstream = await callGemini(model, apiKey, req, Boolean(body.stream));
    if (!upstream.ok) {
      const text = await upstream.text();
      let msg = text.slice(0, 300);
      try {
        msg = JSON.parse(text).error?.message || msg;
      } catch {
        /* raw */
      }
      res.writeHead(upstream.status === 429 ? 429 : upstream.status >= 500 ? 529 : upstream.status, {
        'Content-Type': 'application/json'
      });
      return res.end(JSON.stringify(errorBody(upstream.status, msg)));
    }
    const id = `msg_g${crypto.randomBytes(12).toString('hex')}`;
    if (!body.stream) {
      const data = await upstream.json();
      const cand = data.candidates?.[0] || {};
      const content = partsToBlocks(cand.content?.parts, signatures);
      const stop = content.some((b) => b.type === 'tool_use') ? 'tool_use' : STOP[cand.finishReason] || 'end_turn';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({
          id,
          type: 'message',
          role: 'assistant',
          model,
          content,
          stop_reason: stop,
          stop_sequence: null,
          usage: usageOf(data.usageMetadata)
        })
      );
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    sse(res, 'message_start', {
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: usageOf()
      }
    });
    let index = -1;
    let textOpen = false;
    let sawTool = false;
    let finish = 'STOP';
    let usage = usageOf();
    const closeText = () => {
      if (textOpen) sse(res, 'content_block_stop', { type: 'content_block_stop', index });
      textOpen = false;
    };
    const onChunk = (data) => {
      if (data.usageMetadata) usage = usageOf(data.usageMetadata);
      const cand = data.candidates?.[0];
      if (!cand) return;
      if (cand.finishReason) finish = cand.finishReason;
      for (const p of cand.content?.parts || []) {
        if (p.thought) continue;
        if (typeof p.text === 'string' && p.text) {
          if (!textOpen) {
            index++;
            textOpen = true;
            sse(res, 'content_block_start', {
              type: 'content_block_start',
              index,
              content_block: { type: 'text', text: '' }
            });
          }
          sse(res, 'content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'text_delta', text: p.text }
          });
        } else if (p.functionCall) {
          closeText();
          sawTool = true;
          index++;
          const toolId = p.functionCall.id || newToolId();
          if (p.thoughtSignature) signatures.set(toolId, p.thoughtSignature);
          sse(res, 'content_block_start', {
            type: 'content_block_start',
            index,
            content_block: { type: 'tool_use', id: toolId, name: p.functionCall.name, input: {} }
          });
          sse(res, 'content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(p.functionCall.args || {}) }
          });
          sse(res, 'content_block_stop', { type: 'content_block_stop', index });
        }
      }
    };
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of upstream.body) {
      buf += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        try {
          onChunk(JSON.parse(line.slice(5)));
        } catch {
          /* keep-alive or partial */
        }
      }
    }
    closeText();
    const stop = sawTool ? 'tool_use' : STOP[finish] || 'end_turn';
    sse(res, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { output_tokens: usage.output_tokens, input_tokens: usage.input_tokens }
    });
    sse(res, 'message_stop', { type: 'message_stop' });
    res.end();
  }

  const server = http.createServer(async (req, res) => {
    const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-api-key'];
    if (auth !== token) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(errorBody(401, 'token no válido')));
    }
    const url = new URL(req.url, 'http://x');
    let raw = '';
    for await (const c of req) raw += c;
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(errorBody(400, 'JSON no válido')));
    }
    try {
      if (req.method === 'POST' && url.pathname.endsWith('/v1/messages/count_tokens')) {
        const chars =
          JSON.stringify(body.messages || []).length +
          JSON.stringify(body.system || '').length +
          JSON.stringify(body.tools || []).length;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ input_tokens: Math.ceil(chars / 4) }));
      }
      if (req.method === 'POST' && url.pathname.endsWith('/v1/messages')) return await messages(body, res);
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(errorBody(404, `${req.method} ${url.pathname} no existe`)));
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(errorBody(502, err.message)));
      } else {
        sse(res, 'error', errorBody(502, err.message));
        res.end();
      }
    }
  });

  let url = null;
  return {
    token,
    get url() {
      return url;
    },
    listen(port = 0) {
      return new Promise((resolve) =>
        server.listen(port, '127.0.0.1', () => {
          url = `http://127.0.0.1:${server.address().port}`;
          resolve(url);
        })
      );
    },
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

// The one optimia runs, started with the server (see server/index.js).
let shared = null;
function setSharedProxy(p) {
  shared = p;
}
function sharedProxy() {
  return shared;
}

module.exports = {
  createProxy,
  toGeminiRequest,
  partsToBlocks,
  cleanSchema,
  setSharedProxy,
  sharedProxy,
  SKIP_SIGNATURE
};
