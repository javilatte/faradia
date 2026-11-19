'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mkTmpDir, rmTmpDir } = require('./helpers');
const envelope = require('../../server/sync/envelope');
const targets = require('../../server/sync/targets');
const { createSync, stateFile } = require('../../server/sync/engine');
const { isConfigWrite } = require('../../server/http/syncRoutes');
const store = require('../../server/store/settingsStore');
const catalog = require('../../server/agents/catalog');

const PASS = 'caballo-bateria-grapa';

// Two "computers" (each with its own config dir) and a shared folder between them.
function setup(t) {
  const a = mkTmpDir('sync-a');
  const b = mkTmpDir('sync-b');
  const shared = mkTmpDir('sync-shared');
  const prev = process.env.XDG_CONFIG_HOME;
  const on = (dir) => {
    process.env.XDG_CONFIG_HOME = dir;
  };
  t.after(() => {
    process.env.XDG_CONFIG_HOME = prev;
    for (const d of [a, b, shared]) rmTmpDir(d);
  });
  return { a, b, shared, on };
}

test('envelope: round trip, wrong passphrase, tampering, short passphrase', () => {
  const sealed = envelope.seal({ hello: 'mundo' }, PASS, { updatedAt: 'x', machine: 'mac' });
  assert.equal(sealed.machine, 'mac');
  assert.ok(!JSON.stringify(sealed).includes('mundo'));
  assert.deepEqual(envelope.open(sealed, PASS), { hello: 'mundo' });
  assert.throws(() => envelope.open(sealed, 'otra-frase-larga'), envelope.PassphraseError);
  // The readable header is authenticated too.
  assert.throws(() => envelope.open({ ...sealed, machine: 'otro' }, PASS), envelope.PassphraseError);
  assert.throws(() => envelope.seal({}, 'corta'), envelope.PassphraseError);
});

test('sync: a second computer receives the first one’s configuration, secrets included', async (t) => {
  const { a, b, shared, on } = setup(t);
  on(a);
  store.saveGlobalSettings({
    ui: { theme: 'dark' },
    ai: { localAi: { url: 'http://ollama:11434', model: 'qwen', authHeader: 'Authorization: Bearer s3cret' } },
    preferences: { instructions: 'Conventional Commits.' },
    tasks: { archiveDays: 7 }
  });
  catalog.createAgent(null, 'global', { name: 'Traductor', description: 'Traduce', prompt: 'Traduce.' });
  const syncA = createSync();
  assert.equal((await syncA.connect({ kind: 'folder', path: shared }, PASS)).action, 'up');
  syncA.stop();
  const onDisk = fs.readFileSync(path.join(shared, targets.FILE_NAME), 'utf8');
  assert.ok(!onDisk.includes('s3cret') && !onDisk.includes('Conventional'), 'stored encrypted');
  assert.equal(fs.statSync(stateFile()).mode & 0o777, 0o600);

  on(b);
  const syncB = createSync();
  await assert.rejects(syncB.connect({ kind: 'folder', path: shared }, 'frase-equivocada'), /frase de paso/);
  const { action, existing } = await syncB.connect({ kind: 'folder', path: shared }, PASS);
  syncB.stop();
  assert.equal(action, 'down');
  assert.equal(existing, true);
  const s = store.loadGlobalSettings();
  assert.equal(s.ui.theme, 'dark');
  assert.equal(s.ai.localAi.authHeader, 'Authorization: Bearer s3cret', 'secrets travel too, encrypted');
  assert.equal(s.preferences.instructions, 'Conventional Commits.');
  assert.equal(s.tasks.archiveDays, 7);
  assert.ok(catalog.loadAgents(null).some((ag) => ag.name === 'Traductor'));
  // Nothing changed since: nothing to do.
  assert.equal(await syncB.syncOnce(), 'none');
});

test('sync: changes travel both ways, and on a conflict the newest wins with a backup', async (t) => {
  const { a, b, shared, on } = setup(t);
  on(a);
  store.saveGlobalSettings({ ui: { theme: 'light' } });
  const syncA = createSync();
  await syncA.connect({ kind: 'folder', path: shared }, PASS);
  syncA.stop();
  on(b);
  const syncB = createSync();
  await syncB.connect({ kind: 'folder', path: shared }, PASS);
  syncB.stop();

  // B changes → up; A picks it up.
  store.saveGlobalSettings({ preferences: { instructions: 'desde B' } });
  assert.equal(await syncB.syncOnce(), 'up');
  on(a);
  assert.equal(await syncA.syncOnce(), 'down');
  assert.equal(store.loadGlobalSettings().preferences.instructions, 'desde B');

  // Both change; A's change is older than the copy B uploads → B wins on A, and A's is backed up.
  store.saveGlobalSettings({ preferences: { instructions: 'desde A' } });
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(store.globalSettingsPath(), old, old);
  on(b);
  store.saveGlobalSettings({ preferences: { instructions: 'desde B otra vez' } });
  assert.equal(await syncB.syncOnce(), 'up');
  on(a);
  assert.equal(await syncA.syncOnce(), 'conflict-down');
  assert.equal(store.loadGlobalSettings().preferences.instructions, 'desde B otra vez');
  const backups = fs.readdirSync(path.join(a, 'optimia', 'backups'));
  assert.ok(backups.length >= 1);

  // Both change again, A's is newer → A wins and B's copy is kept.
  on(b);
  store.saveGlobalSettings({ preferences: { instructions: 'B tarde' } });
  assert.equal(await syncB.syncOnce(), 'up');
  on(a);
  store.saveGlobalSettings({ preferences: { instructions: 'A más tarde' } });
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(store.globalSettingsPath(), future, future);
  assert.equal(await syncA.syncOnce(), 'conflict-up');
  assert.ok(fs.readdirSync(path.join(a, 'optimia', 'backups')).some((n) => n.endsWith('sync-remote')));
  on(b);
  assert.equal(await syncB.syncOnce(), 'down');
  assert.equal(store.loadGlobalSettings().preferences.instructions, 'A más tarde');
});

test('sync: disconnecting with wipe deletes the synced copy and forgets the passphrase', async (t) => {
  const { a, shared, on } = setup(t);
  on(a);
  const sync = createSync();
  await sync.connect({ kind: 'folder', path: shared }, PASS);
  await sync.disconnect({ wipe: true });
  assert.equal(fs.existsSync(path.join(shared, targets.FILE_NAME)), false);
  assert.equal(sync.status().enabled, false);
  assert.ok(!fs.readFileSync(stateFile(), 'utf8').includes(PASS));
});

test('folder check: absolute existing writable folder only', (t) => {
  const { shared } = setup(t);
  assert.equal(targets.checkFolder(shared), shared);
  assert.throws(() => targets.checkFolder('relativa'), /ruta completa/);
  assert.throws(() => targets.checkFolder(path.join(shared, 'no-existe')), /no existe/);
});

test('only writes to the global configuration trigger a sync', () => {
  const req = (method) => ({ method });
  assert.ok(isConfigWrite(req('PATCH'), '/api/settings'));
  assert.ok(isConfigWrite(req('PATCH'), '/api/projects/p1/settings'));
  assert.ok(isConfigWrite(req('PUT'), '/api/agents/stages'));
  assert.ok(isConfigWrite(req('POST'), '/api/config/import'));
  assert.ok(!isConfigWrite(req('GET'), '/api/settings'));
  assert.ok(!isConfigWrite(req('POST'), '/api/tasks'));
});
