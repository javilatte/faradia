'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { mkTmpDir, rmTmpDir } = require('./helpers');
const { createApp, memoryFromOutput } = require('../../server/runtime/projectApp');
const { addTask, updateTask } = require('../../server/store/taskStore');

// Starts a project's API on a free port.
async function serve(t, projectRoot) {
  const handler = createApp(projectRoot, {});
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

function isolated(t) {
  const cfg = mkTmpDir('app-global');
  const repo = mkTmpDir('app-repo');
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = cfg;
  t.after(() => {
    process.env.XDG_CONFIG_HOME = prev;
    rmTmpDir(cfg);
    rmTmpDir(repo);
  });
  return repo;
}

test('PATCH /api/settings: global for every repo, project for this repo only, with reset and promote', async (t) => {
  const repo = isolated(t);
  const api = await serve(t, repo);

  let r = await api('PATCH', '/api/settings', { scope: 'global', ai: { claude: { model: 'sonnet' } } });
  assert.equal(r.status, 200);
  assert.equal(r.body.ai.claude.model, 'sonnet');

  r = await api('PATCH', '/api/settings', { scope: 'project', ai: { claude: { effort: 'max' } } });
  assert.deepEqual(r.body.layers.overrides, ['ai.claude.effort']);
  assert.equal(r.body.ai.claude.effort, 'max');

  r = await api('PATCH', '/api/settings', { scope: 'project', promote: ['ai.claude.effort'] });
  assert.deepEqual(r.body.layers.overrides, []);
  assert.equal(r.body.layers.global.ai.claude.effort, 'max');

  r = await api('PATCH', '/api/settings', { scope: 'project', ui: { theme: 'dark' } });
  assert.equal(r.status, 400, 'appearance is global');
  r = await api('PATCH', '/api/settings', { ai: {} });
  assert.equal(r.status, 400, 'no scope');
});

test('POST /api/tasks/:id/apply-memory saves the proposed memory and keeps the previous one', async (t) => {
  const repo = isolated(t);
  fs.mkdirSync(path.join(repo, '.optimia'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.optimia', 'memory.md'), 'memoria vieja\n');
  const api = await serve(t, repo);
  const task = addTask(repo, { title: 'Conocer el repo', type: 'onboard', instruction: 'x' });
  updateTask(repo, task.id, {
    status: 'ready_to_test',
    output: 'Aquí tienes la memoria:\n\n## Qué es\nUna API.\n\n## Comandos\n- `npm test`'
  });

  const r = await api('POST', `/api/tasks/${task.id}/apply-memory`);
  assert.equal(r.status, 200);
  assert.ok(r.body.memoryApplied);
  assert.equal(
    fs.readFileSync(path.join(repo, '.optimia', 'memory.md'), 'utf8'),
    '## Qué es\nUna API.\n\n## Comandos\n- `npm test`\n'
  );
  assert.equal(fs.readFileSync(path.join(repo, '.optimia', 'memory.prev.md'), 'utf8'), 'memoria vieja\n');

  const other = addTask(repo, { title: 'otra', type: 'coding', instruction: 'x' });
  assert.equal((await api('POST', `/api/tasks/${other.id}/apply-memory`)).status, 409);
});

test('memoryFromOutput: strips the ```markdown wrapper and the preamble', () => {
  assert.equal(memoryFromOutput('```markdown\n## A\nb\n```'), '## A\nb\n');
  assert.equal(memoryFromOutput('Hecho.\n\n# Memoria\n## A'), '# Memoria\n## A\n');
  assert.equal(memoryFromOutput('sin apartados'), 'sin apartados\n');
});

test('apply-memory removes the study worktree and branch: they only read the repo', async (t) => {
  const repo = isolated(t);
  const { execFileSync } = require('child_process');
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  const { createTaskWorktree } = require('../../server/bridge/worktree');
  const api = await serve(t, repo);
  const task = addTask(repo, { title: 'Conocer el repo', type: 'onboard', instruction: 'x' });
  const wt = createTaskWorktree(repo, task.id);
  updateTask(repo, task.id, {
    status: 'ready_to_test',
    output: '## Qué es\nUn repo.',
    worktreePath: wt.dir,
    branch: wt.branch
  });

  const r = await api('POST', `/api/tasks/${task.id}/apply-memory`);
  assert.equal(r.status, 200);
  assert.equal(r.body.worktreePath, null);
  assert.equal(r.body.branchDeleted, true);
  assert.equal(fs.existsSync(wt.dir), false);
  assert.equal(execFileSync('git', ['branch', '--list', wt.branch], { cwd: repo, encoding: 'utf8' }).trim(), '');
});
