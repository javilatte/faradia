// Whisper on Faradia's side (see localEngine.js): a worker thread so the server keeps answering while
// it transcribes, with the same code as the browser (web/js/project/whisper-core.mjs).
//
// In:  {type: 'transcribe', id, audio: Float32Array (16 kHz mono), model, languages: [code] | null}
// Out: {type: 'progress', id, model, loaded, total} while the model downloads
//      {type: 'result', id, model, language, text} | {type: 'error', id, message}

import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { createTranscriber } from '../../web/js/project/whisper-core.mjs';

const transformers = await import(pathToFileURL(workerData.entry).href);
const whisper = createTranscriber(transformers, { device: 'cpu', cacheDir: workerData.modelsDir });

parentPort.on('message', async (data) => {
  if (data?.type !== 'transcribe') return;
  const { id, model } = data;
  try {
    const { language, text } = await whisper.transcribe(model, data.audio, data.languages, (loaded, total) =>
      parentPort.postMessage({ type: 'progress', id, model, loaded, total })
    );
    parentPort.postMessage({ type: 'result', id, model, language, text });
  } catch (err) {
    parentPort.postMessage({ type: 'error', id, message: err?.message || String(err) });
  }
});
