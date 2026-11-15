'use strict';

const portable = require('../config/portable');
const { checkForUpdate } = require('../config/updateCheck');
const { loadGlobalSettings } = require('../store/settingsStore');
const { sendJson, readJsonBody } = require('./util');
const pkg = require('../../package.json');

// Global routes for the portable configuration and update notices:
//   GET  /api/config/status                 {firstRun, version}
//   POST /api/config/welcome                first run done (start with the defaults)
//   GET  /api/config/export?secrets=1       downloads optimia-config-<date>.json
//   POST /api/config/import {config, apply} preview (apply=false) or import
//   GET  /api/update?force=1                {current, latest, updateAvailable, ...}

async function handleConfigRoutes(req, res, url) {
  const p = url.pathname;
  if (p === '/api/config/status' && req.method === 'GET') {
    return sendJson(res, 200, { firstRun: portable.isFirstRun(), version: pkg.version });
  }
  if (p === '/api/config/welcome' && req.method === 'POST') {
    portable.markWelcomed();
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/config/export' && req.method === 'GET') {
    const config = portable.exportConfig({ includeSecrets: url.searchParams.get('secrets') === '1' });
    const date = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="optimia-config-${date}.json"`,
      'Cache-Control': 'no-store'
    });
    return res.end(JSON.stringify(config, null, 2) + '\n');
  }
  if (p === '/api/config/import' && req.method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req, { maxBytes: 2 * 1024 * 1024 });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
    try {
      if (body?.apply === true) return sendJson(res, 200, portable.importConfig(body.config));
      return sendJson(res, 200, portable.previewImport(body?.config));
    } catch (err) {
      if (err instanceof portable.ConfigError) return sendJson(res, 400, { error: err.message });
      throw err;
    }
  }
  if (p === '/api/update' && req.method === 'GET') {
    const enabled = loadGlobalSettings().updates.check;
    return sendJson(res, 200, await checkForUpdate({ enabled, force: url.searchParams.get('force') === '1' }));
  }
  return null;
}

module.exports = { handleConfigRoutes };
