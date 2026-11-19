'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { mkTmpDir, rmTmpDir } = require('./helpers');
const wiki = require('../../server/knowledge/wikiStore');
const knowledge = require('../../server/knowledge/bundle');
const wbStore = require('../../server/store/workbenchStore');
const { saveMemory, loadMemory } = require('../../server/store/memoryStore');

// One "machine": its own config and data folders.
function machine(t) {
  const cfg = mkTmpDir('kn-cfg');
  const data = mkTmpDir('kn-data');
  t.after(() => {
    rmTmpDir(cfg);
    rmTmpDir(data);
  });
  return { cfg, data };
}

function use(m) {
  process.env.XDG_CONFIG_HOME = m.cfg;
  process.env.XDG_DATA_HOME = m.data;
}

function repo(t, remote) {
  const dir = mkTmpDir('kn-repo');
  t.after(() => rmTmpDir(dir));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir });
  return fs.realpathSync(dir);
}

test('knowledge: export on one machine, import on another; newest wins and nothing is lost', (t) => {
  const prev = { cfg: process.env.XDG_CONFIG_HOME, data: process.env.XDG_DATA_HOME };
  t.after(() => {
    process.env.XDG_CONFIG_HOME = prev.cfg;
    process.env.XDG_DATA_HOME = prev.data;
  });
  const work = machine(t);
  const home = machine(t);

  // Work machine: a repo with memory and a wiki, and a personal wiki.
  use(work);
  const workRepo = repo(t, 'git@github.com:acme/api.git');
  const wb = wbStore.createWorkbench('Trabajo');
  wbStore.addRepos(wb.id, [workRepo]);
  saveMemory(workRepo, '## Qué es\nLa API.\n');
  const pw = wiki.ensureWiki(wiki.wikiFor('project', workRepo), workRepo);
  wiki.writePage(pw, 'despliegue.md', '# Despliegue\n\nCon npm.\n');
  wiki.writePage(wiki.ensureWiki(wiki.wikiFor('personal')), 'atajos.md', '# Atajos\n\n⌘K.\n');
  const bundle = knowledge.exportKnowledge();
  assert.equal(bundle.format, 'faradia-knowledge');
  assert.ok(bundle.config.format === 'faradia-config');
  assert.ok(bundle.memories.some((m) => m.key === 'github.com-acme-api'));

  // Home machine: the same project cloned somewhere else, with an older page of its own.
  use(home);
  const homeRepo = repo(t, 'https://github.com/acme/api');
  const wb2 = wbStore.createWorkbench('Casa');
  wbStore.addRepos(wb2.id, [homeRepo]);
  const hw = wiki.ensureWiki(wiki.wikiFor('project', homeRepo), homeRepo);
  wiki.writePage(hw, 'despliegue.md', '# Despliegue\n\nViejo.\n');
  fs.utimesSync(path.join(hw.dir, 'despliegue.md'), new Date('2020-01-01'), new Date('2020-01-01'));
  wiki.writePage(hw, 'solo-en-casa.md', '# Solo en casa\n');

  const preview = knowledge.previewKnowledge(bundle);
  assert.deepEqual(
    preview.pages.update.map((p) => p.path),
    ['despliegue.md']
  );
  assert.ok(preview.pages.add.some((p) => p.wiki === 'personal' && p.path === 'atajos.md'));
  assert.deepEqual(preview.memories.add, [{ key: 'github.com-acme-api', repo: homeRepo }]);

  const result = knowledge.importKnowledge(bundle, { withConfig: false });
  assert.equal(result.configImported, false);
  assert.match(wiki.readPage(hw, 'despliegue.md').content, /Con npm/);
  assert.ok(wiki.readPage(hw, 'solo-en-casa.md'), 'pages only at home stay');
  assert.equal(loadMemory(homeRepo), '## Qué es\nLa API.\n');
  const backups = path.join(home.data, 'faradia', 'knowledge-backups');
  assert.ok(fs.readdirSync(backups).length === 1, 'the replaced page was backed up');

  // Importing again changes nothing.
  const again = knowledge.previewKnowledge(bundle);
  assert.equal(again.pages.add.length + again.pages.update.length + again.memories.add.length, 0);
});

test('knowledge: a memory for a repo this machine does not have yet waits for it', (t) => {
  const prev = { cfg: process.env.XDG_CONFIG_HOME, data: process.env.XDG_DATA_HOME };
  t.after(() => {
    process.env.XDG_CONFIG_HOME = prev.cfg;
    process.env.XDG_DATA_HOME = prev.data;
  });
  use(machine(t));
  const bundle = {
    format: 'faradia-knowledge',
    formatVersion: 1,
    wikis: [],
    memories: [{ key: 'github.com-acme-web', content: '## Web\n', updatedAt: new Date().toISOString() }]
  };
  knowledge.importKnowledge(bundle);
  const later = repo(t, 'git@github.com:acme/web.git');
  assert.equal(knowledge.adoptPendingMemory(later), true);
  assert.equal(loadMemory(later), '## Web\n');
  assert.throws(() => knowledge.previewKnowledge({ format: 'otro' }), /no es un fichero de conocimiento/);
  assert.throws(
    () =>
      knowledge.previewKnowledge({
        format: 'faradia-knowledge',
        formatVersion: 1,
        wikis: [{ scope: 'project', key: '../x' }]
      }),
    /clave de wiki no válida/
  );
});
