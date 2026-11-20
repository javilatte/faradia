'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { mkTmpDir, rmTmpDir } = require('./helpers');

const FAKE = path.join(__dirname, '..', 'e2e', 'fixtures', 'fake-transformers.mjs');
const CORE = path.join(__dirname, '..', '..', 'web', 'js', 'project', 'whisper-core.mjs');

const samples = (n, first) => Float32Array.from({ length: n }, (_, i) => (i ? 0.1 : first));

test('Whisper chooses the language among the candidates in the same pass that transcribes', async () => {
  const { createTranscriber } = await import(CORE);
  const lib = await import(FAKE);
  const whisper = createTranscriber(lib, { device: 'cpu' });
  const progress = [];
  // French scores highest but is not a candidate; the task and no-timestamps tokens are forced even
  // though Whisper's suppress list hides the task token.
  const es = await whisper.transcribe('small', samples(16000, -0.5), ['es', 'en'], (l, t) => progress.push([l, t]));
  assert.deepEqual(es, { language: 'es', text: 'Dictado es small 16000' });
  assert.deepEqual(progress.at(-1), [100, 100]);
  const en = await whisper.transcribe('small', samples(16000, 0.5), ['es', 'en']);
  assert.deepEqual(en, { language: 'en', text: 'Dictado en small 16000' });
  // A single language is used as is; with no candidates any language can win.
  assert.equal((await whisper.transcribe('small', samples(16000, 0.5), ['es'])).language, 'es');
  assert.equal((await whisper.transcribe('small', samples(16000, 0.5), null)).language, 'fr');
});

test('a recording longer than 30 s takes its language from the first 30 s and is chunked', async () => {
  const { createTranscriber } = await import(CORE);
  const whisper = createTranscriber(await import(FAKE), { device: 'cpu' });
  const out = await whisper.transcribe('turbo', samples(16000 * 45, -0.5), ['es', 'en']);
  assert.deepEqual(out, { language: 'es', text: 'es long 720000' });
});

test('the local engine picks turbo with 8 threads or more and small with fewer', () => {
  const { resolveModel } = require('../../server/voice/localEngine');
  assert.equal(resolveModel('auto', 12), 'turbo');
  assert.equal(resolveModel('auto', 8), 'turbo');
  assert.equal(resolveModel('auto', 4), 'small');
  assert.equal(resolveModel('base', 16), 'base');
  assert.equal(resolveModel('nonsense', 4), 'small');
});

test('installing the engine runs npm with this node, skips CUDA and keeps only this system binaries', async (t) => {
  const data = mkTmpDir('voice-engine');
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = data;
  t.after(() => {
    process.env.XDG_DATA_HOME = prev;
    rmTmpDir(data);
  });
  const engine = require('../../server/voice/localEngine');
  const calls = [];
  const fakeSpawn = (command, args, opts) => {
    calls.push({ command, args, opts });
    // What npm would leave: transformers.js and onnxruntime-node with every system's binaries.
    const mods = path.join(opts.cwd, 'node_modules');
    const entry = path.join(mods, '@huggingface', 'transformers', 'dist', 'transformers.node.mjs');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, '');
    for (const target of [
      'linux/x64',
      'linux/arm64',
      'darwin/arm64',
      'win32/x64',
      `${process.platform}/${process.arch}`
    ]) {
      fs.mkdirSync(path.join(mods, 'onnxruntime-node', 'bin', 'napi-v6', target), { recursive: true });
    }
    fs.mkdirSync(path.join(mods, 'onnxruntime-web', 'dist'), { recursive: true });
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => child.emit('exit', 0));
    return child;
  };
  assert.equal(engine.status().installed, false);
  const first = engine.install({ spawnImpl: fakeSpawn });
  assert.equal(engine.status().installing, true);
  const again = engine.install({ spawnImpl: fakeSpawn });
  await Promise.all([first, again]);
  assert.equal(calls.length, 1, 'a second request while installing reuses the first');
  const call = calls[0];
  assert.equal(call.command === process.execPath || /npm/.test(call.command), true);
  assert.ok(call.args.includes('@huggingface/transformers@4.3.2'));
  assert.equal(call.opts.env.ONNXRUNTIME_NODE_INSTALL, 'skip');
  assert.ok(call.opts.env.PATH.startsWith(path.dirname(process.execPath)));
  const napi = path.join(engine.engineDir(), 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6');
  const left = fs
    .readdirSync(napi)
    .flatMap((p) => fs.readdirSync(path.join(napi, p)).map((a) => `${p}/${a}`))
    .sort();
  assert.deepEqual(left, [`${process.platform}/${process.arch}`]);
  assert.equal(fs.existsSync(path.join(engine.engineDir(), 'node_modules', 'onnxruntime-web', 'dist')), false);
  assert.equal(engine.status().installed, true);
});

test('a failed install is reported and can be retried', async (t) => {
  const data = mkTmpDir('voice-engine-fail');
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = data;
  t.after(() => {
    process.env.XDG_DATA_HOME = prev;
    rmTmpDir(data);
  });
  const engine = require('../../server/voice/localEngine');
  const failing = () => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      child.stderr.emit('data', 'npm error network ENOTFOUND registry.npmjs.org\n');
      child.emit('exit', 1);
    });
    return child;
  };
  await assert.rejects(engine.install({ spawnImpl: failing }), /código 1: npm error network ENOTFOUND/);
  assert.match(engine.status().error, /ENOTFOUND/);
  assert.equal(engine.status().installing, false);
});

