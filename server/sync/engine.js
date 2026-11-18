'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { configDir } = require('../store/globalPaths');
const { globalSettingsPath } = require('../store/settingsStore');
const catalog = require('../agents/catalog');
const portable = require('../config/portable');
const envelope = require('./envelope');
const targets = require('./targets');
const google = require('./google');

// Keeps optimia's global configuration (settings, keys, agents, stages, notices: what
// portable.exportConfig gathers) the same on every computer of the user. Every few minutes, and
// after a change, it compares three things: this computer's configuration, the copy in the target
// and what both looked like after the last sync.
//   only this computer changed   → upload
//   only the copy changed        → apply it here (import makes a backup first)
//   both changed                 → the newest wins; the other is kept in ~/.config/optimia/backups
// Repos, workbenches and tasks stay on each computer: they depend on its paths.

const INTERVAL = 3 * 60 * 1000;
const DEBOUNCE = 4000;

function stateFile() {
  return path.join(configDir(), 'sync.json');
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return {};
  }
}

// It holds the passphrase and the Google token: readable only by the user.
function saveState(state) {
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(stateFile(), 0o600);
  } catch {
    /* not supported here */
  }
}

function localSnapshot() {
  const config = portable.exportConfig({ includeSecrets: true });
  const { exportedAt, optimiaVersion, ...content } = config;
  const hash = crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex');
  return { config, hash };
}

// When this computer's configuration last changed: the newest of its files.
function localModifiedAt() {
  const files = [globalSettingsPath(), path.join(configDir(), 'preferences.json')];
  try {
    const dir = catalog.globalAgentsDir();
    for (const n of fs.readdirSync(dir)) files.push(path.join(dir, n));
  } catch {
    /* no global agents */
  }
  let newest = 0;
  for (const f of files) {
    try {
      newest = Math.max(newest, fs.statSync(f).mtimeMs);
    } catch {
      /* missing */
    }
  }
  return Math.floor(newest); // updatedAt has whole milliseconds
}

const stampOf = (remote) => (remote ? `${remote.updatedAt}|${remote.machineId}` : null);

function keepCopy(config, why) {
  const dir = path.join(configDir(), 'backups', `${new Date().toISOString().replace(/[:.]/g, '-')}-${why}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'optimia-config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

function createSync({ fetcher = fetch, log = () => {}, onChange = () => {} } = {}) {
  let state = loadState();
  let timer = null;
  let soon = null;
  let running = null;

  function targetOf(t = state.target) {
    if (!t) return null;
    if (t.kind === 'folder') return targets.folderTarget(t.path);
    if (t.kind === 'google') {
      return targets.googleTarget({ auth: google.accessTokens(t.refreshToken, fetcher), email: t.email, fetcher });
    }
    return null;
  }

  function status() {
    const t = state.target;
    return {
      enabled: Boolean(t),
      kind: t?.kind || null,
      label: t ? (t.kind === 'folder' ? t.path : t.email || 'Google Drive') : null,
      machine: os.hostname(),
      lastSyncAt: state.lastSyncAt || null,
      lastAction: state.lastAction || null,
      lastError: state.lastError || null,
      googleAvailable: Boolean(google.client())
    };
  }

  function record(patch) {
    state = { ...state, ...patch };
    saveState(state);
    onChange(status());
  }

  async function push(target, local) {
    const updatedAt = new Date().toISOString();
    if (!state.machineId) state.machineId = crypto.randomUUID();
    const sealed = envelope.seal(local.config, state.passphrase, {
      updatedAt,
      machine: os.hostname().slice(0, 60),
      machineId: state.machineId
    });
    await target.write(sealed);
    return { lastHash: local.hash, lastRemoteStamp: stampOf(sealed) };
  }

  function pull(remote, config) {
    portable.importConfig(config);
    return { lastHash: localSnapshot().hash, lastRemoteStamp: stampOf(remote) };
  }

  /** One pass. Returns what it did: 'up', 'down', 'none', or 'conflict-up'/'conflict-down'. */
  async function syncOnce() {
    const target = targetOf();
    if (!target) return 'none';
    const local = localSnapshot();
    const remote = await target.read();
    let action = 'none';
    let next = {};
    if (!remote) {
      next = await push(target, local);
      action = 'up';
    } else {
      const remoteChanged = stampOf(remote) !== state.lastRemoteStamp;
      const localChanged = local.hash !== state.lastHash;
      if (remoteChanged) {
        const config = envelope.open(remote, state.passphrase);
        const remoteHash = (() => {
          const { exportedAt, optimiaVersion, ...content } = config;
          return crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex');
        })();
        if (remoteHash === local.hash) {
          next = { lastHash: local.hash, lastRemoteStamp: stampOf(remote) };
        } else if (!localChanged || !state.lastHash) {
          next = pull(remote, config);
          action = 'down';
        } else if (Date.parse(remote.updatedAt) >= localModifiedAt()) {
          next = pull(remote, config);
          action = 'conflict-down';
        } else {
          keepCopy(config, 'sync-remote');
          next = await push(target, local);
          action = 'conflict-up';
        }
      } else if (localChanged) {
        next = await push(target, local);
        action = 'up';
      }
    }
    record({
      ...next,
      lastSyncAt: new Date().toISOString(),
      ...(action !== 'none' ? { lastAction: action } : {}),
      lastError: null
    });
    if (action !== 'none') log('sync.done', { action, kind: state.target.kind });
    return action;
  }

  function run() {
    if (!running) {
      running = syncOnce()
        .catch((err) => {
          record({ lastError: err.message });
          log('sync.failed', { error: err.message });
          throw err;
        })
        .finally(() => {
          running = null;
        });
    }
    return running;
  }

  /** Connects a target. If it already holds a copy, the passphrase must open it and it is applied here. */
  async function connect(targetConfig, passphrase) {
    envelope.checkPassphrase(passphrase);
    const target = targetOf(targetConfig);
    const remote = await target.read();
    if (remote) envelope.open(remote, passphrase);
    // A new target starts from scratch: whatever is there wins over this computer, which is backed up.
    record({ target: targetConfig, passphrase, lastHash: null, lastRemoteStamp: null, lastError: null });
    const action = await run();
    start();
    return { action, existing: Boolean(remote) };
  }

  async function disconnect({ wipe = false } = {}) {
    const target = targetOf();
    if (wipe && target) await target.remove();
    if (state.target?.kind === 'google') await google.revoke(state.target.refreshToken, fetcher);
    stop();
    record({
      target: null,
      passphrase: null,
      lastHash: null,
      lastRemoteStamp: null,
      lastSyncAt: null,
      lastAction: null,
      lastError: null
    });
  }

  /** After a local change: sync a few seconds later (several changes go together). */
  function changed() {
    if (!state.target) return;
    clearTimeout(soon);
    soon = setTimeout(() => run().catch(() => {}), DEBOUNCE);
    soon.unref?.();
  }

  function start() {
    if (timer || !state.target) return;
    run().catch(() => {});
    timer = setInterval(() => run().catch(() => {}), INTERVAL);
    timer.unref?.();
  }

  function stop() {
    clearInterval(timer);
    clearTimeout(soon);
    timer = null;
  }

  return { status, syncNow: run, syncOnce, connect, disconnect, changed, start, stop };
}

module.exports = { createSync, stateFile };
