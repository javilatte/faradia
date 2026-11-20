// Whisper in the browser, off the main thread (see voice.js and whisper-core.mjs). The library comes
// from the CDN and the model from Hugging Face the first time; the browser keeps both in its cache.
// The audio never leaves this worker.
//
// In:  {type: 'transcribe', id, audio: Float32Array (16 kHz mono), model, languages: [code] | null}
// Out: {type: 'progress', id, model, loaded, total} while the model loads
//      {type: 'result', id, model, language, text} | {type: 'error', id, message}

import * as transformers from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/dist/transformers.min.js';
import { MODELS, createTranscriber } from './whisper-core.mjs';

async function hasGpu() {
  try {
    return Boolean(await navigator.gpu?.requestAdapter());
  } catch {
    return false;
  }
}

// Created on the first message: the handler must exist before any await, or early messages are lost.
let setup = null;
async function engine() {
  setup ??= hasGpu().then((gpu) => ({
    gpu,
    whisper: createTranscriber(transformers, { device: gpu ? 'webgpu' : 'wasm' })
  }));
  return setup;
}

self.onmessage = async ({ data }) => {
  if (data?.type !== 'transcribe') return;
  const { id } = data;
  const { gpu, whisper } = await engine();
  // "auto": large-v3-turbo with a GPU; without one it takes a minute in WebAssembly, so small.
  const model = MODELS[data.model] ? data.model : gpu ? 'turbo' : 'small';
  try {
    const { language, text } = await whisper.transcribe(model, data.audio, data.languages, (loaded, total) =>
      self.postMessage({ type: 'progress', id, model, loaded, total })
    );
    self.postMessage({ type: 'result', id, model, language, text });
  } catch (err) {
    self.postMessage({ type: 'error', id, message: err?.message || String(err) });
  }
};
