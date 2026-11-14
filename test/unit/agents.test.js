'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mkTmpDir, rmTmpDir } = require('./helpers');

// XDG_CONFIG_HOME propio: los agentes globales nunca van al ~/.config real.
function setup(t) {
  const cfg = mkTmpDir('agents-cfg');
  const project = mkTmpDir('agents-proj');
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = cfg;
  t.after(() => {
    process.env.XDG_CONFIG_HOME = prev;
    rmTmpDir(cfg);
    rmTmpDir(project);
  });
  return {
    project,
    catalog: require('../../server/agents/catalog'),
    stageMap: require('../../server/agents/stageMap')
  };
}

test('catalogo: agentes por defecto con modelo por agente', (t) => {
  const { project, catalog } = setup(t);
  const agents = catalog.loadAgents(project);
  const byId = Object.fromEntries(agents.map((a) => [a.id, a]));
  for (const id of [
    'planner',
    'implementer',
    'verifier',
    'reviewer',
    'committer',
    'researcher',
    'doc-writer',
    'debugger',
    'test-writer',
    'auditor'
  ]) {
    assert.ok(byId[id], id);
    assert.equal(byId[id].source, 'builtin');
  }
  assert.equal(byId.planner.model, 'opus');
  assert.equal(byId.committer.model, 'haiku');
  assert.equal(byId.implementer.access, 'edit');
});

test('catalogo: el proyecto gana al global y el global al agente por defecto', (t) => {
  const { project, catalog } = setup(t);
  catalog.saveAgent(project, 'global', 'reviewer', { model: 'sonnet', effort: 'low' });
  catalog.saveAgent(project, 'project', 'reviewer', { model: 'haiku' });
  const reviewer = catalog.getAgent(project, 'reviewer');
  assert.equal(reviewer.model, 'haiku'); // proyecto
  assert.equal(reviewer.effort, 'low'); // global
  assert.equal(reviewer.access, 'read'); // por defecto
  assert.deepEqual(reviewer.overriddenIn, ['global', 'project']);
  catalog.removeAgent(project, 'project', 'reviewer');
  assert.equal(catalog.getAgent(project, 'reviewer').model, 'sonnet');
  catalog.removeAgent(project, 'global', 'reviewer');
  assert.equal(catalog.getAgent(project, 'reviewer').model, 'opus');
});

test('catalogo: crear un agente propio con motor local y prompt', (t) => {
  const { project, catalog } = setup(t);
  const agent = catalog.createAgent(project, 'project', {
    name: 'Traductor ES-EN',
    engine: 'local',
    model: 'qwen2.5:7b',
    access: 'edit',
    prompt: 'Traduce: "sin perder" el tono.\nLinea 2'
  });
  assert.equal(agent.id, 'traductor-es-en');
  assert.equal(agent.builtin, false);
  assert.equal(agent.engine, 'local');
  assert.equal(agent.prompt, 'Traduce: "sin perder" el tono.\nLinea 2');
  assert.ok(fs.existsSync(path.join(project, '.optimia', 'agents', 'traductor-es-en.md')));
  // Mismo nombre otra vez: id distinto
  assert.equal(catalog.createAgent(project, 'project', { name: 'Traductor ES-EN' }).id, 'traductor-es-en-2');
});

test('catalogo: valida motor, modelo y nombre', (t) => {
  const { project, catalog } = setup(t);
  assert.throws(() => catalog.saveAgent(project, 'project', 'planner', { engine: 'gpt' }), /motor/);
  assert.throws(
    () => catalog.saveAgent(project, 'project', 'planner', { engine: 'claude', model: 'gpt-4' }),
    /modelo de Claude/
  );
  assert.throws(() => catalog.createAgent(project, 'project', { name: '' }), /nombre/);
  assert.throws(() => catalog.saveAgent(project, 'nowhere', 'planner', { model: 'opus' }), /scope/);
});

test('parse/serialize: ida y vuelta del frontmatter', (t) => {
  const { catalog } = setup(t);
  const text = catalog.serializeAgent({ name: 'A: b', enabled: false, model: 'opus', prompt: 'Hola' });
  const { fields, prompt } = catalog.parseAgentFile(text);
  assert.equal(fields.name, 'A: b');
  assert.equal(fields.enabled, false);
  assert.equal(prompt, 'Hola');
});

test('stageMap: cambiar el agente de una etapa y desactivar la verificacion', (t) => {
  const { project, catalog, stageMap } = setup(t);
  assert.equal(stageMap.loadStageMap(project).review, 'reviewer');
  catalog.createAgent(project, 'project', { name: 'Seguridad', access: 'read' });
  stageMap.saveStageMap(project, 'project', { review: 'seguridad' });
  assert.equal(stageMap.resolveStageAgent(project, { type: 'coding' }, 'review').id, 'seguridad');
  // Una etapa que edita no acepta un agente de solo lectura
  assert.throws(() => stageMap.saveStageMap(project, 'project', { implement: 'seguridad' }), /edicion/);
  assert.throws(() => stageMap.saveStageMap(project, 'project', { implement: 'no-existe' }), /desconocido/);
  stageMap.saveStageMap(project, 'project', { review: null });
  assert.equal(stageMap.loadStageMap(project).review, 'reviewer');

  assert.deepEqual(stageMap.skippedStages(project), []);
  catalog.saveAgent(project, 'project', 'verifier', { enabled: false });
  assert.deepEqual(stageMap.skippedStages(project), ['verify']);
});

test('stageMap: una tarea custom usa su propio agente', (t) => {
  const { project, catalog, stageMap } = setup(t);
  const agent = catalog.createAgent(project, 'global', { name: 'Migrador', access: 'edit' });
  assert.equal(stageMap.resolveStageAgent(project, { type: 'custom', agentId: agent.id }, 'custom').id, 'migrador');
  assert.equal(stageMap.resolveStageAgent(project, { type: 'custom', agentId: 'nope' }, 'custom'), null);
});
