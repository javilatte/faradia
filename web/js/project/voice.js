'use strict';

// Dictation in the chat: the microphone button records, Whisper transcribes and the text lands in the
// message box where the cursor was. It is never sent on its own: the user reads it and sends it.
// Whisper runs in this browser (voice-worker.js): the audio never leaves the machine, and there is no
// account, API or cost. Only the model is downloaded once, and the browser keeps it.

const voiceButton = document.getElementById('voice-button');
const voiceStatus = document.getElementById('voice-status');

const VOICE_MODEL_SIZE = { turbo: '760 MB', small: '250 MB', base: '77 MB' };
const VOICE_READY_KEY = 'faradia:voice-ready';
const VOICE_MAX_SECONDS = 5 * 60;
const VOICE_SAMPLE_RATE = 16000;
// Whisper's usual output on silence or noise: "[Música]", "(risas)", "[BLANK_AUDIO]".
const VOICE_NOISE_RE = /^\s*[[(][^\])]*[\])]\s*$/;

const voice = {
  state: 'idle', // idle | starting | recording | working
  stream: null,
  recorder: null,
  chunks: [],
  audioContext: null,
  meterFrame: 0,
  timer: 0,
  startedAt: 0,
  cancelled: false,
  worker: null,
  jobs: new Map(),
  nextJob: 1,
  hideTimer: 0
};

async function voiceSettings() {
  const s = await fetch(apiPath('/api/settings'))
    .then((r) => r.json())
    .catch(() => null);
  return s?.voice || { enabled: true, model: 'auto', language: 'es-en' };
}

// The languages Whisper chooses from: it detects which one is spoken among them.
function voiceLanguages(setting) {
  if (setting === 'detect') return null;
  if (setting === 'es-en' || !setting) return ['es', 'en'];
  return [setting];
}

// Models this browser already downloaded: loading them again is "Preparando", not "Descargando".
function readyModels() {
  try {
    return JSON.parse(localStorage.getItem(VOICE_READY_KEY) || '[]');
  } catch {
    return [];
  }
}
function markModelReady(model) {
  try {
    localStorage.setItem(VOICE_READY_KEY, JSON.stringify([...new Set([...readyModels(), model])]));
  } catch {
    /* no persistence: it says "Descargando" again */
  }
}

function showVoiceStatus(text, { kind = 'info', autoHide = false } = {}) {
  clearTimeout(voice.hideTimer);
  voiceStatus.textContent = text;
  voiceStatus.dataset.kind = kind;
  voiceStatus.hidden = !text;
  if (autoHide) voice.hideTimer = setTimeout(() => (voiceStatus.hidden = true), 6000);
}

function setVoiceState(state) {
  voice.state = state;
  voiceButton.dataset.state = state;
  const label =
    state === 'recording'
      ? 'Terminar el dictado'
      : state === 'working'
        ? 'Transcribiendo…'
        : 'Dictar un mensaje (el audio no sale de tu equipo)';
  voiceButton.title = label;
  voiceButton.setAttribute('aria-label', state === 'recording' ? 'Terminar el dictado' : 'Dictar');
  voiceButton.setAttribute('aria-pressed', String(state === 'recording'));
  voiceButton.disabled = state === 'working' || state === 'starting';
}

const formatClock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function micErrorText(err) {
  if (!navigator.mediaDevices?.getUserMedia) return 'Este navegador no deja usar el micrófono aquí';
  if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') {
    return 'Sin permiso para usar el micrófono: permítelo en el candado de la barra de direcciones';
  }
  if (err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError') return 'No se encontró ningún micrófono';
  if (err?.name === 'NotReadableError') return 'Otra aplicación está usando el micrófono';
  return `No se pudo abrir el micrófono: ${err?.message || err}`;
}

