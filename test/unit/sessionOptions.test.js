'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkTmpDir, rmTmpDir } = require('./helpers');
const { defaultSettings } = require('../../server/store/settingsStore');
const { saveMemory } = require('../../server/store/memoryStore');
const { buildSessionOptions } = require('../../server/bridge/sessionOptions');

test('buildSessionOptions: claude mode, no instructions/memory -> no systemPrompt, model "default" dropped', (t) => {
  const dir = mkTmpDir('sessopts');
  t.after(() => rmTmpDir(dir));

  const settings = defaultSettings(); // ai.mode === 'claude', model 'default', effort 'high'
  const opts = buildSessionOptions(settings, dir);

  assert.equal(opts.projectRoot, dir);
  assert.equal(opts.systemPrompt, undefined);
  assert.equal(opts.model, undefined); // 'default' is not a real model name, dropped
  assert.equal(opts.effort, 'high');
});

test('buildSessionOptions: claude mode with a real model name passes it through', (t) => {
  const dir = mkTmpDir('sessopts');
  t.after(() => rmTmpDir(dir));

  const settings = defaultSettings();
  settings.ai.claude.model = 'sonnet';
  const opts = buildSessionOptions(settings, dir);
  assert.equal(opts.model, 'sonnet');
});

test('buildSessionOptions: composes instructions + project memory into systemPrompt', (t) => {
  const dir = mkTmpDir('sessopts');
  t.after(() => rmTmpDir(dir));

  saveMemory(dir, 'Recuerda: el usuario prefiere respuestas breves.');
  const settings = defaultSettings();
  settings.preferences.instructions = 'Habla siempre en espanol.';

  const opts = buildSessionOptions(settings, dir);
  assert.match(opts.systemPrompt, /Habla siempre en espanol\./);
  assert.match(opts.systemPrompt, /Recuerda: el usuario prefiere respuestas breves\./);
});

test('buildSessionOptions: reads memory from projectRoot (not cwd) for a task running in a worktree', (t) => {
  const projectRoot = mkTmpDir('sessopts-main');
  const worktreeCwd = mkTmpDir('sessopts-worktree');
  t.after(() => {
    rmTmpDir(projectRoot);
    rmTmpDir(worktreeCwd);
  });

  saveMemory(projectRoot, 'memoria del proyecto principal');
  const settings = defaultSettings();

  const opts = buildSessionOptions(settings, worktreeCwd, projectRoot);
  assert.equal(opts.projectRoot, worktreeCwd); // session still runs in the worktree
  assert.match(opts.systemPrompt, /memoria del proyecto principal/); // but memory comes from the main project
});

test('buildSessionOptions: local mode passes the real Ollama model name and sets baseUrl/authHeader', (t) => {
  const dir = mkTmpDir('sessopts');
  t.after(() => rmTmpDir(dir));

  const settings = defaultSettings();
  settings.ai.mode = 'local';
  settings.ai.localAi = {
    url: 'http://localhost:11434',
    model: 'qwen2.5:0.5b',
    authHeader: 'Authorization: Bearer x'
  };

  const opts = buildSessionOptions(settings, dir);
  assert.equal(opts.baseUrl, 'http://localhost:11434');
  assert.equal(opts.authHeader, 'Authorization: Bearer x');
  assert.equal(opts.model, 'qwen2.5:0.5b');
  assert.equal(opts.effort, undefined);
});

test('buildSessionOptions: an agent overrides engine, model, effort and adds its role prompt', (t) => {
  const dir = mkTmpDir('sessopts');
  t.after(() => rmTmpDir(dir));
  const settings = defaultSettings(); // chat in claude mode with model "default"
  const agent = { name: 'Revisor', engine: 'claude', model: 'opus', effort: 'low', prompt: 'Busca errores reales.' };

  const opts = buildSessionOptions(settings, dir, dir, 'task-1', agent);
  assert.equal(opts.model, 'opus');
  assert.equal(opts.effort, 'low');
  assert.match(opts.systemPrompt, /^## Tu rol: Revisor\nBusca errores reales\./);
});

test('buildSessionOptions: two agents can use different local models at the same time', (t) => {
  const dir = mkTmpDir('sessopts');
  t.after(() => rmTmpDir(dir));
  const settings = defaultSettings(); // the chat stays on Claude
  settings.ai.localAi.url = 'http://localhost:11434';
  const a = buildSessionOptions(settings, dir, dir, 't', { name: 'A', engine: 'local', model: 'qwen2.5-coder:7b' });
  const b = buildSessionOptions(settings, dir, dir, 't', { name: 'B', engine: 'local', model: 'llama3.1:8b' });
  assert.equal(a.model, 'qwen2.5-coder:7b');
  assert.equal(b.model, 'llama3.1:8b');
  assert.equal(a.baseUrl, 'http://localhost:11434');
});

test('buildSessionOptions: a local agent without URL or model fails with a clear message', (t) => {
  const dir = mkTmpDir('sessopts');
  t.after(() => rmTmpDir(dir));
  const settings = defaultSettings();
  assert.throws(
    () => buildSessionOptions(settings, dir, dir, 't', { engine: 'local', model: 'x' }),
    /URL de la IA local/
  );
  settings.ai.localAi.url = 'http://localhost:11434';
  assert.throws(() => buildSessionOptions(settings, dir, dir, 't', { engine: 'local', model: '' }), /modelo local/);
});
