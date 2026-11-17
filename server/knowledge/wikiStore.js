'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { dataDir } = require('../store/globalPaths');

// Wikis: markdown pages linked with [[wikilinks]] (or relative .md links), outside any repo so they
// can be exported and, later, synced between machines.
//
//   <data>/knowledge/wikis/personal/           what is useful across every project
//   <data>/knowledge/wikis/projects/<key>/     one per project; <key> comes from the git remote
//                                              (github.com-org-repo), the same on every machine
//
// Each wiki has an index.md (entry point) and a log.md (maintenance log the agents append to).

const PAGE_EXT = '.md';
const MAX_PAGE_BYTES = 512 * 1024;

function knowledgeDir() {
  return path.join(dataDir(), 'knowledge');
}

function wikisDir() {
  return path.join(knowledgeDir(), 'wikis');
}

// "git@github.com:org/Repo.git" / "https://github.com/org/repo" -> "github.com-org-repo".
function keyFromRemote(url) {
  const raw = String(url || '').trim();
  const m =
    /^[\w.-]+@([^:/]+):(.+?)(?:\.git)?\/?$/.exec(raw) ||
    /^(?:ssh|git|https?):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(raw);
  if (!m) return null;
  return slug(`${m[1]}-${m[2]}`);
}

function slug(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

/** Stable key of a project's wiki: its git remote (origin first) or, without one, its folder name. */
function projectKey(projectRoot) {
  try {
    const remotes = execFileSync('git', ['remote'], { cwd: projectRoot, encoding: 'utf8', stdio: 'pipe' })
      .split('\n')
      .filter(Boolean);
    const name = remotes.includes('origin') ? 'origin' : remotes[0];
    if (name) {
      const url = execFileSync('git', ['config', '--get', `remote.${name}.url`], {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: 'pipe'
      }).trim();
      const key = keyFromRemote(url);
      if (key) return key;
    }
  } catch {
    /* not a git repo or no remote */
  }
  return `local-${slug(path.basename(projectRoot))}`;
}

/** {scope, key, dir, title} of the wiki asked for. */
function wikiFor(scope, projectRoot) {
  if (scope === 'personal') {
    return { scope, key: 'personal', dir: path.join(wikisDir(), 'personal'), title: 'Wiki personal' };
  }
  if (scope !== 'project' || !projectRoot) throw new Error('scope debe ser "project" o "personal"');
  const key = projectKey(projectRoot);
  return { scope, key, dir: path.join(wikisDir(), 'projects', key), title: path.basename(projectRoot) };
}

// Creates index.md and log.md the first time, and remembers which local folders use this wiki.
function ensureWiki(wiki, projectRoot) {
  fs.mkdirSync(wiki.dir, { recursive: true });
  const index = path.join(wiki.dir, 'index.md');
  if (!fs.existsSync(index)) {
    const intro =
      wiki.scope === 'personal'
        ? 'Tu wiki personal: lo que te sirve en todos tus proyectos (preferencias, técnicas, herramientas, aprendizajes).'
        : `La wiki de ${wiki.title}: cómo funciona, decisiones, guías y aprendizajes. Los agentes la actualizan al terminar cada tarea.`;
    fs.writeFileSync(index, `# ${wiki.title}\n\n${intro}\n\n## Páginas\n\n`);
  }
  const log = path.join(wiki.dir, 'log.md');
  if (!fs.existsSync(log)) fs.writeFileSync(log, '# Registro de mantenimiento\n\n');
  if (projectRoot) {
    const metaFile = path.join(wiki.dir, '.wiki.json');
    let meta = {};
    try {
      meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    } catch {
      /* first time */
    }
    const paths = new Set(meta.paths || []);
    if (!paths.has(projectRoot)) {
      paths.add(projectRoot);
      fs.writeFileSync(
        metaFile,
        JSON.stringify({ ...meta, key: wiki.key, title: wiki.title, paths: [...paths] }, null, 2) + '\n'
      );
    }
  }
  return wiki;
}

// A page path inside the wiki (relative, .md, no .. or hidden parts), or null.
function safePage(wiki, rel) {
  if (typeof rel !== 'string' || !rel.trim()) return null;
  let clean = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean.endsWith(PAGE_EXT)) clean += PAGE_EXT;
  const parts = clean.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || p.startsWith('.'))) return null;
  const abs = path.join(wiki.dir, ...parts);
  if (!abs.startsWith(wiki.dir + path.sep)) return null;
  return { rel: parts.join('/'), abs };
}

function walk(dir, base = dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, base, out);
    else if (e.name.endsWith(PAGE_EXT)) out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return out;
}

function titleOf(text, rel) {
  const m = /^#\s+(.+)$/m.exec(text);
  return m ? m[1].trim() : path.basename(rel, PAGE_EXT).replace(/[-_]/g, ' ');
}

/** Pages of a wiki: [{path, title, size, updatedAt}], sorted by path. */
function listPages(wiki) {
  return walk(wiki.dir)
    .sort()
    .map((rel) => {
      const abs = path.join(wiki.dir, rel);
      const stat = fs.statSync(abs);
      const text = fs.readFileSync(abs, 'utf8');
      return { path: rel, title: titleOf(text, rel), size: stat.size, updatedAt: stat.mtime.toISOString() };
    });
}

function readPage(wiki, rel) {
  const page = safePage(wiki, rel);
  if (!page || !fs.existsSync(page.abs)) return null;
  const content = fs.readFileSync(page.abs, 'utf8');
  return {
    path: page.rel,
    title: titleOf(content, page.rel),
    content,
    updatedAt: fs.statSync(page.abs).mtime.toISOString(),
    backlinks: backlinksOf(wiki, page.rel)
  };
}