async function startDictation() {
  if (voice.state !== 'idle') return;
  setVoiceState('starting');
  try {
    voice.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  } catch (err) {
    setVoiceState('idle');
    showVoiceStatus(micErrorText(err), { kind: 'error', autoHide: true });
    return;
  }
  voice.chunks = [];
  voice.cancelled = false;
  voice.recorder = new MediaRecorder(voice.stream);
  voice.recorder.addEventListener('dataavailable', (e) => e.data.size && voice.chunks.push(e.data));
  voice.recorder.addEventListener('stop', finishDictation);
  voice.recorder.start(250);
  voice.startedAt = Date.now();
  setVoiceState('recording');
  startMeter();
  const tick = () => {
    const seconds = (Date.now() - voice.startedAt) / 1000;
    showVoiceStatus(`Escuchando · ${formatClock(seconds)} · pulsa el micrófono para terminar o Esc para cancelar`, {
      kind: 'recording'
    });
    if (seconds >= VOICE_MAX_SECONDS) stopDictation();
  };
  tick();
  voice.timer = setInterval(tick, 500);
}

// The button's ring follows the voice level, so it is clear the microphone hears something.
function startMeter() {
  try {
    voice.audioContext = new AudioContext();
    const analyser = voice.audioContext.createAnalyser();
    analyser.fftSize = 512;
    voice.audioContext.createMediaStreamSource(voice.stream).connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    const draw = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += ((v - 128) / 128) ** 2;
      const level = Math.min(1, Math.sqrt(sum / data.length) * 6);
      voiceButton.style.setProperty('--voice-level', level.toFixed(3));
      voice.meterFrame = requestAnimationFrame(draw);
    };
    draw();
  } catch {
    /* no meter: recording still works */
  }
}

function releaseMic() {
  clearInterval(voice.timer);
  cancelAnimationFrame(voice.meterFrame);
  voiceButton.style.removeProperty('--voice-level');
  voice.audioContext?.close().catch(() => {});
  voice.audioContext = null;
  for (const track of voice.stream?.getTracks() || []) track.stop();
  voice.stream = null;
}

function stopDictation({ cancel = false } = {}) {
  if (voice.state !== 'recording') return;
  voice.cancelled = cancel;
  releaseMic();
  if (voice.recorder.state !== 'inactive') voice.recorder.stop();
}

async function finishDictation() {
  const blob = new Blob(voice.chunks, { type: voice.recorder?.mimeType || 'audio/webm' });
  voice.recorder = null;
  voice.chunks = [];
  if (voice.cancelled) {
    setVoiceState('idle');
    showVoiceStatus('');
    input.focus();
    return;
  }
  setVoiceState('working');
  showVoiceStatus('Transcribiendo…', { kind: 'working' });
  try {
    const audio = await decodeTo16k(blob);
    if (isSilent(audio)) {
      showVoiceStatus('No se oyó nada: comprueba el micrófono e inténtalo otra vez', { kind: 'error', autoHide: true });
      return;
    }
    const settings = await voiceSettings();
    const { text: raw, note } = await transcribeWhereBest(audio, settings);
    const text = cleanVoiceText(raw);
    if (!text) {
      showVoiceStatus('No se entendió nada: prueba a hablar más cerca del micrófono', {
        kind: 'error',
        autoHide: true
      });
      return;
    }
    insertDictation(text);
    showVoiceStatus(note || '', { autoHide: Boolean(note) });
  } catch (err) {
    showVoiceStatus(`No se pudo transcribir: ${err.message || err}`, { kind: 'error', autoHide: true });
  } finally {
    setVoiceState('idle');
  }
}

async function decodeTo16k(blob) {
  const ctx = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE });
  try {
    const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
    if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
    const out = new Float32Array(buffer.length);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const ch = buffer.getChannelData(c);
      for (let i = 0; i < out.length; i++) out[i] += ch[i] / buffer.numberOfChannels;
    }
    return out;
  } finally {
    ctx.close().catch(() => {});
  }
}

// Under half a second of audio, or no sample loud enough to be a voice.
function isSilent(audio) {
  if (audio.length < VOICE_SAMPLE_RATE / 2) return true;
  let peak = 0;
  for (let i = 0; i < audio.length; i += 4) peak = Math.max(peak, Math.abs(audio[i]));
  return peak < 0.01;
}