test('the transcribe route reads Float32 samples and the candidate languages', async () => {
  const { parseLanguages } = require('../../server/http/voiceRoutes');
  assert.deepEqual(parseLanguages('es,en'), ['es', 'en']);
  assert.equal(parseLanguages('any'), null);
  assert.deepEqual(parseLanguages('es,<script>'), ['es']);
  assert.deepEqual(parseLanguages('???'), ['es', 'en']);
});

// ---- macOS speech recognition (appleEngine.js), with a fake helper ----

function appleWith(t, reply, { platform = 'darwin', missing = false } = {}) {
  const { createAppleEngine } = require('../../server/voice/appleEngine');
  const dir = mkTmpDir('apple-helper');
  t.after(() => rmTmpDir(dir));
  const helper = path.join(dir, 'faradia-transcribe');
  if (!missing) fs.writeFileSync(helper, '');
  const calls = [];
  const exec = (command, args, _opts, cb) => {
    const wav = fs.readFileSync(args[0]);
    calls.push({ command, args, header: wav.subarray(0, 4).toString(), dataBytes: wav.readUInt32LE(40) });
    const r = typeof reply === 'function' ? reply(args) : reply;
    setImmediate(() => cb(r.err || null, r.stdout || '', r.stderr || ''));
  };
  return { apple: createAppleEngine({ platform, exec, helper }), calls, helper };
}

test("Apple's recognizer gets the recording as WAV with the candidate locales and says which won", async (t) => {
  const { apple, calls, helper } = appleWith(t, {
    stdout: '{"ok":true,"text":"Añade un test para el login","locale":"es-ES","confidence":0.91}\n'
  });
  assert.equal(apple.status().state, 'unknown');
  assert.equal(apple.usable(['es', 'en']), true);
  const out = await apple.transcribe(new Float32Array(16000).fill(0.2), ['es', 'en']);
  assert.deepEqual(out, { text: 'Añade un test para el login', language: 'es', model: 'apple' });
  assert.equal(calls[0].command, helper);
  assert.equal(calls[0].args[1], 'es-ES,en-US');
  assert.equal(calls[0].header, 'RIFF');
  assert.equal(calls[0].dataBytes, 32000, '16-bit samples');
  assert.equal(fs.existsSync(calls[0].args[0]), false, 'the recording is deleted afterwards');
  assert.equal(apple.status().state, 'ready');
});

test("Apple's recognizer is only tried where it can work", (t) => {
  assert.equal(appleWith(t, {}, { platform: 'linux' }).apple.usable(['es']), false);
  const { apple } = appleWith(t, {});
  assert.equal(apple.usable(null), false, 'it cannot detect any language');
  assert.equal(apple.usable(['eu']), false, 'Basque has no on-device recognizer');
  const missing = appleWith(t, {}, { missing: true }).apple;
  assert.equal(missing.usable(['es']), false);
  assert.match(missing.status().message, /no trae el reconocimiento de voz de macOS/);
});

test('without permission it says where to give it and stops trying', async (t) => {
  const { apple } = appleWith(t, { stdout: '{"ok":false,"code":"denied","message":"x"}', err: new Error('exit 1') });
  await assert.rejects(
    apple.transcribe(new Float32Array(8000), ['es']),
    /Privacidad y seguridad › Reconocimiento de voz/
  );
  assert.equal(apple.status().state, 'denied');
  assert.equal(apple.usable(['es']), false);
});

test('a helper that macOS kills is not tried again', async (t) => {
  const killed = Object.assign(new Error('Command failed'), { signal: 'SIGABRT', code: null });
  const { apple, calls } = appleWith(t, { err: killed });
  await assert.rejects(apple.transcribe(new Float32Array(8000), ['es']), /falló/);
  assert.equal(apple.status().state, 'unavailable');
  assert.equal(apple.usable(['es']), false);
  assert.equal(calls.length, 1);
});

test("the engine uses Apple's recognizer on a Mac and Whisper when it fails", async (t) => {
  const data = mkTmpDir('voice-apple-fallback');
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = data;
  t.after(() => {
    process.env.XDG_DATA_HOME = prev;
    rmTmpDir(data);
  });
  const engine = require('../../server/voice/localEngine');
  const ok = { usable: () => true, transcribe: async () => ({ text: 'hola', language: 'es', model: 'apple' }) };
  assert.deepEqual(await engine.transcribe(new Float32Array(10), { appleEngine: ok }), {
    text: 'hola',
    language: 'es',
    model: 'apple'
  });
  const failing = {
    usable: () => true,
    transcribe: async () => {
      throw new Error('busy');
    }
  };
  // Whisper is not installed here: the browser will transcribe (409) while it installs.
  await assert.rejects(engine.transcribe(new Float32Array(10), { appleEngine: failing }), (err) => err.status === 409);
  // "whisper" skips Apple's recognizer.
  let tried = false;
  const spy = { usable: () => true, transcribe: async () => (tried = true) };
  await assert.rejects(engine.transcribe(new Float32Array(10), { appleEngine: spy, engine: 'whisper' }));
  assert.equal(tried, false);
});
