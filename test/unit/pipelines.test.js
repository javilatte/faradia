'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TASK_TYPES,
  firstStage,
  nextStage,
  canRun,
  decideAfterStage,
  parseVerdict,
  stageTools,
  buildStagePrompt
} = require('../../server/bridge/taskStages');

const task = (type, extra = {}) => ({
  id: 't',
  title: 'x',
  instruction: 'Arreglar el login',
  type,
  status: 'pending',
  stageOutputs: {},
  ...extra
});

test('pipelines: cada tipo empieza por su primera etapa', () => {
  assert.equal(firstStage('coding'), 'plan');
  assert.equal(firstStage('bugfix'), 'diagnose');
  assert.equal(firstStage('tests'), 'plan');
  assert.equal(firstStage('documentation'), 'research');
  assert.equal(firstStage('audit'), 'audit');
  assert.equal(firstStage('custom'), 'custom');
  assert.equal(firstStage(undefined), 'plan'); // tareas antiguas sin tipo = codigo
});

test('nextStage: sigue el pipeline y salta solo etapas opcionales desactivadas', () => {
  assert.equal(nextStage('bugfix', 'diagnose'), 'implement');
  assert.equal(nextStage('bugfix', 'implement'), 'verify');
  assert.equal(nextStage('bugfix', 'implement', { skip: ['verify'] }), null);
  assert.equal(nextStage('tests', 'plan'), 'write-tests');
  assert.equal(nextStage('tests', 'plan', { skip: ['write-tests'] }), 'write-tests'); // no es opcional
  assert.equal(nextStage('audit', 'audit'), null);
});

test('bugfix: el diagnostico encadena la implementacion, que recibe el diagnostico', () => {
  const { patch, next } = decideAfterStage(task('bugfix'), 'diagnose', { text: 'causa: null en login.js:12' });
  assert.equal(next, 'implement');
  const prompt = buildStagePrompt({ ...task('bugfix'), stageOutputs: patch.stageOutputs }, 'implement');
  assert.match(prompt, /Diagnóstico:\ncausa: null en login\.js:12/);
  assert.match(prompt, /Encargo original del usuario[^\n]*\n/, 'el implementador ve también el encargo');
});

test('verify: guarda el veredicto y deja la tarea lista para revisar', () => {
  const ok = decideAfterStage(task('coding'), 'verify', { text: 'tests en verde\nVEREDICTO: OK' });
  assert.equal(ok.patch.status, 'ready_to_test');
  assert.equal(ok.patch.verification.ok, true);
  const ko = decideAfterStage(task('coding'), 'verify', { text: 'VEREDICTO: FALLA lint roto en a.js' });
  assert.equal(ko.patch.verification.ok, false);
  assert.match(ko.patch.verification.line, /lint roto/);
  assert.equal(decideAfterStage(task('coding'), 'verify', { text: 'sin veredicto' }).patch.verification, null);
});

test('parseVerdict: reconoce OK y FALLA en cualquier linea', () => {
  assert.deepEqual(parseVerdict('a\nveredicto: ok\n'), { ok: true, line: 'veredicto: ok' });
  assert.equal(parseVerdict('nada'), null);
});

test('audit: entrega un informe sin cambios y la tarea queda como solo informe', () => {
  const { patch, next } = decideAfterStage(task('audit'), 'audit', { text: '## Hallazgos\n1. critica: ...' });
  assert.equal(next, null);
  assert.equal(patch.status, 'ready_to_test');
  assert.equal(patch.reportOnly, true);
  assert.match(decideAfterStage(task('audit'), 'audit', { text: ' ' }).patch.error, /informe/);
});

test('custom: el acceso del agente decide herramientas y resultado', () => {
  const reader = { access: 'read' };
  const editor = { access: 'edit' };
  assert.ok(!stageTools('custom', reader).includes('Edit'));
  assert.ok(stageTools('custom', editor).includes('Edit'));
  const t = task('custom', { agentId: 'x' });
  assert.equal(decideAfterStage(t, 'custom', { text: 'informe', agent: reader }).patch.reportOnly, true);
  assert.equal(
    decideAfterStage(t, 'custom', { text: 'hecho', hasChanges: true, agent: editor }).patch.status,
    'ready_to_test'
  );
  assert.match(
    decideAfterStage(t, 'custom', { text: 'hecho', hasChanges: false, agent: editor }).patch.error,
    /cambios/
  );
});

test('canRun: etapas fuera del pipeline del tipo, custom sin agente y re-verificar', () => {
  assert.match(canRun(task('documentation'), 'implement'), /no es de este tipo/);
  assert.match(canRun(task('custom'), 'custom'), /no tiene agente/);
  assert.equal(canRun(task('custom', { agentId: 'a' }), 'custom'), null);
  assert.equal(canRun(task('coding', { status: 'ready_to_test' }), 'verify'), null);
  assert.equal(canRun(task('bugfix'), 'diagnose'), null);
});

test('TASK_TYPES: todos los tipos tienen etiqueta y pipeline', () => {
  for (const [type, def] of Object.entries(TASK_TYPES)) {
    assert.ok(def.label, type);
    assert.ok(def.pipeline.length > 0, type);
  }
});
