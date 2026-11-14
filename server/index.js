'use strict';

const http = require('http');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const { checkClaudeCapabilities } = require('./bridge/claudeVersion');
const { createApp } = require('./runtime/projectApp');
const { ProjectRegistry } = require('./runtime/registry');
const { openInBrowser, serveStatic, sendJson, readJsonBody } = require('./http/util');
const security = require('./http/security');

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
  let defaultProjectId = null;
  let actualPort = null;

  function sendToClients(payload) {
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

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      actualPort = server.address().port;
      registry = new ProjectRegistry({ port: actualPort, token: sessionToken, sendToClients });
      defaultProjectId = registry.register(projectRoot).id;
      const rt = registry.runtime(defaultProjectId);
      const url = `http://127.0.0.1:${actualPort}`;
      const openUrl = `${url}/?token=${sessionToken}`;
      console.log(`optimia running at ${openUrl} (project: ${projectRoot})`);
      rt.log.info('server.start', { url, port: actualPort, projectRoot });
      if (open) openInBrowser(openUrl);
      server.on('close', () => registry.dispose());
      resolve({ server, wss, url, openUrl, port: actualPort, token: sessionToken, registry, defaultProjectId });
    });
  });
}

module.exports = { start, createApp };

if (require.main === module) {
  const projectRoot = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
  start({ projectRoot });
}
