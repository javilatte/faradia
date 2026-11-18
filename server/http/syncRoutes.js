'use strict';

const os = require('os');
const google = require('../sync/google');
const targets = require('../sync/targets');
const { checkPassphrase } = require('../sync/envelope');
const { sendJson, readJsonBody } = require('./util');

// Sync between computers (server/sync):
//   GET    /api/sync                       status
//   POST   /api/sync/folder {path, passphrase}
//   POST   /api/sync/google {passphrase}   → {authUrl}; Google comes back to GET /oauth/google
//   POST   /api/sync/now
//   DELETE /api/sync?wipe=1                stop syncing (wipe=1 also deletes the synced copy)

const GOOGLE_CALLBACK = '/oauth/google';

// Paths whose writes change the global configuration (and so are worth syncing).
const CONFIG_WRITES = /^\/api\/(?:projects\/[^/]+\/)?(?:settings|agents|preferences|config\/import|ecc)(?:\/|$)/;

function isConfigWrite(req, pathname) {
  return req.method !== 'GET' && CONFIG_WRITES.test(pathname);
}

async function handleSyncRoutes(req, res, url, { sync, port }) {
  const p = url.pathname;
  if (p === '/api/sync' && req.method === 'GET') return sendJson(res, 200, sync.status());
  if (p === '/api/sync' && req.method === 'DELETE') {
    try {
      await sync.disconnect({ wipe: url.searchParams.get('wipe') === '1' });
    } catch (err) {
      return sendJson(res, 502, { error: err.message });
    }
    return sendJson(res, 200, sync.status());
  }
  if (p === '/api/sync/now' && req.method === 'POST') {
    await sync.syncNow().catch(() => {});
    return sendJson(res, 200, sync.status());
  }
  if (p === '/api/sync/folder' && req.method === 'POST') {
    const body = await readJsonBody(req).catch(() => null);
    try {
      const dir = targets.checkFolder(String(body?.path || '').replace(/^~(?=\/|$)/, os.homedir()));
      const result = await sync.connect({ kind: 'folder', path: dir }, body?.passphrase);
      return sendJson(res, 200, { ...sync.status(), ...result });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }
  if (p === '/api/sync/google' && req.method === 'POST') {
    const body = await readJsonBody(req).catch(() => null);
    try {
      checkPassphrase(body?.passphrase);
      const authUrl = google.startSignIn(`http://127.0.0.1:${port}${GOOGLE_CALLBACK}`, {
        passphrase: body.passphrase
      });
      return sendJson(res, 200, { authUrl });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }
  return null;
}

const page = (title, text, ok) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
  `<title>optimia</title><style>body{font:15px -apple-system,system-ui,sans-serif;display:grid;` +
  `place-items:center;min-height:90vh;margin:0;color:#1d1d1f;background:#f5f5f7}` +
  `main{max-width:26rem;padding:2rem;text-align:center}h1{font-size:1.25rem;color:${ok ? '#1d7a3a' : '#b3261e'}}` +
  `@media(prefers-color-scheme:dark){body{background:#1d1d1f;color:#f5f5f7}}</style>` +
  `<main><h1>${title}</h1><p>${text}</p></main>` +
  (ok ? '<script>setTimeout(()=>window.close(),1500)</script>' : '');

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Google's redirect after the consent page. Authenticated by the single-use `state`, not the cookie. */
async function handleGoogleCallback(req, res, url, { sync, fetcher = fetch }) {
  const q = url.searchParams;
  let title = 'Sincronización activada';
  let text = 'Ya puedes cerrar esta pestaña y volver a optimia.';
  let ok = true;
  try {
    const signIn = await google.finishSignIn(
      { state: q.get('state'), code: q.get('code'), error: q.get('error') },
      fetcher
    );
    await sync.connect(
      { kind: 'google', refreshToken: signIn.refreshToken, email: signIn.email },
      signIn.extra.passphrase
    );
  } catch (err) {
    ok = false;
    title = 'No se pudo activar la sincronización';
    text = `${escapeHtml(err.message)}. Vuelve a optimia e inténtalo de nuevo.`;
  }
  res.writeHead(ok ? 200 : 400, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
  });
  res.end(page(title, text, ok));
}

module.exports = { handleSyncRoutes, handleGoogleCallback, isConfigWrite, GOOGLE_CALLBACK };
