'use strict';

const http = require('http');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const { checkClaudeCapabilities } = require('./bridge/claudeVersion');
const { createApp } = require('./runtime/projectApp');
const { ProjectRegistry } = require('./runtime/registry');
const { openInBrowser, serveStatic, sendJson, readJsonBody } = require('./http/util');
const security = require('./http/security');
const { handleWorkbenchRoutes, workbenchesView } = require('./http/workbenchRoutes');
const { handleMonitorRoutes } = require('./http/monitorRoutes');
const { MonitorService } = require('./monitor/monitorService');
const { Timeline } = require('./monitor/timeline');
const { SignalEngine } = require('./monitor/signals');
const { Metrics } = require('./monitor/metrics');
const { git } = require('./monitor/gitState');
const { loadPrefs, savePrefs } = require('./store/globalPrefs');
const { ensureLaunchRepo } = require('./store/workbenchStore');

// Rutas de la API:
//   /api/health, /api/projects            globales
//   /api/projects/:id/<resto>              API del proyecto :id (ver runtime/projectApp.js)
//   /api/<resto>                           compatibilidad: API del proyecto de arranque
const PROJECT_ROUTE = /^\/api\/projects\/([a-f0-9]{12})(\/.*)$/;

function start({ projectRoot = process.cwd(), port = 0, open = true, token } = {}) {
  const sessionToken = token || process.env.OPTIMIA_TOKEN || security.createToken();
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  let registry = null;
  let monitor = null;
  let timeline = null;
  let signals = null;
  let metrics = null;
  let orphanTimer = null;
  const taskStatus = new Map(); // taskId -> ultimo estado visto (para el timeline)
  let defaultProjectId = null;
  let actualPort = null;

  function sendToClients(payload) {
    // Las tareas que cambian de estado tambien van al timeline.
    if (payload.type === 'task_updated' && payload.task && timeline) {
      const prev = taskStatus.get(payload.task.id);
      taskStatus.set(payload.task.id, payload.task.status);
      timeline.recordTask(payload.projectId, registry?.info(payload.projectId)?.name, payload.task, prev);
    }
    const data = JSON.stringify(payload);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  }

  // Pasa la peticion a la API de un proyecto con la URL que esa API espera (/api/...).
  function forwardToProject(id, rest, req, res) {
    const rt = registry.runtime(id);
    if (!rt) return sendJson(res, 404, { error: 'proyecto desconocido' });
    const started = Date.now();
    req.url = `/api${rest}`;
    res.on('finish', () => {
      rt.log.info('http.request', {
        method: req.method,
        path: req.url.split('?')[0],
        status: res.statusCode,
        ms: Date.now() - started
      });
    });
    return rt.app(req, res);
  }

  async function handleApi(req, res, url) {
    if (url.pathname === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        projectRoot: registry.info(defaultProjectId).root,
        defaultProjectId,
        claude: checkClaudeCapabilities()
      });
    }

    if (url.pathname === '/api/projects' && req.method === 'GET') {
      return sendJson(res, 200, { defaultProjectId, projects: registry.list() });
    }

    if (url.pathname === '/api/projects' && req.method === 'POST') {
      const body = await readJsonBody(req).catch(() => null);
      if (!body || typeof body.path !== 'string') return sendJson(res, 400, { error: 'path is required' });
      try {
        return sendJson(res, 201, registry.register(body.path));
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    if (url.pathname.startsWith('/api/workbenches') || url.pathname === '/api/scan') {
      const handled = await handleWorkbenchRoutes(req, res, url, {
        registry,
        onChange: () => {
          sendToClients({ type: 'workbenches_changed' });
          monitor?.sync().catch(() => {});
        }
      });
      if (handled !== null) return handled;
    }

    if (url.pathname === '/api/timeline' && req.method === 'GET') {
      const q = url.searchParams;
      const list = (name) => (q.get(name) ? q.get(name).split(',').filter(Boolean) : null);
      const projectIds = list('projectId') || activeRepos().map((r) => r.projectId);
      return sendJson(res, 200, {
        entries: timeline.query({
          projectIds,
          kinds: list('kind'),
          ext: q.get('ext'),
          since: q.get('since'),
          until: q.get('until'),
          limit: Number(q.get('limit')) || 200
        })
      });
    }

    if (url.pathname === '/api/monitor/signals' && req.method === 'GET') {
      const only = url.searchParams.get('projectId');
      return sendJson(res, 200, {
        signals: signals.recentSignals(only ? [only] : activeRepos().map((r) => r.projectId))
      });
    }

    if (url.pathname === '/api/monitor/metrics' && req.method === 'GET') {
      return sendJson(res, 200, { repos: monitor.snapshot().map((r) => metrics.forRepo(r)) });
    }

    if (url.pathname === '/api/preferences' && req.method === 'GET') return sendJson(res, 200, loadPrefs());
    if (url.pathname === '/api/preferences' && req.method === 'PUT') {
      const body = await readJsonBody(req).catch(() => null);
      if (!body) return sendJson(res, 400, { error: 'invalid JSON body' });
      return sendJson(res, 200, savePrefs(body));
    }

    if (url.pathname.startsWith('/api/monitor/')) {
      const handled = await handleMonitorRoutes(req, res, url, { monitor, registry });
      if (handled !== null) return handled;
    }

    const match = PROJECT_ROUTE.exec(url.pathname);
    if (match) return forwardToProject(match[1], `${match[2]}${url.search}`, req, res);

    return forwardToProject(defaultProjectId, `${url.pathname.slice('/api'.length)}${url.search}`, req, res);
  }

  server.on('request', (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname.startsWith('/api/')) {
      const problem = security.checkApiRequest(req, { token: sessionToken, port: actualPort });
      if (problem) return sendJson(res, problem.status, { error: problem.error });
      return handleApi(req, res, url).catch((err) => {
        registry.runtime(defaultProjectId)?.log.error('http.unhandled', { path: url.pathname, error: err.message });
        if (!res.headersSent) sendJson(res, 500, { error: err.message });
      });
    }

    if (!security.hostAllowed(req, actualPort)) {
      res.writeHead(421, { 'Content-Type': 'text/plain' });
      return res.end('host no permitido');
    }
    // El enlace que imprime optimia lleva ?token=: se guarda en una cookie y se quita de la URL.
    const given = url.searchParams.get('token');
    if (given !== null) {
      const headers = { Location: url.pathname };
      if (security.safeEqual(given, sessionToken)) {
        headers['Set-Cookie'] = security.sessionCookie(sessionToken, actualPort);
      }
      res.writeHead(302, headers);
      return res.end();
    }
    return serveStatic(req, res);
  });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    const problem =
      pathname === '/ws' ? security.checkApiRequest(req, { token: sessionToken, port: actualPort }) : { status: 404 };
    if (problem) {
      socket.write(`HTTP/1.1 ${problem.status} ${http.STATUS_CODES[problem.status]}\r\n\r\n`);
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return ws.send(JSON.stringify({ type: 'client_error', error: 'invalid JSON' }));
      }
      const projectId = msg.projectId || defaultProjectId;
      const rt = registry.runtime(projectId);
      if (!rt) return ws.send(JSON.stringify({ type: 'client_error', error: 'proyecto desconocido', projectId }));
      if (rt.handleWsMessage(msg, ws) === false) {
        ws.send(JSON.stringify({ type: 'client_error', error: `unknown message type: ${msg.type}`, projectId }));
      }
    });
  });

  // Vigilancia (solo lectura) de los repos del workbench activo. Sus eventos van
  // por el mismo WebSocket con tipos monitor_*; la vista de proyecto los ignora.
  function activeRepos() {
    const view = workbenchesView(registry);
    const wb = view.workbenches.find((w) => w.id === view.activeWorkbenchId) || view.workbenches[0];
    return (wb?.repos || [])
      .filter((r) => r.exists && r.projectId)
      .map((r) => ({ projectId: r.projectId, name: r.name, path: r.path }));
  }

  function startMonitor() {
    timeline = new Timeline();
    timeline.on('entry', (entry) => sendToClients({ type: 'timeline_entry', entry }));
    monitor = new MonitorService({ getRepos: activeRepos });
    signals = new SignalEngine();
    metrics = new Metrics();
    signals.on('signal', (signal) => {
      timeline.recordSignal(signal);
      sendToClients({ type: 'signal', signal });
    });
    monitor.on('activity', (e) => {
      timeline.recordFiles(e);
      metrics.recordActivity(e);
      const entry = monitor.entry(e.projectId);
      const root = e.taskId ? entry?.worktrees.get(e.taskId)?.path : entry?.path;
      // Solo se buscan secretos en lo que git commitearia (no en ficheros ignorados como .env).
      const committable = async (rel) => {
        try {
          await git(root, ['check-ignore', '-q', '--', rel]);
          return false;
        } catch {
          return true;
        }
      };
      signals.onActivity({ ...e, root, committable }).catch(() => {});
    });
    monitor.on('state', (e) => {
      timeline.recordState(e);
      signals.onState(e);
    });
    monitor.on('worktree_state', (e) => signals.onState(e));
    monitor.on('watch_event', (e) => timeline.recordWatch(e));
    orphanTimer = setInterval(() => timeline.checkOrphans(monitor.snapshot()), 60 * 1000);
    orphanTimer.unref?.();
    const relay = (type) => (event) => sendToClients({ type, ...event, previous: undefined });
    monitor.on('state', relay('monitor_state'));
    monitor.on('activity', relay('monitor_activity'));
    monitor.on('watch_event', relay('monitor_watch_event'));
    monitor.on('worktree_state', relay('monitor_worktree_state'));
    monitor.start().catch((err) => console.error(`optimia: no se pudo iniciar la vigilancia: ${err.message}`));
  }

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      actualPort = server.address().port;
      registry = new ProjectRegistry({ port: actualPort, token: sessionToken, sendToClients });
      defaultProjectId = registry.register(projectRoot).id;
      try {
        ensureLaunchRepo(projectRoot);
      } catch (err) {
        console.error(`optimia: no se pudo guardar el workbench por defecto: ${err.message}`);
      }
      const rt = registry.runtime(defaultProjectId);
      const url = `http://127.0.0.1:${actualPort}`;
      const openUrl = `${url}/?token=${sessionToken}`;
      console.log(`optimia running at ${openUrl} (project: ${projectRoot})`);
      rt.log.info('server.start', { url, port: actualPort, projectRoot });
      if (open) openInBrowser(openUrl);
      startMonitor();
      server.on('close', () => {
        clearInterval(orphanTimer);
        timeline?.stop();
        monitor?.stop();
        registry.dispose();
      });
      resolve({
        server,
        wss,
        url,
        openUrl,
        port: actualPort,
        token: sessionToken,
        registry,
        defaultProjectId,
        monitor
      });
    });
  });
}

module.exports = { start, createApp };

if (require.main === module) {
  const projectRoot = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
  start({ projectRoot });
}
