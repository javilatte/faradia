'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mkTmpDir, rmTmpDir } = require('./helpers');
const { buildRepoMap, renderRepoMap, writeRepoMapPage, areaOf, role } = require('../../server/knowledge/repoMap');
const wiki = require('../../server/knowledge/wikiStore');
const { buildStagePrompt } = require('../../server/bridge/taskStages');

let sqlite = null;
try {
  sqlite = require('node:sqlite');
} catch {
  /* Node without node:sqlite: the map is simply not built */
}

// A CodeGraph index with the tables and columns repoMap.js reads.
function fakeIndex(root, { files, symbols, edges }) {
  fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true });
  const db = new sqlite.DatabaseSync(path.join(root, '.codegraph', 'codegraph.db'));
  db.exec(`
    CREATE TABLE files (path TEXT PRIMARY KEY, indexed_at INTEGER, generated INTEGER DEFAULT 0);
    CREATE TABLE nodes (id TEXT PRIMARY KEY, kind TEXT, name TEXT, file_path TEXT, start_line INTEGER);
    CREATE TABLE edges (id INTEGER PRIMARY KEY, source TEXT, target TEXT, kind TEXT);
  `);
  const addFile = db.prepare('INSERT INTO files VALUES (?, ?, ?)');
  const addNode = db.prepare('INSERT INTO nodes VALUES (?, ?, ?, ?, ?)');
  const addEdge = db.prepare('INSERT INTO edges (source, target, kind) VALUES (?, ?, ?)');
  for (const f of files) {
    addFile.run(f, 1_763_600_000_000, f.includes('generated') ? 1 : 0);
    addNode.run(`file:${f}`, 'file', path.basename(f), f, 0);
  }
  for (const [id, kind, name, file, line] of symbols) addNode.run(id, kind, name, file, line);
  for (const [source, target, kind = 'calls'] of edges) addEdge.run(source, target, kind);
  db.close();
}

function isolatedRepo(t) {
  const root = mkTmpDir('repomap');
  const cfg = mkTmpDir('repomap-config');
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = cfg;
  t.after(() => {
    process.env.XDG_CONFIG_HOME = prev;
    rmTmpDir(root);
    rmTmpDir(cfg);
  });
  return root;
}

const FILES = [
  'src/core/app.js',
  'src/core/router.js',
  'src/http/server.js',
  'src/http/body.js',
  'src/store/db.js',
  'src/generated/schema.js',
  'test/app.test.js',
  'test/router.test.js',
  'examples/demo.js',
  '.github/workflows/ci.yml'
];
const SYMBOLS = [
  ['c:App', 'class', 'App', 'src/core/app.js', 3],
  ['f:route', 'function', 'route', 'src/core/router.js', 10],
  ['f:listen', 'function', 'listen', 'src/http/server.js', 5],
  ['f:parse', 'function', 'parse', 'src/http/body.js', 2],
  ['f:query', 'function', 'query', 'src/store/db.js', 7],
  ['f:helperOnlyTests', 'function', 'helperOnlyTests', 'src/store/db.js', 30],
  ['f:gen', 'function', 'gen', 'src/generated/schema.js', 1],
  ['f:t1', 'function', 't1', 'test/app.test.js', 1],
  ['f:t2', 'function', 't2', 'test/router.test.js', 1],
  ['f:demo', 'function', 'demo', 'examples/demo.js', 1]
];
const EDGES = [
  // App is used by the http area, the router, tests and the example.
  ['f:listen', 'c:App', 'instantiates'],
  ['f:parse', 'c:App', 'references'],
  ['f:route', 'c:App'],
  ['f:t1', 'c:App'],
  ['f:demo', 'c:App'],
  // query is used by core and http.
  ['f:route', 'f:query'],
  ['f:listen', 'f:query'],
  ['f:parse', 'f:query'],
  // Only tests use this one: not central.
  ['f:t1', 'f:helperOnlyTests'],
  ['f:t2', 'f:helperOnlyTests'],
  // A generated file does not count.
  ['f:gen', 'f:query'],
  ['f:gen', 'c:App']
];

