'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');
const { mkTmpDir, rmTmpDir } = require('./helpers');
const wiki = require('../../server/knowledge/wikiStore');
const { enqueueWikiUpdate, enqueueWikiBuild, parsePages, pickEngine } = require('../../server/knowledge/wikiUpdater');
const { defaultSettings } = require('../../server/store/settingsStore');

function isolated(t) {
  const data = mkTmpDir('wiki-data');
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = data;
  t.after(() => {
    process.env.XDG_DATA_HOME = prev;
    rmTmpDir(data);
  });
  return data;
}

function repo(t, remote) {
  const dir = mkTmpDir('wiki-repo');
  t.after(() => rmTmpDir(dir));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  if (remote) execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir });
  return dir;
}

test('projectKey: the same wiki on every machine for the same remote; folder name without one', (t) => {
  isolated(t);
  assert.equal(wiki.keyFromRemote('git@github.com:Javi/Optimia.git'), 'github.com-javi-optimia');
  assert.equal(wiki.keyFromRemote('https://github.com/javi/optimia'), 'github.com-javi-optimia');
  assert.equal(wiki.projectKey(repo(t, 'git@github.com:javi/optimia.git')), 'github.com-javi-optimia');
  assert.match(wiki.projectKey(repo(t)), /^local-optimia-wiki-repo-/);
});

test('pages: create, read with backlinks, list, search, map; paths cannot escape the wiki', (t) => {
  isolated(t);
  const root = repo(t, 'https://github.com/acme/api.git');
  const w = wiki.ensureWiki(wiki.wikiFor('project', root), root);
  assert.ok(fs.existsSync(path.join(w.dir, 'index.md')));
  assert.ok(fs.existsSync(path.join(w.dir, 'log.md')));
  wiki.writePage(w, 'index.md', '# API\n\n- [[Autenticación]]\n- [Pagos](conceptos/pagos.md)\n');
  wiki.writePage(w, 'autenticacion', '# Autenticación\n\nUsa JWT. Ver [[Pagos]] y [[No existe]].');
  wiki.writePage(w, 'conceptos/pagos.md', '# Pagos\n\nStripe con webhooks idempotentes.');

  const page = wiki.readPage(w, 'conceptos/pagos.md');
  assert.equal(page.title, 'Pagos');
  assert.deepEqual(page.backlinks.sort(), ['autenticacion.md', 'index.md']);
  assert.deepEqual(
    wiki.listPages(w).map((p) => p.path),
    ['autenticacion.md', 'conceptos/pagos.md', 'index.md', 'log.md']
  );

  const results = wiki.search(w, 'stripe webhooks');
  assert.equal(results[0].path, 'conceptos/pagos.md');
  assert.match(results[0].snippet, /Stripe/);
  assert.deepEqual(wiki.search(w, 'kubernetes'), []);

  const map = wiki.graph(w);
  assert.equal(map.nodes.length, 4);
  assert.deepEqual(map.edges.map((e) => `${e.from}>${e.to}`).sort(), [
    'autenticacion.md>conceptos/pagos.md',
    'index.md>autenticacion.md',
    'index.md>conceptos/pagos.md'
  ]);
  assert.deepEqual(map.missing, [{ from: 'autenticacion.md', target: 'No existe' }]);

  assert.throws(() => wiki.writePage(w, '../fuera.md', 'x'), /no válida/);
  assert.throws(() => wiki.writePage(w, '.oculto/x.md', 'x'), /no válida/);
  assert.throws(() => wiki.deletePage(w, 'index.md'), /portada/);
  assert.equal(wiki.deletePage(w, 'autenticacion.md'), true);
  assert.equal(wiki.listProjectWikis()[0].key, 'github.com-acme-api');
});

test('the personal wiki is separate from the project ones', (t) => {
  isolated(t);
  const personal = wiki.ensureWiki(wiki.wikiFor('personal'));
  wiki.writePage(personal, 'preferencias.md', '# Preferencias\n\nConventional Commits.');
  assert.match(personal.dir, /wikis[/\\]personal$/);
  assert.equal(wiki.search(personal, 'conventional')[0].path, 'preferencias.md');
});

