'use strict';

const wiki = require('../knowledge/wikiStore');
const { sendJson, readJsonBody } = require('./util');

// Wiki routes (global: the project wiki is chosen with ?projectId=, the personal one with
// ?scope=personal):
//   GET    /api/wiki?scope=&projectId=            {wiki, pages}
//   GET    /api/wiki/page?scope=&projectId=&path= {path, title, content, backlinks}
//   PUT    /api/wiki/page {scope, projectId, path, content}
//   DELETE /api/wiki/page {scope, projectId, path}
//   GET    /api/wiki/search?scope=&projectId=&q=  [{path, title, score, snippet}]
//   GET    /api/wiki/graph?scope=&projectId=      {nodes, edges, missing}
//   GET    /api/wiki/projects                     every project wiki on this machine

async function handleWikiRoutes(req, res, url, { registry, onChange }) {
  const p = url.pathname;
  if (!p.startsWith('/api/wiki')) return null;

  if (p === '/api/wiki/projects' && req.method === 'GET') {
    return sendJson(res, 200, { wikis: wiki.listProjectWikis() });
  }

  let body = null;
  if (req.method === 'PUT' || req.method === 'DELETE') {
    body = await readJsonBody(req).catch(() => null);
    if (!body) return sendJson(res, 400, { error: 'invalid JSON body' });
  }
  const q = url.searchParams;
  const scope = (body?.scope || q.get('scope') || 'project') === 'personal' ? 'personal' : 'project';
  const projectId = body?.projectId || q.get('projectId');
  let target;
  try {
    const root = scope === 'project' ? registry.info(projectId)?.root : undefined;
    if (scope === 'project' && !root) return sendJson(res, 404, { error: 'proyecto no encontrado' });
    target = wiki.ensureWiki(wiki.wikiFor(scope, root), root);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
  const view = { scope: target.scope, key: target.key, title: target.title };

  try {
    if (p === '/api/wiki' && req.method === 'GET') {
      return sendJson(res, 200, { wiki: view, pages: wiki.listPages(target) });
    }
    if (p === '/api/wiki/page' && req.method === 'GET') {
      const page = wiki.readPage(target, q.get('path') || 'index.md');
      if (!page) return sendJson(res, 404, { error: 'página no encontrada' });
      return sendJson(res, 200, page);
    }
    if (p === '/api/wiki/page' && req.method === 'PUT') {
      const page = wiki.writePage(target, body.path, body.content);
      onChange?.({ ...view, path: page.path });
      return sendJson(res, 200, page);
    }
    if (p === '/api/wiki/page' && req.method === 'DELETE') {
      if (!wiki.deletePage(target, body.path)) return sendJson(res, 404, { error: 'página no encontrada' });
      onChange?.({ ...view, path: body.path, deleted: true });
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/wiki/search' && req.method === 'GET') {
      return sendJson(res, 200, { results: wiki.search(target, q.get('q')) });
    }
    if (p === '/api/wiki/graph' && req.method === 'GET') {
      return sendJson(res, 200, wiki.graph(target));
    }
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
  return null;
}

module.exports = { handleWikiRoutes };
