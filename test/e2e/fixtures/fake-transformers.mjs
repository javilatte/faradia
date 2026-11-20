// A stand-in for transformers.js with the parts whisper-core.mjs uses, for tests: no model download.
// "Whisper" scores Spanish highest when the audio's first sample is negative and English otherwise,
// and says how many samples it heard.

const VOCAB = 51866;
const SOT = 50258;
const LANGS = { '<|en|>': 50259, '<|es|>': 50262, '<|fr|>': 50265 };
const TRANSCRIBE = 50359;
const NO_TIMESTAMPS = 50363;
const TEXT = 1000;

export const env = {};

export class SuppressTokensAtBeginLogitsProcessor {
  constructor(tokens, index) {
    this.tokens = tokens;
    this.index = index;
  }
}

export async function pipeline(_task, model, { progress_callback } = {}) {
  progress_callback?.({ status: 'progress', file: 'model.onnx', loaded: 50, total: 100 });
  progress_callback?.({ status: 'progress', file: 'model.onnx', loaded: 100, total: 100 });
  let heard = 0;
  let firstSample = 0;
  const asr = async (audio, { language }) => ({ text: ` ${language} long ${audio.length}` });
  asr.processor = async (audio) => {
    heard = audio.length;
    firstSample = audio[0];
    return { input_features: { dims: [1, 80, 3000] } };
  };
  asr.model = {
    generation_config: {
      decoder_start_token_id: SOT,
      lang_to_id: LANGS,
      task_to_id: { transcribe: TRANSCRIBE, translate: 50358 },
      no_timestamps_token_id: NO_TIMESTAMPS
    },
    // Greedy decoding through the given logits processors, like transformers.js.
    async generate({ decoder_input_ids, logits_processor = [] }) {
      const seq = decoder_input_ids[0].map(Number);
      for (let step = 0; step < 4; step++) {
        const data = new Float32Array(VOCAB);
        data[LANGS['<|es|>']] = firstSample < 0 ? 2 : 1;
        data[LANGS['<|en|>']] = firstSample < 0 ? 1 : 2;
        data[LANGS['<|fr|>']] = 3; // never a candidate in the tests: it must be ruled out
        data[TRANSCRIBE] = -Infinity; // as Whisper's own suppress list does
        data[TEXT] = step === 3 ? 5 : 0;
        const logits = [{ data }];
        for (const p of logits_processor) p._call([seq.map(BigInt)], logits);
        let best = 0;
        for (let i = 1; i < VOCAB; i++) if (data[i] > data[best]) best = i;
        seq.push(best);
      }
      return { tolist: () => [seq.map(BigInt)] };
    }
  };
  asr.tokenizer = {
    decode: (seq) => {
      const lang = Object.entries(LANGS).find(([, id]) => id === seq[1])?.[0] || '?';
      const ok = seq[2] === TRANSCRIBE && seq[3] === NO_TIMESTAMPS && seq[4] === TEXT;
      return ok ? ` Dictado ${lang.slice(2, -2)} ${model.split('-').pop()} ${heard}` : ` prompt roto ${seq.join(',')}`;
    }
  };
  asr.dispose = async () => {};
  return asr;
}
