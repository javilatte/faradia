'use strict';

const { getDiff, listCommits } = require('../monitor/diff');
const { getWatchlist, setWatchlist } = require('../monitor/watchlists');
const { sendJson, readJsonBody } = require('./util');

// Supervision routes (read-only on the repos, except the plane 2 watchlist, which lives in
// optimia's configuration):
//   GET /api/monitor/state                                  every watched repo
//   GET /api/monitor/diff?projectId&taskId?&path?&mode&context&ref
//   GET /api/monitor/commits?projectId&limit&skip
//   GET /api/monitor/watch-events?projectId?
//   GET /api/monitor/watchlist?projectId     PUT {projectId, patterns}

async function handleMonitorRoutes(req, res, url, { monitor, registry }) {
  const p = url.pathname;
  const q = url.searchParams;

  // Folder the read happens on: the repo or the worktree of one of its tasks.
  const cwdFor = (projectId, taskId) => {
    const info = registry.info(projectId);
    if (!info) return null;
    if (!taskId) return info.root;
    const wt = monitor.entry(projectId)?.worktrees.get(taskId);
    return wt ? wt.path : null;
  };

  try {
    if (p === '/api/monitor/state' && req.method === 'GET') {
      return sendJson(res, 200, { repos: monitor.snapshot() });
    }

    if (p === '/api/monitor/diff' && req.method === 'GET') {
      const cwd = cwdFor(q.get('projectId'), q.get('taskId'));
      if (!cwd) return sendJson(res, 404, { error: 'repo o worktree no encontrado' });
      const diff = await getDiff(cwd, {
        path: q.get('path'),
        mode: q.get('mode') || 'head',
        ref: q.get('ref') || undefined,
        context: q.get('context') || 3
      });
      return sendJson(res, 200, diff);
    }

    if (p === '/api/monitor/commits' && req.method === 'GET') {
      const cwd = cwdFor(q.get('projectId'));
      if (!cwd) return sendJson(res, 404, { error: 'repo no encontrado' });
      return sendJson(res, 200, { commits: await listCommits(cwd, { limit: q.get('limit'), skip: q.get('skip') }) });
    }

    if (p === '/api/monitor/watch-events' && req.method === 'GET') {
      return sendJson(res, 200, { events: monitor.recentWatchEvents(q.get('projectId') || null) });
    }

    if (p === '/api/monitor/watchlist' && req.method === 'GET') {
      const info = registry.info(q.get('projectId'));
      if (!info) return sendJson(res, 404, { error: 'repo no encontrado' });
      return sendJson(res, 200, { patterns: getWatchlist(info.root) });
    }

    if (p === '/api/monitor/watchlist' && req.method === 'PUT') {
      const body = await readJsonBody(req);
      const info = registry.info(body.projectId);
      if (!info) return sendJson(res, 404, { error: 'repo no encontrado' });
      const patterns = setWatchlist(info.root, body.patterns);
      await monitor.reloadWatchlist(body.projectId);
      return sendJson(res, 200, { patterns });
    }
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
  return null;
}

module.exports = { handleMonitorRoutes };