function writePage(wiki, rel, content) {
  const page = safePage(wiki, rel);
  if (!page) throw new Error('ruta de página no válida');
  if (typeof content !== 'string') throw new Error('content debe ser texto');
  if (Buffer.byteLength(content) > MAX_PAGE_BYTES) throw new Error('la página es demasiado grande');
  fs.mkdirSync(path.dirname(page.abs), { recursive: true });
  fs.writeFileSync(page.abs, content.endsWith('\n') ? content : `${content}\n`);
  return readPage(wiki, page.rel);
}

function deletePage(wiki, rel) {
  const page = safePage(wiki, rel);
  if (!page || !fs.existsSync(page.abs)) return false;
  if (page.rel === 'index.md') throw new Error('index.md es la portada de la wiki: edítala en vez de borrarla');
  fs.rmSync(page.abs);
  return true;
}

// Links of a page: [[Target]] / [[Target|text]] and relative markdown links to .md files. Targets
// are resolved to page paths (by path, file name or title).
function linksOf(text) {
  const out = [];
  for (const m of String(text).matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) out.push(m[1].trim());
  for (const m of String(text).matchAll(/\]\(([^)\s]+?\.md)(?:#[^)]*)?\)/g)) {
    if (!/^[a-z]+:/i.test(m[1])) out.push(m[1]);
  }
  return out;
}

function resolver(pages, fromRel = '') {
  const byPath = new Map(pages.map((p) => [p.path.toLowerCase(), p.path]));
  const byName = new Map();
  const byTitle = new Map();
  for (const p of pages) {
    byName.set(path.posix.basename(p.path, PAGE_EXT).toLowerCase(), p.path);
    byTitle.set(p.title.toLowerCase(), p.path);
  }
  return (target) => {
    const t = target.replace(/\\/g, '/');
    const rel = t.endsWith(PAGE_EXT) ? path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), t)) : null;
    if (rel && byPath.has(rel.toLowerCase())) return byPath.get(rel.toLowerCase());
    const lower = t.toLowerCase();
    if (byPath.has(lower)) return byPath.get(lower);
    if (byPath.has(`${lower}${PAGE_EXT}`)) return byPath.get(`${lower}${PAGE_EXT}`);
    const name = path.posix.basename(lower, PAGE_EXT);
    return byName.get(name) || byName.get(slug(name)) || byTitle.get(lower) || null;
  };
}

/** The wiki as a map: {nodes: [{id, title, links}], edges: [{from, to}], missing: [{from, target}]}. */
function graph(wiki) {
  const pages = listPages(wiki);
  const edges = [];
  const missing = [];
  const nodes = pages.map((p) => ({ id: p.path, title: p.title, size: p.size }));
  for (const p of pages) {
    const text = fs.readFileSync(path.join(wiki.dir, p.path), 'utf8');
    const resolve = resolver(pages, p.path);
    const seen = new Set();
    for (const target of linksOf(text)) {
      const to = resolve(target);
      if (!to) missing.push({ from: p.path, target });
      else if (to !== p.path && !seen.has(to)) {
        seen.add(to);
        edges.push({ from: p.path, to });
      }
    }
  }
  const degree = new Map();
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) || 0) + 1);
    degree.set(e.to, (degree.get(e.to) || 0) + 1);
  }
  for (const n of nodes) n.links = degree.get(n.id) || 0;
  return { nodes, edges, missing };
}

function backlinksOf(wiki, rel) {
  return graph(wiki)
    .edges.filter((e) => e.to === rel)
    .map((e) => e.from);
}

/** Full-text search: [{path, title, score, snippet}] (title matches first). */
function search(wiki, query, { limit = 30 } = {}) {
  const terms = String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
  if (!terms.length) return [];
  const results = [];
  for (const p of listPages(wiki)) {
    const text = fs.readFileSync(path.join(wiki.dir, p.path), 'utf8');
    const lower = text.toLowerCase();
    const title = p.title.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (!lower.includes(t) && !title.includes(t) && !p.path.toLowerCase().includes(t)) {
        score = 0;
        break;
      }
      if (title.includes(t)) score += 10;
      if (p.path.toLowerCase().includes(t)) score += 4;
      score += Math.min(10, lower.split(t).length - 1);
    }
    if (!score) continue;
    const at = lower.indexOf(terms[0]);
    const start = Math.max(0, at - 60);
    const snippet =
      (start > 0 ? '…' : '') +
      text
        .slice(start, at + 140)
        .replace(/\s+/g, ' ')
        .trim() +
      '…';
    results.push({ path: p.path, title: p.title, score, snippet });
  }
  return results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
}

/** Every project wiki known on this machine: [{key, title, paths, pages}]. */
function listProjectWikis() {
  const root = path.join(wikisDir(), 'projects');
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
  return dirs.map((d) => {
    let meta = {};
    try {
      meta = JSON.parse(fs.readFileSync(path.join(root, d.name, '.wiki.json'), 'utf8'));
    } catch {
      /* no metadata */
    }
    return {
      key: d.name,
      title: meta.title || d.name,
      paths: meta.paths || [],
      pages: walk(path.join(root, d.name)).length
    };
  });
}

module.exports = {
  knowledgeDir,
  wikisDir,
  keyFromRemote,
  projectKey,
  wikiFor,
  ensureWiki,
  safePage,
  listPages,
  readPage,
  writePage,
  deletePage,
  linksOf,
  graph,
  search,
  listProjectWikis
};
