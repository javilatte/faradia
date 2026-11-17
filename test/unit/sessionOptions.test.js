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
    () => buildSessionOptions(settings, dir, dir, 't', { engine: 'local', model: 'x', name: 'Implementador' }),
    /el agente "Implementador" usa un modelo local, pero no hay servidor configurado.*Detectar servidores locales/
  );
  settings.ai.localAi.url = 'http://localhost:11434';
  assert.throws(() => buildSessionOptions(settings, dir, dir, 't', { engine: 'local', model: '' }), /modelo local/);
});

test('buildSessionOptions: a task session uses strict MCP config and keeps the repo .mcp.json', (t) => {
  const projectRoot = mkTmpDir('sessopts-main');
  const worktree = mkTmpDir('sessopts-wt');
  t.after(() => {
    rmTmpDir(projectRoot);
    rmTmpDir(worktree);
  });
  const settings = defaultSettings();
  const chat = buildSessionOptions(settings, projectRoot);
  assert.equal(chat.strictMcpConfig, undefined, "the chat keeps the user's connectors");

  const bare = buildSessionOptions(settings, worktree, projectRoot, 'task-1');
  assert.equal(bare.strictMcpConfig, true);
  assert.equal(bare.extraMcpConfigPaths, undefined);

  require('fs').writeFileSync(require('path').join(worktree, '.mcp.json'), '{"mcpServers":{}}');
  const withRepoMcp = buildSessionOptions(settings, worktree, projectRoot, 'task-1');
  assert.deepEqual(withRepoMcp.extraMcpConfigPaths, [require('path').join(worktree, '.mcp.json')]);
});

test('buildSessionOptions: chat and agents get their own optimia settings file via --settings', (t) => {
  const {
    syncClaudeSettings,
    optimiaClaudeSettingsPath,
    agentClaudeSettingsPath
  } = require('../../server/bridge/claudeSettingsSync');
  const projectRoot = mkTmpDir('sessopts-settings');
  t.after(() => rmTmpDir(projectRoot));
  syncClaudeSettings(projectRoot, []);
  const settings = defaultSettings();
  settings.preferences.noGo = ['Read(**/.env*)']; // the session regenerates the list from the effective settings
  assert.equal(buildSessionOptions(settings, projectRoot).settingsPath, optimiaClaudeSettingsPath(projectRoot));
  const task = buildSessionOptions(settings, projectRoot, projectRoot, 'task-1');
  assert.equal(task.settingsPath, agentClaudeSettingsPath(projectRoot));
  const agentFile = JSON.parse(require('fs').readFileSync(task.settingsPath, 'utf8'));
  assert.deepEqual(Object.keys(agentFile.permissions), ['deny'], 'no allow list or defaultMode for agents');
  assert.equal(agentFile.permissions.deny[0], 'Read(**/.env*)', "the user's own rules first");
  assert.ok(agentFile.permissions.deny.includes('Bash(git push*)'), 'commit/push/merge/rebase always denied');
  // The policy hook answers, so the approvable rules live in it and not in deny.
  assert.ok(!agentFile.permissions.deny.includes('Bash(rm *)'));
  assert.match(agentFile.hooks.PreToolUse[0].hooks[0].command, /policyHook\.js"$/);
  assert.deepEqual(agentFile.sandbox, {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: true
  });
});

test("buildSessionOptions: instructions for all repos and then the repo's own, in sections", (t) => {
  const dir = mkTmpDir('sessopts-layers');
  t.after(() => rmTmpDir(dir));
  const settings = defaultSettings();
  settings.preferences = {
    ...settings.preferences,
    instructions: 'A\n\nB',
    globalInstructions: 'A',
    projectInstructions: 'B'
  };
  const { systemPrompt } = buildSessionOptions(settings, dir);
  assert.match(systemPrompt, /## Instrucciones para todos los repos\nA/);
  assert.match(systemPrompt, /## Instrucciones de este repo \(mandan sobre las anteriores\)\nB/);
  assert.ok(systemPrompt.indexOf('todos los repos') < systemPrompt.indexOf('de este repo'));
});
