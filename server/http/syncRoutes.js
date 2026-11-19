'use strict';

const os = require('os');
const targets = require('../sync/targets');
const { sendJson, readJsonBody } = require('./util');

// Sync between computers (server/sync):
//   GET    /api/sync                       status
//   POST   /api/sync/folder {path, passphrase}
//   POST   /api/sync/now
//   DELETE /api/sync?wipe=1                stop syncing (wipe=1 also deletes the synced copy)

// Paths whose writes change the global configuration (and so are worth syncing).
const CONFIG_WRITES = /^\/api\/(?:projects\/[^/]+\/)?(?:settings|agents|preferences|config\/import|ecc)(?:\/|$)/;

function isConfigWrite(req, pathname) {
  return req.method !== 'GET' && CONFIG_WRITES.test(pathname);
}

async function handleSyncRoutes(req, res, url, { sync }) {
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
  return null;
}

module.exports = { handleSyncRoutes, isConfigWrite };
