'use strict';

const fs = require('fs');
const { listDir, preview, resolveRepoPath, mimeFor, FsError } = require('../fs/explorer');
const ops = require('../fs/fileOps');
const { openWithSystem } = require('../bridge/taskFiles');
const { sendJson, readJsonBody } = require('./util');

// File explorer (per project, with ?projectId= or in the body):
//   GET  /api/fs/list?path=          GET /api/fs/preview?path=      GET /api/fs/raw?path=  (with Range)
//   POST /api/fs/rename {path, name} POST /api/fs/move {path, dest} POST /api/fs/copy {path, dest}
//   POST /api/fs/delete {path}       POST /api/fs/undo {undo}       POST /api/fs/open {path, reveal}
//   GET  /api/fs/trash               POST /api/fs/trash/restore {id} POST /api/fs/trash/purge {ids?}

// What is served raw can never run anything on optimia's origin (an .svg or .html with scripts from
// the repo): sandbox CSP and no sniffing.
const RAW_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store'
};

function serveRaw(req, res, abs) {
  const stat = fs.statSync(abs);
  if (!stat.isFile()) throw new FsError(400, 'no es un fichero');
  const mime = mimeFor(abs);
  const type = /^(image|audio|video)\//.test(mime) || mime === 'application/pdf' ? mime : 'text/plain; charset=utf-8';
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : stat.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : stat.size - 1;
    start = Math.max(0, start);
    end = Math.min(stat.size - 1, end);
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    res.writeHead(206, {
      ...RAW_HEADERS,
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Content-Length': end - start + 1
    });
    return fs.createReadStream(abs, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...RAW_HEADERS, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': stat.size });
  return fs.createReadStream(abs).pipe(res);
}

async function handleFsRoutes(req, res, url, { registry }) {
  const p = url.pathname;
  const q = url.searchParams;
  const rootOf = (projectId) => {
    const info = registry.info(projectId);
    if (!info) throw new FsError(404, 'proyecto desconocido');
    return info.root;
  };
  try {
    if (req.method === 'GET') {
      if (p === '/api/fs/list') return sendJson(res, 200, listDir(rootOf(q.get('projectId')), q.get('path') || ''));
      if (p === '/api/fs/preview') return sendJson(res, 200, preview(rootOf(q.get('projectId')), q.get('path') || ''));
      if (p === '/api/fs/raw') {
        const { abs } = resolveRepoPath(rootOf(q.get('projectId')), q.get('path') || '', { allowRoot: false });
        return serveRaw(req, res, abs);
      }
      if (p === '/api/fs/trash') {
        const projectId = q.get('projectId');
        return sendJson(res, 200, { items: ops.listTrash({ repoRoot: projectId ? rootOf(projectId) : undefined }) });
      }
      return null;
    }
    if (req.method !== 'POST' || !p.startsWith('/api/fs/')) return null;
    const body = await readJsonBody(req).catch(() => null);
    if (!body) return sendJson(res, 400, { error: 'invalid JSON body' });

    if (p === '/api/fs/trash/restore') return sendJson(res, 200, ops.restore(body.id));
    if (p === '/api/fs/trash/purge') {
      const repoRoot = body.projectId ? rootOf(body.projectId) : undefined;
      return sendJson(res, 200, {
        purged: ops.purge({ ids: Array.isArray(body.ids) ? body.ids : undefined, repoRoot })
      });
    }

    const root = rootOf(body.projectId);
    if (p === '/api/fs/rename') return sendJson(res, 200, ops.rename(root, body.path, body.name));
    if (p === '/api/fs/move') return sendJson(res, 200, ops.move(root, body.path, body.dest));
    if (p === '/api/fs/copy') return sendJson(res, 200, ops.copy(root, body.path, body.dest));
    if (p === '/api/fs/delete') return sendJson(res, 200, ops.trash(root, body.path, { projectId: body.projectId }));
    if (p === '/api/fs/undo') return sendJson(res, 200, ops.undo(root, body.undo, { projectId: body.projectId }));
    if (p === '/api/fs/open') {
      const { abs } = resolveRepoPath(root, body.path || '');
      await openWithSystem(abs, { reveal: body.reveal === true });
      return sendJson(res, 200, { ok: true });
    }
  } catch (err) {
    const status = err instanceof FsError ? err.status : err.code === 'ENOENT' ? 404 : 400;
    if (!res.headersSent) return sendJson(res, status, { error: err.message });
    return undefined;
  }
  return null;
}

module.exports = { handleFsRoutes, serveRaw, RAW_HEADERS };
