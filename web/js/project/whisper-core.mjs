// Whisper for dictation, shared by the browser (voice-worker.js) and Faradia's own engine
// (server/voice/whisperWorker.mjs): the models, and transcription with the language chosen by
// Whisper among the candidates.

// Multilingual Whisper, quantized. large-v3-turbo gets Spanish and English right but needs a GPU in
// the browser, or Faradia's native engine; small and base are lighter and less accurate.
export const MODELS = {
  turbo: { id: 'onnx-community/whisper-large-v3-turbo', dtype: { encoder_model: 'q4', decoder_model_merged: 'q4' } },
  small: { id: 'onnx-community/whisper-small', dtype: 'q8' },
  base: { id: 'onnx-community/whisper-base', dtype: 'q8' }
};

const WINDOW = 30 * 16000; // Whisper hears 30 s at a time

/**
 * Loads a model once and transcribes with it. `lib` is transformers.js (from the CDN or from Faradia's
 * engine); `device` is 'webgpu', 'wasm' or 'cpu'.
 */
export function createTranscriber(lib, { device, cacheDir } = {}) {
  const { pipeline, env, SuppressTokensAtBeginLogitsProcessor } = lib;
  env.allowLocalModels = false;
  if (cacheDir) env.cacheDir = cacheDir;

  // Whisper's prompt is <|startoftranscript|> <|language|> <|transcribe|> <|notimestamps|>.
  // transformers.js does not detect the language (without one it assumes English and translates), so
  // the language token is left to Whisper, among the candidates, in the same pass that transcribes.
  class WhisperPrompt extends SuppressTokensAtBeginLogitsProcessor {
    constructor(start, steps) {
      super([], -1);
      this.start = start;
      this.steps = steps;
    }
    _call(inputIds, logits) {
      for (let i = 0; i < inputIds.length; ++i) {
        const keep = this.steps[inputIds[i].length - this.start];
        if (!keep) continue;
        const row = logits[i].data;
        // A single forced token gets 0: Whisper's suppress list has already set the task tokens to -Infinity.
        const scores = keep.length === 1 ? [0] : keep.map((t) => row[t]);
        row.fill(-Infinity);
        keep.forEach((t, k) => (row[t] = scores[k]));
      }
      return logits;
    }
  }

  let loaded = { name: null, asr: null };

  async function load(name, onProgress) {
    if (loaded.name === name) return loaded.asr;
    const spec = MODELS[name] || MODELS.small;
    const files = new Map();
    const asr = await pipeline('automatic-speech-recognition', spec.id, {
      dtype: spec.dtype,
      device,
      progress_callback: (p) => {
        if (p.status !== 'progress' || !p.total) return;
        files.set(p.file, { loaded: p.loaded, total: p.total });
        let done = 0;
        let total = 0;
        for (const f of files.values()) {
          done += f.loaded;
          total += f.total;
        }
        onProgress?.(done, total);
      }
    });
    if (loaded.asr) await loaded.asr.dispose?.();
    loaded = { name, asr };
    return asr;
  }

  async function window30(asr, audio, codes) {
    const config = asr.model.generation_config;
    const langIds = codes.map((c) => config.lang_to_id[`<|${c}|>`]);
    const { input_features } = await asr.processor(audio);
    const ids = await asr.model.generate({
      inputs: input_features,
      decoder_input_ids: [[config.decoder_start_token_id]],
      logits_processor: [
        new WhisperPrompt(1, [langIds, [config.task_to_id.transcribe], [config.no_timestamps_token_id]])
      ]
    });
    const seq = Array.from(ids.tolist()[0], Number);
    return {
      language: codes[langIds.indexOf(seq[1])] || codes[0],
      text: asr.tokenizer.decode(seq, { skip_special_tokens: true }).trim()
    };
  }

  /** `languages`: candidate ISO codes ([] or null for any). Returns {language, text}. */
  async function transcribe(name, audio, languages, onProgress) {
    const asr = await load(name, onProgress);
    const known = Object.keys(asr.model.generation_config.lang_to_id).map((t) => t.slice(2, -2));
    const codes = languages?.length ? languages.filter((c) => known.includes(c)) : known;
    if (audio.length <= WINDOW) return window30(asr, audio, codes.length ? codes : known);
    // Longer than 30 s: the language of the first 30 s, then the pipeline's chunking.
    const { language } = await window30(asr, audio.subarray(0, WINDOW), codes.length ? codes : known);
    const out = await asr(audio, { language, task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 });
    return { language, text: (out?.text || '').trim() };
  }

  return { transcribe };
}