// A fake Claude session: answers the prompt by writing a page, like the real agent would.
function fakeSession(calls, { fail = () => false } = {}) {
  return class extends EventEmitter {
    constructor(opts) {
      super();
      this.opts = opts;
      calls.push(opts);
    }
    send(prompt) {
      this.prompt = prompt;
      setImmediate(() => {
        if (fail(this.opts)) return this.emit('event', { type: 'result', is_error: true, result: 'contexto pequeño' });
        const projectDir = /Wiki del proyecto «.*»: (\S+)\//.exec(prompt)[1];
        fs.writeFileSync(path.join(this.opts.projectRoot, projectDir, 'login.md'), '# Login\n\nCon Google.\n');
        this.emit('event', { type: 'result', is_error: false, result: `Hecho.\nPÁGINAS: ${projectDir}/login.md` });
      });
    }
    kill() {}
    close() {}
  };
}

test('enqueueWikiUpdate: the agent updates the project wiki from the commit, without Bash', async (t) => {
  isolated(t);
  const root = repo(t, 'https://github.com/acme/web.git');
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'feat: login'],
    {
      cwd: root
    }
  );
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const calls = [];
  const outcome = await enqueueWikiUpdate({
    projectRoot: root,
    task: { id: 't1', type: 'coding', title: 'Login con Google', instruction: 'Añade login', stageOutputs: {} },
    change: { sha, dir: root },
    settings: defaultSettings(),
    agent: { name: 'Bibliotecario', prompt: 'rol', model: 'haiku', effort: 'low' },
    Session: fakeSession(calls)
  });
  assert.equal(outcome.engine, 'claude', 'no local model configured: Claude');
  assert.equal(outcome.model, 'haiku');
  assert.deepEqual(outcome.pages, ['projects/github.com-acme-web/login.md']);
  assert.equal(calls[0].projectRoot, wiki.wikisDir());
  assert.ok(calls[0].disallowedTools.includes('Bash'));
  const w = wiki.wikiFor('project', root);
  assert.equal(wiki.readPage(w, 'login.md').title, 'Login');
});

test('enqueueWikiUpdate: the local model first; if it fails, a cheap Claude model', async (t) => {
  isolated(t);
  const root = repo(t);
  const settings = defaultSettings();
  settings.ai.localAi = { url: 'http://127.0.0.1:1234', model: 'gemma', authHeader: '' };
  const engine = await pickEngine(settings, null, { list: async () => [{ name: 'gemma' }] });
  assert.deepEqual(engine, {
    engine: 'local',
    model: 'gemma',
    baseUrl: 'http://127.0.0.1:1234',
    authHeader: undefined
  });
  assert.equal((await pickEngine(settings, null, { list: async () => [] })).engine, 'claude', 'model not loaded');
  assert.equal((await pickEngine(settings, null, { preferLocal: false })).engine, 'claude');

  // The real pickEngine asks the server: point it at nothing and the job goes straight to Claude;
  // here the local server "exists" but the session fails, so Claude takes over.
  const calls = [];
  settings.ai.localAi.url = '';
  const outcome = await enqueueWikiUpdate({
    projectRoot: root,
    task: { id: 't2', type: 'audit', title: 'Auditoría', instruction: 'x' },
    change: { report: 'Hallazgos...' },
    settings,
    agent: null,
    Session: fakeSession(calls, { fail: (o) => Boolean(o.baseUrl) })
  });
  assert.equal(outcome.engine, 'claude');
  assert.equal(calls.length, 1);
  assert.equal(parsePages('…\nPÁGINAS: ninguna').length, 0);
  assert.deepEqual(parsePages('PAGINAS: a.md, b/c.md'), ['a.md', 'b/c.md']);
});

test('enqueueWikiUpdate: nothing when auto-update is off', async (t) => {
  isolated(t);
  const settings = defaultSettings();
  settings.wiki = { autoUpdate: false };
  assert.equal(await enqueueWikiUpdate({ projectRoot: repo(t), task: {}, change: {}, settings }), null);
});

test('enqueueWikiBuild: the agent writes the wiki from the repo, read-only on the code, and its events are relayed', async (t) => {
  isolated(t);
  const root = repo(t, 'https://github.com/acme/api.git');
  const calls = [];
  const events = [];
  const outcome = await enqueueWikiBuild({
    projectRoot: root,
    settings: defaultSettings(),
    agent: { name: 'Bibliotecario', prompt: 'rol', model: 'haiku', effort: 'low' },
    onEvent: (e) => events.push(e.type),
    Session: fakeSession(calls)
  });
  assert.deepEqual(outcome.pages, ['projects/github.com-acme-api/login.md']);
  assert.deepEqual(calls[0].addDirs, [root], 'the agent can read the repository');
  assert.ok(calls[0].disallowedTools.includes('Bash'));
  assert.match(calls[0].projectRoot, /wikis$/);
  assert.deepEqual(events, ['result']);
});
