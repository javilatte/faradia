'use strict';

const fs = require('fs');
const path = require('path');
const wbStore = require('../store/workbenchStore');
const { sendJson, readJsonBody } = require('./util');
const { pickFolder } = require('../bridge/filePicker');

// Global workbench routes:
//   GET    /api/workbenches                       all, with their repos already registered as projects
//   POST   /api/workbenches {name}
//   PATCH  /api/workbenches/:id {name}
//   DELETE /api/workbenches/:id
//   PUT    /api/workbenches/active {id}
//   POST   /api/workbenches/:id/repos {paths: []}
//   DELETE /api/workbenches/:id/repos {path}
//   POST   /api/scan {root, maxDepth}             looks for git repos under a folder
//   POST   /api/pick-folder                       native folder dialog -> {path|null}

function repoView(registry, repo) {
  const exists = fs.existsSync(repo);
  const view = {
    path: repo,
    name: path.basename(repo),
    exists,
    isGit: exists && fs.existsSync(path.join(repo, '.git'))
  };
  if (exists) view.projectId = registry.register(repo).id;
  return view;
}

function workbenchesView(registry) {
  const store = wbStore.listWorkbenches();
  return {
    activeWorkbenchId: store.activeWorkbenchId,
    workbenches: store.workbenches.map((wb) => ({ ...wb, repos: wb.repos.map((r) => repoView(registry, r)) }))
  };
}

async function handleWorkbenchRoutes(req, res, url, { registry, onChange }) {
  const p = url.pathname;
  const m = /^\/api\/workbenches\/([0-9a-f-]{36})(\/repos)?$/.exec(p);
  const done = (status) => {
    onChange?.();
    return sendJson(res, status, workbenchesView(registry));
  };
  const fail = (err) => sendJson(res, err.message === 'workbench no encontrado' ? 404 : 400, { error: err.message });

  try {
    if (p === '/api/workbenches' && req.method === 'GET') return sendJson(res, 200, workbenchesView(registry));

    if (p === '/api/workbenches' && req.method === 'POST') {
      const body = await readJsonBody(req);
      wbStore.createWorkbench(body.name);
      return done(201);
    }

    if (p === '/api/workbenches/active' && req.method === 'PUT') {
      const body = await readJsonBody(req);
      wbStore.setActiveWorkbench(body.id);
      return done(200);
    }

    if (m && !m[2] && req.method === 'PATCH') {
      const body = await readJsonBody(req);
      wbStore.renameWorkbench(m[1], body.name);
      return done(200);
    }

    if (m && !m[2] && req.method === 'DELETE') {
      wbStore.deleteWorkbench(m[1]);
      return done(200);
    }

    if (m && m[2] && req.method === 'POST') {
      const body = await readJsonBody(req);
      const paths = Array.isArray(body.paths) ? body.paths : typeof body.path === 'string' ? [body.path] : [];
      if (!paths.length) return sendJson(res, 400, { error: 'indica al menos una ruta' });
      wbStore.addRepos(m[1], paths);
      return done(200);
    }

    if (m && m[2] && req.method === 'DELETE') {
      const body = await readJsonBody(req);
      if (typeof body.path !== 'string') return sendJson(res, 400, { error: 'path is required' });
      wbStore.removeRepo(m[1], body.path);
      return done(200);
    }

    if (p === '/api/pick-folder' && req.method === 'POST') {
      try {
        return sendJson(res, 200, { path: await pickFolder({ prompt: 'Elige el repo que quieres añadir' }) });
      } catch (err) {
        return sendJson(res, 501, { error: err.message });
      }
    }

    if (p === '/api/scan' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (typeof body.root !== 'string' || !body.root.trim()) return sendJson(res, 400, { error: 'root is required' });
      const maxDepth = Math.min(6, Math.max(1, Number(body.maxDepth) || 4));
      const root = body.root.replace(/^~(?=$|\/)/, process.env.HOME || '');
      return sendJson(res, 200, { root, repos: wbStore.scanForRepos(root, { maxDepth }) });
    }
  } catch (err) {
    return fail(err);
  }
  return null; // not a workbench route
}

module.exports = { handleWorkbenchRoutes, workbenchesView };
