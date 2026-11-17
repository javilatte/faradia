'use strict';

const portable = require('../config/portable');
const { checkForUpdate } = require('../config/updateCheck');
const { loadGlobalSettings, saveGlobalSettings } = require('../store/settingsStore');
const { sandboxStatus } = require('../bridge/sandbox');
const knowledge = require('../knowledge/bundle');
const plugins = require('../bridge/plugins');
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
    return sendJson(res, 200, {
      firstRun: portable.isFirstRun(),
      version: pkg.version,
      sandbox: { mode: loadGlobalSettings().security.sandbox, ...sandboxStatus() }
    });
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
  // Everything optimia knows (configuration, wikis, memories), to take to another machine.
  if (p === '/api/knowledge/export' && req.method === 'GET') {
    const bundle = knowledge.exportKnowledge({ includeSecrets: url.searchParams.get('secrets') === '1' });
    const date = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="optimia-knowledge-${date}.json"`,
      'Cache-Control': 'no-store'
    });
    return res.end(JSON.stringify(bundle, null, 2) + '\n');
  }
  if (p === '/api/knowledge/import' && req.method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req, { maxBytes: 64 * 1024 * 1024 });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
    try {
      if (body?.apply === true) {
        return sendJson(res, 200, knowledge.importKnowledge(body.bundle, { withConfig: body.withConfig !== false }));
      }
      return sendJson(res, 200, knowledge.previewKnowledge(body?.bundle));
    } catch (err) {
      if (err instanceof knowledge.KnowledgeError || err instanceof portable.ConfigError) {
        return sendJson(res, 400, { error: err.message });
      }
      throw err;
    }
  }
  // ECC (Everything Claude Code): status, install, where it is enabled.
  if (p === '/api/tools/ecc' && req.method === 'GET') {
    const status = await plugins.eccStatus();
    return sendJson(res, 200, {
      ...status,
      inOptimia: loadGlobalSettings().tools.ecc,
      details: status.installed && url.searchParams.get('details') === '1' ? await plugins.eccDetails() : null
    });
  }
  if (p === '/api/tools/ecc' && req.method === 'POST') {
    const body = await readJsonBody(req).catch(() => ({}));
    try {
      let status;
      if (body.action === 'install') {
        status = await plugins.installEcc({ everywhere: body.everywhere === true, hooks: body.hooks === true });
        saveGlobalSettings({ tools: { ecc: true } });
      } else if (body.action === 'uninstall') {
        status = await plugins.uninstallEcc();
        saveGlobalSettings({ tools: { ecc: false } });
      } else {
        if (typeof body.inOptimia === 'boolean') saveGlobalSettings({ tools: { ecc: body.inOptimia } });
        status =
          typeof body.everywhere === 'boolean'
            ? await plugins.setEccEverywhere(body.everywhere)
            : await plugins.eccStatus();
      }
      return sendJson(res, 200, { ...status, inOptimia: loadGlobalSettings().tools.ecc });
    } catch (err) {
      return sendJson(res, 502, { error: `claude plugin: ${err.message}` });
    }
  }
  if (p === '/api/update' && req.method === 'GET') {
    const enabled = loadGlobalSettings().updates.check;
    return sendJson(res, 200, await checkForUpdate({ enabled, force: url.searchParams.get('force') === '1' }));
  }
  return null;
}

module.exports = { handleConfigRoutes };