function cleanVoiceText(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !VOICE_NOISE_RE.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function voiceWorker() {
  if (voice.worker) return voice.worker;
  voice.worker = new Worker('js/project/voice-worker.js', { type: 'module' });
  voice.worker.addEventListener('message', ({ data }) => {
    const job = voice.jobs.get(data.id);
    if (!job) return;
    if (data.type === 'progress') return job.progress(data.model, data.loaded, data.total);
    voice.jobs.delete(data.id);
    if (data.type === 'result') {
      markModelReady(data.model);
      job.resolve(data.text);
    } else job.reject(new Error(data.message));
  });
  voice.worker.addEventListener('error', (e) => {
    for (const job of voice.jobs.values())
      job.reject(new Error(e.message || 'no se pudo cargar el reconocedor de voz'));
    voice.jobs.clear();
    voice.worker = null;
  });
  return voice.worker;
}

function transcribeInBrowser(audio, model, languages) {
  return new Promise((resolve, reject) => {
    const id = voice.nextJob++;
    const progress = (loadedModel, loaded, total) => {
      const pct = total ? Math.floor((loaded / total) * 100) : 0;
      let text = 'Transcribiendo…';
      if (pct < 100 && readyModels().includes(loadedModel)) text = `Preparando el modelo de voz… ${pct} %`;
      else if (pct < 100) {
        const size = VOICE_MODEL_SIZE[loadedModel] || VOICE_MODEL_SIZE.small;
        text = `Descargando el modelo de voz (${size}, solo la primera vez)… ${pct} %`;
      }
      showVoiceStatus(text, { kind: 'working' });
    };
    voice.jobs.set(id, { resolve, reject, progress });
    voiceWorker().postMessage({ type: 'transcribe', id, audio, model, languages });
  });
}

// Where Whisper runs: Faradia's own engine, a native process on every core outside the browser
// (server/voice/localEngine.js), the same in Chrome, Firefox or Safari. It installs itself the first
// time; meanwhile, or if it cannot be installed, the browser transcribes. "browser" forces the
// browser (with a GPU it runs large-v3-turbo there).
async function transcribeWhereBest(audio, settings) {
  const languages = voiceLanguages(settings.language);
  if (settings.engine === 'browser') return { text: await transcribeInBrowser(audio, settings.model, languages) };
  const engine = await fetch('/api/voice/status')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  // On a Mac, Apple's recognizer needs no install: worth trying until it says it cannot.
  const apple = engine?.apple;
  const appleMayWork =
    settings.engine !== 'whisper' && apple?.supported && !['denied', 'unavailable'].includes(apple.state);
  if (engine && (engine.installed || appleMayWork)) {
    try {
      return { text: await transcribeLocally(audio, settings.model, languages) };
    } catch (err) {
      if (err.status !== 409) throw err;
      // Neither Apple's nor Whisper (not installed yet): the server is installing Whisper now.
    }
  }
  if (engine && !engine.installing) fetch('/api/voice/install', { method: 'POST' }).catch(() => {});
  // turbo in the browser without a GPU takes a minute: the browser picks (small without one).
  const model = settings.model === 'turbo' ? 'auto' : settings.model;
  return {
    text: await transcribeInBrowser(audio, model, languages),
    note: !engine
      ? ''
      : engine.error
        ? `No se pudo instalar el motor de voz de Faradia (${engine.error}); se transcribe en el navegador`
        : 'Se está instalando el motor de voz de Faradia (solo la primera vez): los próximos dictados irán más rápido y con más precisión'
  };
}

async function transcribeLocally(audio, model, languages) {
  const query = new URLSearchParams({ model: model || 'auto', languages: languages ? languages.join(',') : 'any' });
  const poll = setInterval(async () => {
    const s = await fetch('/api/voice/status')
      .then((r) => r.json())
      .catch(() => null);
    const job = s?.job;
    if (job?.phase !== 'model' || !job.total) return showVoiceStatus('Transcribiendo…', { kind: 'working' });
    const pct = Math.floor((job.loaded / job.total) * 100);
    showVoiceStatus(
      readyModels().includes(`local:${job.model}`)
        ? `Preparando el modelo de voz… ${pct} %`
        : `Descargando el modelo de voz (${job.size}, solo la primera vez)… ${pct} %`,
      { kind: 'working' }
    );
  }, 400);
  try {
    const res = await fetch(`/api/voice/transcribe?${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: audio.slice().buffer
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
    markModelReady(`local:${data.model}`);
    return data.text;
  } finally {
    clearInterval(poll);
  }
}

// At the cursor, with a space on each side when it touches other words.
function insertDictation(text) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  const before = input.value.slice(0, start);
  const after = input.value.slice(end);
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const trail = after && !/^\s/.test(after) ? ' ' : '';
  input.value = before + lead + text + trail + after;
  const caret = (before + lead + text).length;
  input.focus();
  input.setSelectionRange(caret, caret);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

voiceButton.addEventListener('click', () => {
  if (voice.state === 'recording') stopDictation();
  else startDictation();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && voice.state === 'recording') {
    e.preventDefault();
    stopDictation({ cancel: true });
  }
});

// Settings › Dictado: the button disappears when dictation is off.
async function syncVoiceButton() {
  const s = await voiceSettings();
  voiceButton.hidden = s.enabled === false;
}
syncVoiceButton();

// ---- Settings › Dictado ----

const VOICE_FIELDS = {
  enabled: document.getElementById('setting-voice-enabled'),
  engine: document.getElementById('setting-voice-engine'),
  model: document.getElementById('setting-voice-model'),
  language: document.getElementById('setting-voice-language')
};

function renderVoicePane(v) {
  VOICE_FIELDS.enabled.checked = v.enabled !== false;
  for (const key of ['engine', 'model', 'language']) {
    if (document.activeElement !== VOICE_FIELDS[key]) VOICE_FIELDS[key].value = v[key] ?? '';
  }
  const on = VOICE_FIELDS.enabled.checked;
  for (const el of document.querySelectorAll('.voice-only')) el.hidden = !on;
  voiceButton.hidden = !on;
}

async function loadVoicePane() {
  renderVoicePane(await voiceSettings());
  renderVoiceEngineStatus();
}

// Which engine dictation is really using here, and why not Apple's when it cannot.
async function renderVoiceEngineStatus() {
  const el = document.getElementById('voice-engine-status');
  const s = await fetch('/api/voice/status')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  if (!s) return (el.hidden = true);
  const parts = [];
  if (s.apple?.supported) {
    if (s.apple.state === 'ready') parts.push('En este Mac dicta el reconocimiento de voz de macOS, sin conexión.');
    else if (s.apple.state === 'unknown')
      parts.push('En este Mac dictará el reconocimiento de voz de macOS; la primera vez macOS pide permiso.');
    else parts.push(`Se usa Whisper: ${s.apple.message}.`);
  }
  if (s.installed) parts.push(`Whisper está instalado (${s.threads} hilos: modelo ${s.model}).`);
  else if (s.installing) parts.push('Whisper se está instalando…');
  else if (s.error) parts.push(`No se pudo instalar Whisper: ${s.error}`);
  el.textContent = parts.join(' ');
  el.hidden = !parts.length;
}

async function saveVoice(patch) {
  await patchSettings({ scope: 'global', voice: patch });
  renderVoicePane(currentSettings?.voice || (await voiceSettings()));
}

VOICE_FIELDS.enabled.addEventListener('change', () => saveVoice({ enabled: VOICE_FIELDS.enabled.checked }));
for (const key of ['engine', 'model', 'language']) {
  VOICE_FIELDS[key].addEventListener('change', () => saveVoice({ [key]: VOICE_FIELDS[key].value }));
}
document.querySelector('.settings-nav-item[data-pane="voice"]').addEventListener('click', loadVoicePane);
