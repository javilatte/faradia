'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataDir } = require('../store/globalPaths');
const portable = require('../config/portable');
const wbStore = require('../store/workbenchStore');
const { loadMemory, saveMemory } = require('../store/memoryStore');
const wiki = require('./wikiStore');
const pkg = require('../../package.json');

// Everything Faradia learns, in one file: the configuration (instructions, agents, models...), the
// wikis (personal and of every project) and each repo's memory. It is what a user carries between
// machines (work, home...), and the unit the future auto-sync will exchange.
//
// Items are keyed so they mean the same on every machine: wiki pages by wiki key + path, memories by
// project key (from the git remote). Each carries its updatedAt and a content hash, so importing
// merges: new items are added, the newer side wins, and whatever gets replaced is backed up first.

const FORMAT = 'faradia-knowledge';
const FORMAT_VERSION = 1;
const MAX_ITEMS = 20_000;
const MAX_ITEM_BYTES = 512 * 1024;

const hash = (text) => crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16);

function memoriesDir() {
  return path.join(wiki.knowledgeDir(), 'memories');
}

// Repos known on this machine (every workbench), with their project key.
function knownRepos() {
  const roots = new Set();
  for (const wb of wbStore.listWorkbenches().workbenches) for (const r of wb.repos) roots.add(r);
  for (const w of wiki.listProjectWikis()) for (const p of w.paths) roots.add(p);
  return [...roots]
    .filter((root) => fs.existsSync(root))
    .map((root) => ({ root, key: wiki.projectKey(root), title: path.basename(root) }));
}

function wikiExport(target) {
  return {
    scope: target.scope,
    key: target.key,
    title: target.title,
    pages: wiki.listPages(target).map((p) => {
      const content = fs.readFileSync(path.join(target.dir, p.path), 'utf8');
      return { path: p.path, content, updatedAt: p.updatedAt, hash: hash(content) };
    })
  };
}

function memoryFile(root) {
  return path.join(root, '.faradia', 'memory.md');
}

/** The whole knowledge, as one JSON-serializable object. */
function exportKnowledge({ includeSecrets = false } = {}) {
  const wikis = [];
  const personal = wiki.ensureWiki(wiki.wikiFor('personal'));
  wikis.push(wikiExport(personal));
  const root = path.join(wiki.wikisDir(), 'projects');
  for (const w of wiki.listProjectWikis()) {
    wikis.push(wikiExport({ scope: 'project', key: w.key, title: w.title, dir: path.join(root, w.key) }));
  }
  const memories = new Map();
  // Memories imported earlier for repos this machine does not have yet.
  try {
    for (const name of fs.readdirSync(memoriesDir())) {
      if (!name.endsWith('.md')) continue;
      const file = path.join(memoriesDir(), name);
      const content = fs.readFileSync(file, 'utf8');
      memories.set(name.slice(0, -3), {
        key: name.slice(0, -3),
        title: name.slice(0, -3),
        content,
        updatedAt: fs.statSync(file).mtime.toISOString()
      });
    }
  } catch {
    /* none */
  }
  for (const repo of knownRepos()) {
    const content = loadMemory(repo.root);
    if (!content.trim()) continue;
    const updatedAt = fs.statSync(memoryFile(repo.root)).mtime.toISOString();
    const prev = memories.get(repo.key);
    if (!prev || prev.updatedAt < updatedAt)
      memories.set(repo.key, { key: repo.key, title: repo.title, content, updatedAt });
  }
  return {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    faradiaVersion: pkg.version,
    config: portable.exportConfig({ includeSecrets }),
    wikis,
    memories: [...memories.values()].map((m) => ({ ...m, hash: hash(m.content) }))
  };
}

class KnowledgeError extends Error {}

const SAFE_KEY = /^[a-z0-9][a-z0-9.-]{0,119}$/;

function validate(raw) {
  if (!raw || typeof raw !== 'object' || raw.format !== FORMAT) {
    throw new KnowledgeError('no es un fichero de conocimiento de faradia');
  }
  if (raw.formatVersion !== FORMAT_VERSION) {
    throw new KnowledgeError(
      `formato ${raw.formatVersion} no compatible con esta versión de Faradia; actualiza faradia`
    );
  }
  const wikis = Array.isArray(raw.wikis) ? raw.wikis : [];
  const memories = Array.isArray(raw.memories) ? raw.memories : [];
  let count = 0;
  for (const w of wikis) {
    if (!w || !['personal', 'project'].includes(w.scope)) throw new KnowledgeError('wiki con ámbito no válido');
    if (w.scope === 'project' && !SAFE_KEY.test(String(w.key)))
      throw new KnowledgeError(`clave de wiki no válida: ${w.key}`);
    for (const p of w.pages || []) {
      count++;
      if (typeof p.path !== 'string' || typeof p.content !== 'string') throw new KnowledgeError('página no válida');
      if (Buffer.byteLength(p.content) > MAX_ITEM_BYTES) throw new KnowledgeError(`página demasiado grande: ${p.path}`);
    }
  }
  for (const m of memories) {
    count++;
    if (!SAFE_KEY.test(String(m.key)) || typeof m.content !== 'string') throw new KnowledgeError('memoria no válida');
  }
  if (count > MAX_ITEMS) throw new KnowledgeError('demasiados elementos');
  return {
    wikis,
    memories,
    config: raw.config || null,
    exportedAt: raw.exportedAt,
    faradiaVersion: raw.faradiaVersion
  };
}

