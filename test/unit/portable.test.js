'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mkTmpDir, rmTmpDir } = require('./helpers');
const portable = require('../../server/config/portable');
const store = require('../../server/store/settingsStore');
const catalog = require('../../server/agents/catalog');
const { loadPrefs, savePrefs } = require('../../server/store/globalPrefs');

// Each test gets its own global config directory.
function isolated(t) {
  const cfg = mkTmpDir('portable');
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = cfg;
  t.after(() => {
    process.env.XDG_CONFIG_HOME = prev;
    rmTmpDir(cfg);
  });
  return cfg;
}

function seed() {
  store.saveGlobalSettings({
    ui: { theme: 'dark' },
    ai: {
      claude: { model: 'sonnet' },
      localAi: { url: 'http://ollama:11434', authHeader: 'Authorization: Bearer s3cret' }
    },
    preferences: { instructions: 'Conventional Commits.', noGo: ['Read(**/.env*)'] }
  });
  catalog.createAgent(null, 'global', { name: 'Traductor', description: 'Traduce', prompt: 'Traduce al inglés.' });
  savePrefs({ orphanMinutes: 45 });
}

test('export: everything global, without the auth header unless asked', (t) => {
  isolated(t);
  seed();
  const cfg = portable.exportConfig();
  assert.equal(cfg.format, 'faradia-config');
  assert.equal(cfg.formatVersion, 1);
  assert.equal(cfg.settings.preferences.instructions, 'Conventional Commits.');
  assert.equal(cfg.settings.ai.localAi.url, 'http://ollama:11434');
  assert.equal(cfg.settings.ai.localAi.authHeader, '', 'the secret is left out');
  assert.equal(cfg.secretsIncluded, false);
  assert.deepEqual(
    cfg.agents.map((a) => a.id),
    ['traductor']
  );
  assert.equal(cfg.preferences.orphanMinutes, 45);
  assert.equal(
    portable.exportConfig({ includeSecrets: true }).settings.ai.localAi.authHeader,
    'Authorization: Bearer s3cret'
  );
});

test('import into a fresh install: preview first, then apply with a backup', (t) => {
  isolated(t);
  seed();
  const exported = portable.exportConfig();

  // Another machine: a fresh global config
  const other = isolated(t);
  assert.equal(portable.isFirstRun(), true);
  const preview = portable.previewImport(exported);
  assert.ok(preview.settings.includes('Instrucciones para todos los repos'));
  assert.deepEqual(preview.agents.added, ['Traductor']);
  assert.deepEqual(preview.agents.removed, []);

  const result = portable.importConfig(exported);
  assert.equal(result.agents, 1);
  assert.ok(fs.existsSync(path.join(result.backup, 'faradia-config.json')));
  assert.ok(result.backup.startsWith(other));
  const g = store.loadGlobalSettings();
  assert.equal(g.preferences.instructions, 'Conventional Commits.');
  assert.equal(g.ui.theme, 'dark');
  assert.equal(g.ai.localAi.authHeader, '', 'no secret in the file: none on this machine either');
  assert.equal(loadPrefs().orphanMinutes, 45);
  assert.ok(catalog.loadAgents(null).some((a) => a.id === 'traductor'));
  assert.equal(portable.isFirstRun(), false);
});

test('import keeps the local auth header when the file has no secrets, and replaces global agents', (t) => {
  isolated(t);
  seed();
  catalog.createAgent(null, 'global', { name: 'Viejo', description: 'x', prompt: 'x' });
  const file = portable.exportConfig();
  file.agents = file.agents.filter((a) => a.id !== 'viejo');
  file.settings.preferences.instructions = 'Nuevas.';

  const preview = portable.previewImport(file);
  assert.deepEqual(preview.agents.removed, ['viejo']);
  portable.importConfig(file);
  const g = store.loadGlobalSettings();
  assert.equal(g.ai.localAi.authHeader, 'Authorization: Bearer s3cret');
  assert.equal(g.preferences.instructions, 'Nuevas.');
  assert.ok(!catalog.loadAgents(null).some((a) => a.id === 'viejo'));
});

test('validation rejects foreign files and drops unknown stage mappings', (t) => {
  isolated(t);
  assert.throws(() => portable.validateConfig({ hello: 1 }), /no es un fichero de configuración/);
  assert.throws(() => portable.validateConfig({ format: 'faradia-config', formatVersion: 99 }), /no compatible/);
  assert.throws(
    () =>
      portable.validateConfig({
        format: 'faradia-config',
        formatVersion: 1,
        agents: [{ id: '../evil', content: 'x' }]
      }),
    /id no válido/
  );
  const cfg = portable.validateConfig({
    format: 'faradia-config',
    formatVersion: 1,
    agents: [{ id: 'mio', content: '---\nname: Mío\nengine: claude\nhack: yes\n---\nHola' }],
    stageMap: { plan: 'mio', implement: 'nobody', bogus: 'planner' }
  });
  assert.deepEqual(cfg.stageMap, { plan: 'mio' });
  assert.equal(cfg.warnings.length, 2);
  assert.doesNotMatch(cfg.agents[0].content, /hack/, 'unknown frontmatter fields are dropped');
});
