'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Worker } = require('worker_threads');
const { dataDir } = require('../store/globalPaths');
const { createAppleEngine } = require('./appleEngine');

// Faradia's own dictation engine: the same Whisper models as the browser, run natively by
// onnxruntime-node on every CPU core (three times faster than WebAssembly), for computers without a
// GPU the browser can use. It is not part of Faradia's package: the first dictation that needs it
// installs it into the data folder (about 110 MB once pruned), and the browser transcribes meanwhile.
// Nothing leaves the computer except that download and the model's, like in the browser.

const ENGINE_PACKAGE = '@huggingface/transformers@4.3.2';
const MODEL_SIZE = { turbo: '760 MB', small: '250 MB', base: '77 MB' };

const voiceDir = () => path.join(dataDir(), 'voice');
const engineDir = () => path.join(voiceDir(), 'engine');
const modelsDir = () => path.join(voiceDir(), 'models');
const readyFile = () => path.join(engineDir(), 'ready.json');

// Tests point this at a fake library with the same interface (test/e2e/fixtures).
function engineEntry() {
  return (
    process.env.FARADIA_VOICE_ENGINE_MODULE ||
    path.join(engineDir(), 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.node.mjs')
  );
}

function isInstalled() {
  if (process.env.FARADIA_VOICE_ENGINE_MODULE) return fs.existsSync(process.env.FARADIA_VOICE_ENGINE_MODULE);
  return fs.existsSync(readyFile()) && fs.existsSync(engineEntry());
}

// turbo (large-v3-turbo) gets Spanish and English right and, natively, takes about as long as the
// speech with 8 threads; with fewer, small keeps the wait short.
function resolveModel(model, threads = os.availableParallelism()) {
  if (MODEL_SIZE[model]) return model;
  return threads >= 8 ? 'turbo' : 'small';
}

const state = { installing: null, error: null, job: null };

// On macOS, Apple's own recognizer goes first (appleEngine.js); Whisper when it cannot.
const apple = createAppleEngine();

// npm next to the node running Faradia (it comes with Node), else the one in PATH.
// npm's own script run by the node running Faradia, so it works even when that node is not in PATH
// (npm's launcher starts with "#!/usr/bin/env node"). Layouts: <prefix>/lib/node_modules/npm on
// Unix, <prefix>/node_modules/npm on Windows; else the npm in PATH.
function npmCommand() {
  const bin = path.dirname(process.execPath);
  for (const cli of [
    path.join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  ]) {
    if (fs.existsSync(cli)) return { command: process.execPath, args: [cli], shell: false };
  }
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: [], shell: process.platform === 'win32' };
}

// onnxruntime-node ships binaries for every system; only this one's is kept. The WebAssembly build
// that comes along is for browsers.
function pruneEngine(dir = engineDir()) {
  const modules = path.join(dir, 'node_modules');
  const napi = path.join(modules, 'onnxruntime-node', 'bin', 'napi-v6');
  for (const platform of safeList(napi)) {
    for (const arch of safeList(path.join(napi, platform))) {
      if (platform !== process.platform || arch !== process.arch) {
        fs.rmSync(path.join(napi, platform, arch), { recursive: true, force: true });
      }
    }
  }
  fs.rmSync(path.join(modules, 'onnxruntime-web', 'dist'), { recursive: true, force: true });
}

function safeList(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Installs the engine once; later calls while it runs get the same promise. */
function install({ spawnImpl = spawn } = {}) {
  if (isInstalled()) return Promise.resolve();
  if (state.installing) return state.installing;
  state.error = null;
  state.installing = new Promise((resolve, reject) => {
    const dir = engineDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'faradia-voice-engine', private: true }));
    const npm = npmCommand();
    const child = spawnImpl(
      npm.command,
      [...npm.args, 'install', '--no-audit', '--no-fund', '--no-save', ENGINE_PACKAGE],
      {
        cwd: dir,
        env: {
          ...process.env,
          // Install scripts of the dependencies run with this same node.
          PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter),
          // The CUDA binaries (260 MB) are not needed: Faradia runs Whisper on the CPU here.
          ONNXRUNTIME_NODE_INSTALL: 'skip'
        },
        stdio: ['ignore', 'ignore', 'pipe'],
        shell: npm.shell
      }
    );
    let stderr = '';
    child.stderr?.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    child.on('error', (err) => reject(new Error(`no se pudo ejecutar npm: ${err.message}`)));
    child.on('exit', (code) => {
      if (code !== 0)
        return reject(new Error(`npm terminó con código ${code}: ${stderr.trim().split('\n').pop() || ''}`));
      try {
        pruneEngine(dir);
        fs.writeFileSync(readyFile(), JSON.stringify({ package: ENGINE_PACKAGE, at: new Date().toISOString() }));
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  })
    .catch((err) => {
      state.error = err.message;
      throw err;
    })
    .finally(() => {
      state.installing = null;
    });
  return state.installing;
}

function status() {
  return {
    installed: isInstalled(),
    installing: Boolean(state.installing),
    error: state.error,
    threads: os.availableParallelism(),
    model: resolveModel('auto'),
    job: state.job,
    apple: apple.status()
  };
}

// One worker thread keeps the model loaded between dictations; jobs run one after another.
let worker = null;
const pending = new Map();
let nextId = 1;
let queue = Promise.resolve();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(path.join(__dirname, 'whisperWorker.mjs'), {
    workerData: { entry: engineEntry(), modelsDir: modelsDir() }
  });
  worker.on('message', (msg) => {
    const job = pending.get(msg.id);
    if (!job) return;
    if (msg.type === 'progress') {
      state.job = {
        phase: 'model',
        model: msg.model,
        size: MODEL_SIZE[msg.model],
        loaded: msg.loaded,
        total: msg.total
      };
      return;
    }
    pending.delete(msg.id);
    state.job = null;
    if (msg.type === 'result') job.resolve({ text: msg.text, language: msg.language, model: msg.model });
    else job.reject(new Error(msg.message));
  });
  worker.on('error', (err) => failAll(err));
  worker.on('exit', (code) => {
    worker = null;
    if (code !== 0) failAll(new Error(`el motor de voz se cerró (código ${code})`));
  });
  worker.unref();
  return worker;
}

function failAll(err) {
  state.job = null;
  for (const job of pending.values()) job.reject(err);
  pending.clear();
}

/**
 * Transcribes 16 kHz mono samples. `languages`: candidate ISO codes, or null for any. `engine`:
 * 'auto' (Apple's on macOS, else Whisper) or 'whisper'.
 */
async function transcribe(
  audio,
  { model = 'auto', languages = ['es', 'en'], engine = 'auto', appleEngine = apple } = {}
) {
  if (engine !== 'whisper' && appleEngine.usable(languages)) {
    state.job = { phase: 'apple' };
    try {
      return await appleEngine.transcribe(audio, languages);
    } catch {
      /* why is in appleEngine.status(): Whisper takes over */
    } finally {
      state.job = null;
    }
  }
  return transcribeWithWhisper(audio, { model, languages });
}

function transcribeWithWhisper(audio, { model, languages }) {
  if (!isInstalled())
    return Promise.reject(Object.assign(new Error('el motor de voz no está instalado'), { status: 409 }));
  const run = () =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      state.job = { phase: 'transcribe' };
      getWorker().postMessage({ type: 'transcribe', id, audio, model: resolveModel(model), languages });
    });
  const job = queue.then(run, run);
  queue = job.catch(() => {});
  return job;
}

module.exports = { install, status, transcribe, isInstalled, resolveModel, pruneEngine, engineDir, MODEL_SIZE };
