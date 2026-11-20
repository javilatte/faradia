'use strict';

const engine = require('../voice/localEngine');
const { loadGlobalSettings } = require('../store/settingsStore');
const { sendJson } = require('./util');

// Dictation with Faradia's own engine (voice/localEngine.js): macOS's speech recognition on a Mac,
// Whisper elsewhere or when it cannot.
//   GET  /api/voice/status                         {installed, installing, error, threads, model, job, apple}
//   POST /api/voice/install                        installs the engine (once; it returns at once)
//   POST /api/voice/transcribe?model=&languages=   body: 16 kHz mono Float32 samples (little endian)
//                                                  -> {text, language, model ('apple' or Whisper's)}

const MAX_SECONDS = 10 * 60;
const MAX_BYTES = MAX_SECONDS * 16000 * 4;

function readSamples(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        reject(Object.assign(new Error('la grabación es demasiado larga (máximo 10 minutos)'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (!buf.length || buf.length % 4) {
        return reject(Object.assign(new Error('la grabación no es válida'), { status: 400 }));
      }
      // Copied to an aligned buffer: Float32Array needs offsets that are multiples of 4.
      resolve(new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)));
    });
    req.on('error', reject);
  });
}

function parseLanguages(raw) {
  if (raw === null || raw === 'any') return null;
  const codes = String(raw)
    .split(',')
    .filter((c) => /^[a-z]{2,3}$/.test(c));
  return codes.length ? codes : ['es', 'en'];
}

async function handleVoiceRoutes(req, res, url) {
  const p = url.pathname;
  if (p === '/api/voice/status' && req.method === 'GET') return sendJson(res, 200, engine.status());
  if (p === '/api/voice/install' && req.method === 'POST') {
    engine.install().catch(() => {
      /* kept in status().error */
    });
    return sendJson(res, 202, engine.status());
  }
  if (p === '/api/voice/transcribe' && req.method === 'POST') {
    try {
      const audio = await readSamples(req);
      const result = await engine.transcribe(audio, {
        model: url.searchParams.get('model') || 'auto',
        languages: parseLanguages(url.searchParams.get('languages')),
        engine: loadGlobalSettings().voice.engine === 'whisper' ? 'whisper' : 'auto'
      });
      return sendJson(res, 200, result);
    } catch (err) {
      // Whisper is not installed yet (Apple's recognizer could not do it either): it installs now and
      // the browser transcribes this time.
      if (err.status === 409) engine.install().catch(() => {});
      return sendJson(res, err.status || 500, { error: err.message, apple: engine.status().apple });
    }
  }
  return null;
}

module.exports = { handleVoiceRoutes, parseLanguages };
