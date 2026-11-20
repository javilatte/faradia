'use strict';

const fs = require('fs');
const path = require('path');
const wiki = require('./wikiStore');

// The code map: an overview of a repo taken from CodeGraph's index (<repo>/.codegraph/codegraph.db)
// with no model involved. The central pieces are the symbols used from the most other files; the
// areas are the main folders and which ones each depends on. Faradia writes it as a wiki page,
// refreshed after every task, and gives it to "Conocer este repo" and to the agent that writes the
// wiki, so they start from the real structure instead of reading the repo blind.

const USE_EDGES = ['calls', 'instantiates', 'references', 'extends', 'implements', 'decorates', 'imports'];
const PIECE_KINDS = ['class', 'function', 'method', 'interface', 'type', 'type_alias', 'struct', 'trait', 'enum'];
// Folders that hold code by kind rather than by area: the area is the folder below them.
const CONTAINERS = new Set([
  'src',
  'lib',
  'app',
  'apps',
  'packages',
  'internal',
  'pkg',
  'cmd',
  'server',
  'web',
  'source'
]);

const TEST_RE =
  /(^|\/)(__tests__|__mocks__|tests?|spec|e2e|testing|test-helpers|fixtures)\/|(\.|_|-)(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.go$/i;
const ASIDE_RE = /(^|\/)(examples?|docs?|demo|benchmarks?|scripts|vendor|third_party|dist|build|out|node_modules)\//i;

function role(file) {
  if (TEST_RE.test(file)) return 'test';
  if (ASIDE_RE.test(file)) return 'aside';
  return 'core';
}

function areaOf(file) {
  const parts = file.split('/');
  if (parts.length === 1) return '(raíz)';
  if (CONTAINERS.has(parts[0]) && parts.length > 2) return `${parts[0]}/${parts[1]}`;
  return parts[0];
}

function dbPath(projectRoot) {
  return path.join(projectRoot, '.codegraph', 'codegraph.db');
}

function openDb(file) {
  let sqlite;
  // Built into Node from 22.13 on (earlier 22.x needs a flag): without it there is no map. Node
  // still calls it experimental: that one warning is kept out of Faradia's terminal.
  const emitWarning = process.emitWarning;
  process.emitWarning = (warning, ...rest) =>
    /SQLite/i.test(String(warning?.message ?? warning)) ? undefined : emitWarning.call(process, warning, ...rest);
  try {
    sqlite = require('node:sqlite');
  } catch {
    return null;
  } finally {
    process.emitWarning = emitWarning;
  }
  try {
    return new sqlite.DatabaseSync(file, { readOnly: true });
  } catch {
    return null;
  }
}

/**
 * The map of a repo, or null when CodeGraph is not enabled there (or its index cannot be read).
 * {indexedAt, files, symbols, pieces: [{name, kind, file, line, files, testFiles}], areas: [{area,
 * files, symbols, uses: [{area, n}], usedBy}]}
 */
function buildRepoMap(projectRoot, { maxPieces = 12, maxAreas = 14 } = {}) {
  const file = dbPath(projectRoot);
  if (!fs.existsSync(file)) return null;
  const db = openDb(file);
  if (!db) return null;
  try {
    const files = db.prepare('SELECT path, indexed_at, generated FROM files').all();
    const coreFiles = new Set(files.filter((f) => !f.generated && role(f.path) === 'core').map((f) => f.path));
    const generated = new Set(files.filter((f) => f.generated).map((f) => f.path));
    if (!coreFiles.size) return null;
    const placeholders = (list) => list.map(() => '?').join(',');

    // Central pieces: used from the most other files.
    const uses = db
      .prepare(
        `SELECT t.id, t.kind, t.name, t.file_path AS file, t.start_line AS line, s.file_path AS fromFile
         FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE e.kind IN (${placeholders(USE_EDGES)}) AND t.kind IN (${placeholders(PIECE_KINDS)})
           AND s.file_path != t.file_path`
      )
      .all(...USE_EDGES, ...PIECE_KINDS);
    const byPiece = new Map();
    for (const u of uses) {
      if (!coreFiles.has(u.file) || generated.has(u.fromFile)) continue;
      const p = byPiece.get(u.id) || { name: u.name, kind: u.kind, file: u.file, line: u.line, from: new Set() };
      p.from.add(u.fromFile);
      byPiece.set(u.id, p);
    }
    const pieces = [...byPiece.values()]
      .map((p) => {
        const from = [...p.from];
        return {
          name: p.name,
          kind: p.kind,
          file: p.file,
          line: p.line,
          files: from.length,
          testFiles: from.filter((f) => role(f) === 'test').length
        };
      })
      .filter((p) => p.files - p.testFiles >= 2 || p.files >= 4)
      // Use from the main code first: tests call everything public.
      .sort(
        (a, b) => b.files - b.testFiles - (a.files - a.testFiles) || b.files - a.files || a.name.localeCompare(b.name)
      )
      .slice(0, maxPieces);

    // Areas and the dependencies between them (core code only).
    const symbolsPerFile = new Map(
      db
        .prepare("SELECT file_path AS file, COUNT(*) AS n FROM nodes WHERE kind != 'file' GROUP BY file_path")
        .all()
        .map((r) => [r.file, r.n])
    );
    // Only files with code (not config or CI files). With fewer than three folders the areas are the
    // files themselves, or the map would say nothing.
    const codeFiles = new Set([...coreFiles].filter((f) => symbolsPerFile.get(f)));
    const folders = new Set([...codeFiles].map(areaOf));
    const areaOfFile = folders.size >= 3 ? areaOf : (f) => f;
    const areas = new Map();
    const areaFor = (name) => {
      if (!areas.has(name)) areas.set(name, { area: name, files: 0, symbols: 0, uses: new Map(), usedBy: 0 });
      return areas.get(name);
    };
    for (const f of codeFiles) {
      const a = areaFor(areaOfFile(f));
      a.files += 1;
      a.symbols += symbolsPerFile.get(f) || 0;
    }
    const links = db
      .prepare(
        `SELECT s.file_path AS fromFile, t.file_path AS toFile, COUNT(*) AS n
         FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE e.kind IN (${placeholders(USE_EDGES)}) AND s.file_path != t.file_path
         GROUP BY s.file_path, t.file_path`
      )
      .all(...USE_EDGES);
    for (const l of links) {
      if (!codeFiles.has(l.fromFile) || !codeFiles.has(l.toFile)) continue;
      const from = areaOfFile(l.fromFile);
      const to = areaOfFile(l.toFile);
      if (from === to) continue;
      const a = areaFor(from);
      a.uses.set(to, (a.uses.get(to) || 0) + l.n);
      areaFor(to).usedBy += l.n;
    }
    const areaList = [...areas.values()]
      .map((a) => ({
        area: a.area,
        files: a.files,
        symbols: a.symbols,
        usedBy: a.usedBy,
        uses: [...a.uses.entries()]
          .map(([area, n]) => ({ area, n }))
          .sort((x, y) => y.n - x.n)
          .slice(0, 4)
      }))
      .sort((x, y) => y.usedBy - x.usedBy || y.symbols - x.symbols || x.area.localeCompare(y.area))
      .slice(0, maxAreas);

    const indexedAt = Math.max(0, ...files.map((f) => Number(f.indexed_at) || 0));
    return {
      indexedAt: indexedAt ? new Date(indexedAt > 1e12 ? indexedAt : indexedAt * 1000).toISOString() : null,
      files: codeFiles.size,
      symbols: [...codeFiles].reduce((n, f) => n + (symbolsPerFile.get(f) || 0), 0),
      byFile: folders.size < 3,
      pieces,
      areas: areaList
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

const TEXT = {
  es: {
    title: 'Mapa del código',
    intro: (m) =>
      `Generado por Faradia a partir del índice de CodeGraph${m.indexedAt ? ` (${m.indexedAt.slice(0, 10)})` : ''}: ${m.files} ficheros y ${m.symbols} símbolos del código principal, sin tests, ejemplos ni documentación. Se actualiza solo después de cada tarea; no lo edites a mano.`,
    pieces: 'Piezas centrales',
    piecesIntro: 'Las más usadas desde otros ficheros: por aquí pasa casi todo.',
    piece: 'Pieza',
    where: 'Dónde',
    usedFrom: 'Usada desde',
    nFiles: (p) =>
      `${p.files} ${p.files === 1 ? 'fichero' : 'ficheros'}${p.testFiles ? ` (${p.testFiles} de tests)` : ''}`,
    areas: 'Zonas',
    areasIntro: (m) =>
      m.byFile
        ? 'Los ficheros, de los más usados por los demás a los menos, y de qué depende cada uno.'
        : 'Las carpetas principales, de las más usadas por las demás a las menos, y de qué depende cada una.',
    area: (m) => (m.byFile ? 'Fichero' : 'Zona'),
    size: 'Tamaño',
    dependsOn: 'Depende de',
    nSize: (a) =>
      a.files === 1
        ? `${a.symbols} ${a.symbols === 1 ? 'símbolo' : 'símbolos'}`
        : `${a.files} ficheros · ${a.symbols} símbolos`,
    nothing: '—',
    kinds: {
      class: 'clase',
      function: 'función',
      method: 'método',
      interface: 'interfaz',
      type: 'tipo',
      struct: 'struct',
      trait: 'trait',
      enum: 'enum',
      type_alias: 'tipo'
    }
  },
  en: {
    title: 'Code map',
    intro: (m) =>
      `Generated by Faradia from CodeGraph's index${m.indexedAt ? ` (${m.indexedAt.slice(0, 10)})` : ''}: ${m.files} files and ${m.symbols} symbols of the main code, without tests, examples or docs. It updates itself after every task; do not edit it by hand.`,
    pieces: 'Central pieces',
    piecesIntro: 'The ones used from the most other files: almost everything goes through them.',
    piece: 'Piece',
    where: 'Where',
    usedFrom: 'Used from',
    nFiles: (p) => `${p.files} ${p.files === 1 ? 'file' : 'files'}${p.testFiles ? ` (${p.testFiles} tests)` : ''}`,
    areas: 'Areas',
    areasIntro: (m) =>
      `${m.byFile ? 'The files' : 'The main folders'}, from the most used by the others to the least, and what each depends on.`,
    area: (m) => (m.byFile ? 'File' : 'Area'),
    size: 'Size',
    dependsOn: 'Depends on',
    nSize: (a) =>
      a.files === 1
        ? `${a.symbols} ${a.symbols === 1 ? 'symbol' : 'symbols'}`
        : `${a.files} files · ${a.symbols} symbols`,
    nothing: '—',
    kinds: {}
  }
};

const cell = (s) => String(s).replace(/\|/g, '\\|');

/** The map as markdown, in Spanish or English. */
function renderRepoMap(map, lang = 'es') {
  const t = TEXT[lang === 'en' ? 'en' : 'es'];
  const lines = [`# ${t.title}`, '', t.intro(map), ''];
  if (map.pieces.length) {
    lines.push(`## ${t.pieces}`, '', t.piecesIntro, '', `| ${t.piece} | ${t.where} | ${t.usedFrom} |`, '|---|---|---|');
    for (const p of map.pieces) {
      lines.push(`| \`${cell(p.name)}\` (${t.kinds[p.kind] || p.kind}) | ${cell(p.file)}:${p.line} | ${t.nFiles(p)} |`);
    }
    lines.push('');
  }
  if (map.areas.length) {
    lines.push(
      `## ${t.areas}`,
      '',
      t.areasIntro(map),
      '',
      `| ${t.area(map)} | ${t.size} | ${t.dependsOn} |`,
      '|---|---|---|'
    );
    for (const a of map.areas) {
      const deps = a.uses.map((u) => `${u.area} (${u.n})`).join(', ') || t.nothing;
      lines.push(`| ${cell(a.area)} | ${t.nSize(a)} | ${cell(deps)} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

const PAGE = { es: 'mapa-del-codigo.md', en: 'code-map.md' };

// The wiki's language: the one its earlier map page is in, else the one asked for.
function pageFor(dir, lang) {
  if (fs.existsSync(path.join(dir, PAGE.en))) return { rel: PAGE.en, lang: 'en' };
  if (fs.existsSync(path.join(dir, PAGE.es))) return { rel: PAGE.es, lang: 'es' };
  return lang === 'en' ? { rel: PAGE.en, lang: 'en' } : { rel: PAGE.es, lang: 'es' };
}

/**
 * Writes (or refreshes) the code map page of the repo's wiki and links it from index.md. Returns the
 * page's path in the wiki, or null when there is no CodeGraph index.
 */
function writeRepoMapPage(projectRoot, { lang = 'es' } = {}) {
  const map = buildRepoMap(projectRoot);
  if (!map) return null;
  const target = wiki.ensureWiki(wiki.wikiFor('project', projectRoot), projectRoot);
  const page = pageFor(target.dir, lang);
  wiki.writePage(target, page.rel, renderRepoMap(map, page.lang));
  const index = path.join(target.dir, 'index.md');
  const title = TEXT[page.lang].title;
  try {
    const text = fs.readFileSync(index, 'utf8');
    if (!text.includes(`[[${title}]]`)) {
      const line =
        page.lang === 'en'
          ? `- [[${title}]]: central pieces and areas of the code, from CodeGraph's index (updates itself).`
          : `- [[${title}]]: piezas centrales y zonas del código, sacadas del índice de CodeGraph (se actualiza solo).`;
      fs.writeFileSync(index, `${text.replace(/\s*$/, '')}\n${line}\n`);
    }
  } catch {
    /* no index: ensureWiki creates it */
  }
  return page.rel;
}

module.exports = { buildRepoMap, renderRepoMap, writeRepoMapPage, areaOf, role, PAGE };
