'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// macOS's own speech recognition for dictation (the Speech framework, on the device): no download
// and no model, and it runs on Apple's chips. The helper (apple/transcribe.swift) is a small app,
// Faradia.app, that comes already built in Faradia's npm package: CI compiles it on macOS when
// publishing (scripts/build-apple-voice.sh), so nobody compiles anything. Faradia opens it with `open`
// so that macOS treats it as an app of its own: it asks permission for Faradia once (it would not ask a
// program Faradia started, and would kill it instead). Without the helper (a git checkout that did not
// build it) or without permission, dictation uses Faradia's Whisper (localEngine.js).

const HELPER = path.join(__dirname, 'apple', 'bin', 'Faradia.app');
const OPEN = '/usr/bin/open';

// Whisper's language codes to the locales Apple recognizes on the device.
const LOCALES = { es: 'es-ES', en: 'en-US', ca: 'ca-ES', pt: 'pt-BR', fr: 'fr-FR', it: 'it-IT', de: 'de-DE' };

const MESSAGES = {
  denied:
    'macOS no da permiso de reconocimiento de voz: actívalo para Faradia en Ajustes del Sistema › Privacidad y seguridad › Reconocimiento de voz',
  restricted: 'el reconocimiento de voz está restringido en este Mac',
  missing:
    'esta instalación de Faradia no trae el reconocimiento de voz de macOS (npm run build:apple-voice lo compila)'
};

/** Samples (16 kHz mono) as a 16-bit PCM WAV. */
function encodeWav(samples) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2);
  }
  return buf;
}

function run(exec, command, args, opts) {
  return new Promise((resolve) => {
    exec(command, args, opts, (err, stdout, stderr) =>
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') })
    );
  });
}

/**
 * The Apple engine. `platform`, `exec` and `helper` can be replaced in tests. state: 'unknown' (not
 * tried yet), 'ready', 'denied' or 'unavailable'.
 */
function createAppleEngine({ platform = process.platform, exec = execFile, helper = HELPER } = {}) {
  const supported = platform === 'darwin';
  const state = { state: 'unknown', message: null };
  if (supported && !fs.existsSync(path.join(helper, 'Contents', 'MacOS', 'faradia-transcribe')))
    Object.assign(state, { state: 'unavailable', message: MESSAGES.missing });

  /** Whether it is worth trying for these languages (Apple does not detect "any" language). */
  function usable(languages) {
    if (!supported || state.state === 'denied' || state.state === 'unavailable') return false;
    return Boolean(languages?.length) && languages.every((l) => LOCALES[l]);
  }

  async function transcribe(audio, languages) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `faradia-dictado-${process.pid}-`));
    const wav = path.join(dir, 'recording.wav');
    const outFile = path.join(dir, 'out.json');
    const errFile = path.join(dir, 'err.txt');
    fs.writeFileSync(wav, encodeWav(audio));
    let out;
    try {
      // -W waits for it to finish, -n opens a new instance each time, -g leaves it in the background.
      const args = ['-W', '-n', '-g', '--stdout', outFile, '--stderr', errFile, helper, '--args', wav];
      const result = await run(exec, OPEN, [...args, languages.map((l) => LOCALES[l]).join(',')], {
        timeout: 240_000
      });
      const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
      out = { ...result, stdout: read(outFile), stderr: read(errFile) || result.stderr };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    let answer = null;
    try {
      answer = JSON.parse(out.stdout.trim().split('\n').pop());
    } catch {
      /* it did not answer: below */
    }
    if (answer?.ok) {
      // A language Apple could not use (its on-device model is not downloaded, say) is said in Settings.
      const skipped = (answer.skipped || []).map((x) => `${x.locale}: ${x.message}`).join('; ');
      Object.assign(state, { state: 'ready', message: skipped || null });
      const language = Object.keys(LOCALES).find((k) => LOCALES[k] === answer.locale) || languages[0];
      return { text: String(answer.text || '').trim(), language, model: 'apple' };
    }
    const code = answer?.code || 'failed';
    const message =
      MESSAGES[code] ||
      answer?.message ||
      `el reconocimiento de voz de macOS falló: ${(out.stderr || out.err?.message || '').trim() || 'sin respuesta'}`;
    // Without permission it would fail every time; other errors (a busy recognizer) may pass.
    if (code === 'denied' || code === 'restricted') state.state = 'denied';
    // No answer at all: macOS could not open it or killed it, and that would happen on every
    // dictation, so Whisper from now on.
    else if (!answer) state.state = 'unavailable';
    state.message = message;
    throw Object.assign(new Error(message), { code });
  }

  function status() {
    return { supported, state: state.state, message: state.message };
  }

  return { usable, transcribe, status };
}

module.exports = { createAppleEngine, encodeWav, LOCALES, HELPER };