test('areas are the main folders, below src/ and similar containers', () => {
  assert.equal(areaOf('src/http/server.js'), 'src/http');
  assert.equal(areaOf('server/runtime/x.js'), 'server/runtime');
  assert.equal(areaOf('lib/a.js'), 'lib');
  assert.equal(areaOf('README.md'), '(raíz)');
  assert.equal(role('src/a.test.ts'), 'test');
  assert.equal(role('tests/test_cli.py'), 'test');
  assert.equal(role('pkg/x_test.go'), 'test');
  assert.equal(role('examples/a.js'), 'aside');
  assert.equal(role('src/app.js'), 'core');
});

test('the map ranks the pieces used from the most other files and links the areas', { skip: !sqlite }, (t) => {
  const root = isolatedRepo(t);
  fakeIndex(root, { files: FILES, symbols: SYMBOLS, edges: EDGES });
  const map = buildRepoMap(root);
  assert.equal(map.files, 5, 'only main code with symbols: no tests, examples, generated or CI files');
  assert.deepEqual(
    map.pieces.map((p) => [p.name, p.files, p.testFiles]),
    [
      ['App', 5, 1],
      ['query', 3, 0]
    ]
  );
  assert.equal(map.byFile, false);
  const http = map.areas.find((a) => a.area === 'src/http');
  assert.deepEqual(http.uses, [
    { area: 'src/core', n: 2 },
    { area: 'src/store', n: 2 }
  ]);
  assert.equal(map.areas[0].area, 'src/store', 'the most used area first: core and http both use it');

  const md = renderRepoMap(map);
  assert.match(md, /^# Mapa del código/);
  assert.match(md, /\| `App` \(clase\) \| src\/core\/app\.js:3 \| 5 ficheros \(1 de tests\) \|/);
  assert.match(md, /\| src\/http \| 2 ficheros · 2 símbolos \| src\/core \(2\), src\/store \(2\) \|/);
  assert.match(renderRepoMap(map, 'en'), /^# Code map[\s\S]*\| `App` \(class\) \|/);
});

test('with fewer than three folders the areas are the files', { skip: !sqlite }, (t) => {
  const root = isolatedRepo(t);
  fakeIndex(root, {
    files: ['lib/a.js', 'lib/b.js'],
    symbols: [
      ['f:a', 'function', 'a', 'lib/a.js', 1],
      ['f:b', 'function', 'b', 'lib/b.js', 1]
    ],
    edges: [['f:a', 'f:b']]
  });
  const map = buildRepoMap(root);
  assert.equal(map.byFile, true);
  assert.deepEqual(
    map.areas.map((a) => a.area),
    ['lib/b.js', 'lib/a.js']
  );
  assert.match(
    renderRepoMap(map),
    /\| Fichero \| Tamaño \| Depende de \|\n\|---\|---\|---\|\n\| lib\/b\.js \| 1 símbolo \| — \|/
  );
});

test('without a CodeGraph index there is no map and no page', (t) => {
  const root = isolatedRepo(t);
  assert.equal(buildRepoMap(root), null);
  assert.equal(writeRepoMapPage(root), null);
});

test('the map becomes a wiki page linked once from the index', { skip: !sqlite }, (t) => {
  const root = isolatedRepo(t);
  fakeIndex(root, { files: FILES, symbols: SYMBOLS, edges: EDGES });
  assert.equal(writeRepoMapPage(root), 'mapa-del-codigo.md');
  assert.equal(writeRepoMapPage(root, { lang: 'en' }), 'mapa-del-codigo.md', 'a wiki keeps the language it has');
  const target = wiki.wikiFor('project', root);
  assert.match(
    wiki.readPage(target, 'mapa-del-codigo.md').content ?? wiki.readPage(target, 'mapa-del-codigo.md'),
    /App/
  );
  const index = fs.readFileSync(path.join(target.dir, 'index.md'), 'utf8');
  assert.equal(index.split('[[Mapa del código]]').length - 1, 1);
});

test('"Conocer este repo" starts from the code map when there is one', () => {
  const task = { id: 't1', type: 'onboard', title: 'Conocer el repo', instruction: 'Estudia el repo' };
  const withMap = buildStagePrompt(task, 'onboard', { codeMap: '# Mapa del código\n\n| `App` |' });
  assert.match(withMap, /Punto de partida para «## Estructura»[\s\S]*\| `App` \|/);
  assert.doesNotMatch(buildStagePrompt(task, 'onboard', {}), /Punto de partida/);
});
