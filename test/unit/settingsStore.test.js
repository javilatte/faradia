'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mkTmpDir, rmTmpDir } = require('./helpers');
const store = require('../../server/store/settingsStore');

// Each test with its own global configuration (on top of setup.mjs).
function isolated(t) {
  const cfg = mkTmpDir('settings-global');
  const repo = mkTmpDir('settings-repo');
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = cfg;
  t.after(() => {
    process.env.XDG_CONFIG_HOME = prev;
    rmTmpDir(cfg);
    rmTmpDir(repo);
  });
  return repo;
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('no files: the effective settings are the defaults and nothing is written', (t) => {
  const repo = isolated(t);
  const s = store.loadSettings(repo);
  const d = store.defaultSettings();
  assert.deepEqual(s.ui, d.ui);
  assert.deepEqual(s.ai, d.ai);
  assert.equal(s.preferences.instructions, '');
  assert.deepEqual(s.preferences.noGo, []);
  assert.equal(fs.existsSync(store.settingsPath(repo)), false);
  assert.equal(fs.existsSync(store.globalSettingsPath()), false);
});

test('a global change reaches every repo that does not override it', (t) => {
  const repo = isolated(t);
  const other = mkTmpDir('settings-repo2');
  t.after(() => rmTmpDir(other));
  store.saveGlobalSettings({ ai: { claude: { model: 'sonnet' } }, ui: { theme: 'dark' } });
  assert.equal(store.loadSettings(repo).ai.claude.model, 'sonnet');
  assert.equal(store.loadSettings(other).ai.claude.model, 'sonnet');
  assert.equal(store.loadSettings(other).ui.theme, 'dark');
});

test('a repo only changes its own; matching the global value, resetting or promoting removes the override', (t) => {
  const repo = isolated(t);
  store.saveGlobalSettings({ ai: { claude: { model: 'sonnet', effort: 'medium' } } });

  store.saveProjectSettings(repo, { ai: { claude: { model: 'opus' } } });
  let layers = store.loadSettingsLayers(repo);
  assert.equal(layers.effective.ai.claude.model, 'opus');
  assert.equal(layers.effective.ai.claude.effort, 'medium', 'everything else is inherited');
  assert.deepEqual(layers.overrides, ['ai.claude.model']);
  assert.deepEqual(readJson(store.settingsPath(repo)).ai, { claude: { model: 'opus' } });

  store.saveProjectSettings(repo, { ai: { claude: { model: 'sonnet' } } });
  assert.deepEqual(store.loadSettingsLayers(repo).overrides, [], 'equal to the global value = no longer an override');

  store.saveProjectSettings(repo, { ai: { claude: { effort: 'max' } } });
  store.saveProjectSettings(repo, {}, { reset: ['ai.claude.effort'] });
  assert.equal(store.loadSettings(repo).ai.claude.effort, 'medium');

  store.saveProjectSettings(repo, { ai: { localAi: { url: 'http://ollama:11434' } } });
  store.promoteToGlobal(repo, ['ai.localAi.url']);
  assert.equal(store.loadGlobalSettings().ai.localAi.url, 'http://ollama:11434');
  assert.deepEqual(store.loadSettingsLayers(repo).overrides, []);
});

test('the repo\'s instructions and "Prohibido" rules are added to the global ones', (t) => {
  const repo = isolated(t);
  store.saveGlobalSettings({
    preferences: { instructions: 'Conventional Commits.', noGo: ['Read(**/.env*)'] }
  });
  store.saveProjectSettings(repo, {
    preferences: { instructions: 'Tests con vitest.', noGo: ['Bash(rm -rf *)', 'Read(**/.env*)'] }
  });
  const p = store.loadSettings(repo).preferences;
  assert.equal(p.globalInstructions, 'Conventional Commits.');
  assert.equal(p.projectInstructions, 'Tests con vitest.');
  assert.equal(p.instructions, 'Conventional Commits.\n\nTests con vitest.');
  assert.deepEqual(p.noGo, ['Read(**/.env*)', 'Bash(rm -rf *)']);
});

test('an old settings.json (full copy) is migrated: only what differs from the defaults stays', (t) => {
  const repo = isolated(t);
  fs.mkdirSync(path.join(repo, '.faradia'), { recursive: true });
  const legacy = store.defaultSettings();
  legacy.ui.theme = 'dark';
  legacy.ai.claude.model = 'opus';
  legacy.preferences.instructions = 'Solo en este repo.';
  legacy.preferences.approvedTools = ['WebFetch'];
  fs.writeFileSync(store.settingsPath(repo), JSON.stringify(legacy));

  const layers = store.loadSettingsLayers(repo);
  assert.deepEqual(layers.overrides, ['ai.claude.model'], 'effort high was the default: not an override');
  assert.equal(layers.project.preferences.instructions, 'Solo en este repo.');
  assert.deepEqual(layers.project.preferences.approvedTools, ['WebFetch']);
  assert.equal(store.loadGlobalSettings().ui.theme, 'dark', 'the appearance moves to the global layer');
  assert.equal(readJson(store.settingsPath(repo)).version, 2);
});

test('compatibility PUT: sending back the effective settings does not copy the global ones into the repo', (t) => {
  const repo = isolated(t);
  store.saveGlobalSettings({ preferences: { instructions: 'Global.', noGo: ['Read(**/.env*)'] } });
  store.saveProjectSettings(repo, { preferences: { instructions: 'Repo.' } });
  const effective = store.loadSettings(repo);
  effective.ai.claude.effort = 'low';
  store.saveSettings(repo, effective);
  const layers = store.loadSettingsLayers(repo);
  assert.equal(layers.project.preferences.instructions, 'Repo.');
  assert.deepEqual(layers.project.preferences.noGo, []);
  assert.deepEqual(layers.overrides, ['ai.claude.effort']);
});

test('invalid values are dropped', (t) => {
  const repo = isolated(t);
  store.saveGlobalSettings({ ui: { theme: 'neon' }, ai: { mode: 'gpt' } });
  store.saveProjectSettings(repo, { preferences: { noGo: 'no-es-lista' } });
  const s = store.loadSettings(repo);
  assert.equal(s.ui.theme, 'system');
  assert.equal(s.ai.mode, 'claude');
  assert.deepEqual(s.preferences.noGo, []);
});