function targetWiki(w) {
  if (w.scope === 'personal') return wiki.wikiFor('personal');
  return { scope: 'project', key: w.key, title: w.title || w.key, dir: path.join(wiki.wikisDir(), 'projects', w.key) };
}

// What importing would do with one item, comparing content and dates.
function decide(local, incoming) {
  if (!local) return 'add';
  if (hash(local.content) === hash(incoming.content)) return 'same';
  return String(incoming.updatedAt || '') > String(local.updatedAt || '') ? 'update' : 'keep';
}

/** {pages: {add, update, keep, same}, memories: {...}, config} without changing anything. */
function plan(raw) {
  const data = validate(raw);
  const out = {
    pages: { add: [], update: [], keep: [], same: [] },
    memories: { add: [], update: [], keep: [], same: [] }
  };
  for (const w of data.wikis) {
    const target = targetWiki(w);
    for (const p of w.pages || []) {
      const page = wiki.safePage(target, p.path);
      if (!page) continue;
      const local = fs.existsSync(page.abs)
        ? { content: fs.readFileSync(page.abs, 'utf8'), updatedAt: fs.statSync(page.abs).mtime.toISOString() }
        : null;
      out.pages[decide(local, p)].push({
        wiki: target.scope === 'personal' ? 'personal' : target.key,
        path: page.rel,
        target,
        page,
        incoming: p
      });
    }
  }
  const repos = knownRepos();
  for (const m of data.memories) {
    const repo = repos.find((r) => r.key === m.key);
    const file = repo ? memoryFile(repo.root) : path.join(memoriesDir(), `${m.key}.md`);
    const local = fs.existsSync(file)
      ? { content: fs.readFileSync(file, 'utf8'), updatedAt: fs.statSync(file).mtime.toISOString() }
      : null;
    out.memories[decide(local, m)].push({ key: m.key, repo: repo?.root || null, file, incoming: m });
  }
  out.config = data.config ? portable.previewImport(data.config) : null;
  out.exportedAt = data.exportedAt;
  out.faradiaVersion = data.faradiaVersion;
  return out;
}

function summary(p) {
  const strip = (list) =>
    list.map(({ wiki: w, path: rel, key, repo }) => (key ? { key, repo } : { wiki: w, path: rel }));
  return {
    exportedAt: p.exportedAt,
    faradiaVersion: p.faradiaVersion,
    pages: Object.fromEntries(Object.entries(p.pages).map(([k, v]) => [k, strip(v)])),
    memories: Object.fromEntries(Object.entries(p.memories).map(([k, v]) => [k, strip(v)])),
    config: p.config
  };
}

function previewKnowledge(raw) {
  return summary(plan(raw));
}

// Copies a file that is about to be replaced into <data>/knowledge-backups/<stamp>/.
function backup(stamp, file, rel) {
  if (!fs.existsSync(file)) return;
  const dest = path.join(dataDir(), 'knowledge-backups', stamp, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(file, dest);
}

/** Merges the bundle: adds what is new, updates what is newer there. `withConfig` also imports the configuration. */
function importKnowledge(raw, { withConfig = true } = {}) {
  const p = plan(raw);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const item of [...p.pages.add, ...p.pages.update]) {
    backup(stamp, item.page.abs, path.join('wikis', path.relative(wiki.wikisDir(), item.page.abs)));
    wiki.ensureWiki(item.target);
    fs.mkdirSync(path.dirname(item.page.abs), { recursive: true });
    fs.writeFileSync(item.page.abs, item.incoming.content);
    if (item.incoming.updatedAt) {
      const t = new Date(item.incoming.updatedAt);
      if (!Number.isNaN(t.getTime())) fs.utimesSync(item.page.abs, t, t);
    }
  }
  for (const item of [...p.memories.add, ...p.memories.update]) {
    backup(stamp, item.file, path.join('memories', `${item.key}.md`));
    if (item.repo) saveMemory(item.repo, item.incoming.content);
    else {
      fs.mkdirSync(memoriesDir(), { recursive: true });
      fs.writeFileSync(item.file, item.incoming.content);
    }
  }
  let config = null;
  if (withConfig && raw.config) config = portable.importConfig(raw.config);
  return { ...summary(p), configImported: Boolean(config), backup: stamp };
}

/** Memories imported for a repo this machine did not have: applied when the repo shows up. */
function adoptPendingMemory(projectRoot) {
  const file = path.join(memoriesDir(), `${wiki.projectKey(projectRoot)}.md`);
  if (!fs.existsSync(file) || loadMemory(projectRoot).trim()) return false;
  saveMemory(projectRoot, fs.readFileSync(file, 'utf8'));
  return true;
}

module.exports = {
  FORMAT,
  KnowledgeError,
  exportKnowledge,
  previewKnowledge,
  importKnowledge,
  adoptPendingMemory
};
