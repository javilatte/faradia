'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mkTmpDir, rmTmpDir } = require('./helpers');
const envelope = require('../../server/sync/envelope');
const targets = require('../../server/sync/targets');
const google = require('../../server/sync/google');
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
    providers: { gemini: { apiKey: 'AIzaSECRET', model: 'gemini-flash' } },
    preferences: { instructions: 'Conventional Commits.' },
    tasks: { archiveDays: 7 }
  });
  catalog.createAgent(null, 'global', { name: 'Traductor', description: 'Traduce', prompt: 'Traduce.' });
  const syncA = createSync();
  assert.equal((await syncA.connect({ kind: 'folder', path: shared }, PASS)).action, 'up');
  syncA.stop();
  const onDisk = fs.readFileSync(path.join(shared, targets.FILE_NAME), 'utf8');
  assert.ok(!onDisk.includes('AIzaSECRET') && !onDisk.includes('Conventional'), 'stored encrypted');
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
  assert.equal(s.providers.gemini.apiKey, 'AIzaSECRET');
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

// A fake Google: OAuth token endpoint plus Drive's appDataFolder in memory.
function fakeGoogle() {
  const files = new Map();
  const calls = [];
  const json = (body, status = 200) => ({
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  });
  const fetcher = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET' });
    if (url === 'https://oauth2.googleapis.com/token') {
      const form = new URLSearchParams(init.body);
      if (form.get('grant_type') === 'authorization_code') {
        assert.ok(form.get('code_verifier'));
        const idToken = `x.${Buffer.from(JSON.stringify({ email: 'ana@example.com' })).toString('base64url')}.y`;
        return json({ access_token: 'at1', refresh_token: 'rt1', expires_in: 3600, id_token: idToken });
      }
      return json({ access_token: 'at2', expires_in: 3600 });
    }
    assert.match(init.headers.Authorization, /^Bearer at/);
    const u = new URL(url);
    if (u.pathname === '/drive/v3/files' && !init.method) {
      return json({ files: [...files.keys()].map((id) => ({ id })) });
    }
    if (u.pathname === '/upload/drive/v3/files' && init.method === 'POST') {
      const content = init.body.split('\r\n\r\n')[2].split('\r\n--')[0];
      files.set('f1', content);
      return json({ id: 'f1' });
    }
    const id = u.pathname.split('/').pop();
    if (init.method === 'PATCH') files.set(id, init.body);
    else if (init.method === 'DELETE') files.delete(id);
    else return json(files.get(id));
    return json({});
  };
  return { fetcher, files, calls };
}

test('google: sign-in with PKCE, then the config goes to appDataFolder and back', async (t) => {
  const { a, on } = setup(t);
  on(a);
  process.env.OPTIMIA_GOOGLE_CLIENT_ID = 'test-client';
  t.after(() => delete process.env.OPTIMIA_GOOGLE_CLIENT_ID);
  const g = fakeGoogle();
  const authUrl = new URL(google.startSignIn('http://127.0.0.1:5/oauth/google', { passphrase: PASS }));
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.match(authUrl.searchParams.get('scope'), /drive\.appdata/);
  const state = authUrl.searchParams.get('state');
  const signIn = await google.finishSignIn({ state, code: 'c0de' }, g.fetcher);
  assert.equal(signIn.email, 'ana@example.com');
  assert.equal(signIn.extra.passphrase, PASS);
  // The state is single use.
  await assert.rejects(google.finishSignIn({ state, code: 'c0de' }, g.fetcher), /caducó/);

  store.saveGlobalSettings({ ui: { theme: 'dark' } });
  const sync = createSync({ fetcher: g.fetcher });
  await sync.connect({ kind: 'google', refreshToken: signIn.refreshToken, email: signIn.email }, PASS);
  sync.stop();
  assert.equal(sync.status().label, 'ana@example.com');
  assert.equal(g.files.size, 1);
  assert.ok(envelope.isEnvelope(JSON.parse(g.files.get('f1'))));
  store.saveGlobalSettings({ ui: { theme: 'light' } });
  assert.equal(await sync.syncOnce(), 'up');
  assert.ok(g.calls.some((c) => c.method === 'PATCH'));
  await sync.disconnect({ wipe: true });
  assert.equal(g.files.size, 0);
  assert.ok(g.calls.some((c) => c.url.startsWith('https://oauth2.googleapis.com/revoke')));
});

test('google: unavailable without a client id', () => {
  delete process.env.OPTIMIA_GOOGLE_CLIENT_ID;
  assert.equal(google.client(), null);
  assert.throws(() => google.startSignIn('http://127.0.0.1:5/oauth/google'), /cliente de Google/);
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
