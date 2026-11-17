'use strict';

const test = require('node:test');
const { spawnSync } = require('child_process');
const path = require('path');
const { mkTmpDir, rmTmpDir } = require('./helpers');
const { ensureGitGuardHooks } = require('../../server/bridge/gitGuard');
const assert = require('node:assert/strict');
const {
  firstStage,
  validateDocOptions,
  canRun,
  buildStagePrompt,
  answerPrompt,
  stageTools,
  stageDisallowed,
  approvalRule,
  decideAfterStage
} = require('../../server/bridge/taskStages');

const base = {
  id: 't1',
  title: 'Anadir botones',
  instruction: 'Anadir botones al tablero',
  status: 'pending',
  stageOutputs: {},
  phases: []
};

test('firstStage: documentacion investiga primero, codigo planifica', () => {
  assert.equal(firstStage('documentation'), 'research');
  assert.equal(firstStage('coding'), 'plan');
  assert.equal(firstStage(undefined), 'plan');
});

test('validateDocOptions: requires a valid format and a safe relative path to edit', () => {
  assert.equal(validateDocOptions({ mode: 'new', format: 'md' }), null);
  assert.equal(validateDocOptions({ mode: 'new', format: 'pdf' }), 'formato no válido (md, html o docx)');
  assert.match(validateDocOptions({ mode: 'edit', format: 'md' }), /ruta relativa/);
  assert.match(validateDocOptions({ mode: 'fragments', format: 'html', targetPath: '/etc/x.html' }), /ruta relativa/);
  assert.match(validateDocOptions({ mode: 'edit', format: 'md', targetPath: '../fuera.md' }), /ruta relativa/);
  assert.equal(validateDocOptions({ mode: 'edit', format: 'md', targetPath: 'docs/guia.md' }), null);
  assert.match(validateDocOptions({ mode: 'new', format: 'md', template: '../plantilla.docx' }), /plantilla/);
  assert.match(validateDocOptions({ mode: 'weird', format: 'md' }), /modo/);
});

test('canRun: a pending task can start plan or research', () => {
  assert.equal(canRun(base, 'plan'), null);
  assert.equal(
    canRun({ ...base, status: 'in_progress' }, 'plan'),
    'la etapa solo puede lanzarse desde una tarea pendiente'
  );
});

test('canRun: review and commit only when ready for review', () => {
  assert.equal(canRun({ ...base, status: 'ready_to_test' }, 'review'), null);
  assert.equal(canRun({ ...base, status: 'ready_to_test' }, 'commit'), null);
  assert.match(canRun(base, 'review'), /lista para revisar/);
});

test('canRun: responder exige pregunta de implementacion pendiente y texto no vacio', () => {
  const awaiting = { ...base, status: 'awaiting_input', pendingQuestion: { kind: 'implement-details', text: '?' } };
  assert.equal(canRun(awaiting, 'implement', { answer: 'usa la opcion B' }), null);
  assert.equal(canRun(awaiting, 'implement', { answer: '   ' }), 'la respuesta no puede estar vacía');
  assert.match(canRun(base, 'implement', { answer: 'hola' }), /no hay preguntas pendientes/);
});

test('canRun: writing requires valid document options, or retrying with the stored ones', () => {
  const awaiting = { ...base, status: 'awaiting_input', pendingQuestion: { kind: 'doc-options', text: '' } };
  assert.equal(canRun(awaiting, 'write', { docOptions: { mode: 'new', format: 'html' } }), null);
  assert.match(canRun(awaiting, 'write', { docOptions: { mode: 'edit', format: 'md' } }), /ruta relativa/);
  assert.equal(canRun({ ...base, status: 'pending', docOptions: { mode: 'new', format: 'md' } }, 'write'), null);
  assert.match(canRun(base, 'write', { docOptions: { mode: 'new', format: 'md' } }), /elegir antes/);
});

test('buildStagePrompt: implementation includes the plan and the blocking notice', () => {
  const task = { ...base, stageOutputs: { plan: 'PASO 1: crear el boton' } };
  const prompt = buildStagePrompt(task, 'implement');
  assert.match(prompt, /PASO 1: crear el boton/);
  assert.match(prompt, /blocked/);
  assert.match(prompt, /No hagas git commit/);
});

test('buildStagePrompt: writing in fragments mode does not touch the existing document', () => {
  const prompt = buildStagePrompt({ ...base, type: 'documentation' }, 'write', {
    docOptions: { mode: 'fragments', format: 'md', targetPath: 'docs/guia.md' }
  });
  assert.match(prompt, /NO modifiques docs\/guia\.md/);
});

test('buildStagePrompt: review and commit forbid changing the repository', () => {
  assert.match(buildStagePrompt(base, 'review'), /No modifiques/);
  const commit = buildStagePrompt(base, 'commit');
  assert.match(commit, /No ejecutes git add, git commit/);
  assert.match(commit, /Co-Authored-By/);
});

test('decideAfterStage: plan encadena implementacion automaticamente', () => {
  const { patch, next } = decideAfterStage(base, 'plan', { text: 'plan final' });
  assert.equal(next, 'implement');
  assert.equal(patch.status, 'pending');
  assert.equal(patch.stageOutputs.plan, 'plan final');
});

test('decideAfterStage: a plan without text does not chain and leaves an error', () => {
  const { patch, next } = decideAfterStage(base, 'plan', { text: '   ' });
  assert.equal(next, null);
  assert.equal(patch.status, 'pending');
  assert.match(patch.error, /no devolvio texto/);
});

test('decideAfterStage: a blocked implementation moves to awaiting_input with the question', () => {
  const { patch, next } = decideAfterStage(base, 'implement', {
    text: 'Necesito el color?',
    hasChanges: false,
    phaseStatus: 'blocked'
  });
  assert.equal(next, null);
  assert.equal(patch.status, 'awaiting_input');
  assert.deepEqual(patch.pendingQuestion, { kind: 'implement-details', text: 'Necesito el color?' });
});

test('decideAfterStage: an implementation with changes chains the verification', () => {
  const { patch, next } = decideAfterStage(base, 'implement', { text: 'hecho', hasChanges: true, phaseStatus: 'done' });
  assert.equal(next, 'verify');
  assert.equal(patch.status, 'pending');
  assert.equal(patch.error, null);
});

test('decideAfterStage: with the Verifier disabled, the implementation becomes ready for review', () => {
  const { patch, next } = decideAfterStage(base, 'implement', { text: 'hecho', hasChanges: true, skip: ['verify'] });
  assert.equal(next, null);
  assert.equal(patch.status, 'ready_to_test');
});

test('decideAfterStage: an implementation without changes goes back to pending with a reason', () => {
  const { patch } = decideAfterStage(base, 'implement', { text: 'nada', hasChanges: false });
  assert.equal(patch.status, 'pending');
  assert.match(patch.error, /no se detectaron cambios/);
});

test('decideAfterStage: research asks the user for document options', () => {
  const { patch, next } = decideAfterStage(base, 'research', { text: 'notas' });
  assert.equal(next, null);
  assert.equal(patch.status, 'awaiting_input');
  assert.equal(patch.pendingQuestion.kind, 'doc-options');
});

test('decideAfterStage: writing ends ready for review', () => {
  const { patch } = decideAfterStage(base, 'write', { text: 'documento', hasChanges: false });
  assert.equal(patch.status, 'ready_to_test');
});

test('decideAfterStage: review and commit keep the task ready for review, even if they fail', () => {
  const ok = decideAfterStage(base, 'review', { text: 'sin hallazgos' });
  assert.equal(ok.patch.status, 'ready_to_test');
  const failed = decideAfterStage(base, 'commit', { text: '', isError: true });
  assert.equal(failed.patch.status, 'ready_to_test');
  assert.match(failed.patch.error, /error/);
});

test('decideAfterStage: a stage error leaves the task pending to retry', () => {
  const { patch, next } = decideAfterStage(base, 'plan', { text: 'x', isError: true });
  assert.equal(next, null);
  assert.equal(patch.status, 'pending');
  assert.match(patch.error, /reintentar/);
});

test('canRun: answering works for plan and research if the question belongs to that stage', () => {
  const planQ = { ...base, status: 'awaiting_input', pendingQuestion: { kind: 'plan-details', text: '?' } };
  assert.equal(canRun(planQ, 'plan', { answer: 'el color es azul' }), null);
  assert.match(canRun(planQ, 'implement', { answer: 'hola' }), /no hay preguntas pendientes/);
  const researchQ = { ...base, status: 'awaiting_input', pendingQuestion: { kind: 'research-details', text: '?' } };
  assert.equal(canRun(researchQ, 'research', { answer: 'el publico es interno' }), null);
  assert.match(canRun(researchQ, 'plan', { answer: 'x' }), /no hay preguntas pendientes/);
});

test('decideAfterStage: a blocked plan asks the user and does not chain the implementation', () => {
  const { patch, next } = decideAfterStage(base, 'plan', { text: 'Que proveedor de pagos?', phaseStatus: 'blocked' });
  assert.equal(next, null);
  assert.equal(patch.status, 'awaiting_input');
  assert.deepEqual(patch.pendingQuestion, { kind: 'plan-details', text: 'Que proveedor de pagos?' });
});

test('decideAfterStage: blocked research asks before requesting document options', () => {
  const { patch } = decideAfterStage(base, 'research', { text: 'Para quien es el manual?', phaseStatus: 'blocked' });
  assert.equal(patch.status, 'awaiting_input');
  assert.equal(patch.pendingQuestion.kind, 'research-details');
});

test('answerPrompt: each stage gets its own continuation', () => {
  assert.match(answerPrompt('azul', 'plan'), /planificación/);
  assert.match(answerPrompt('azul', 'research'), /investigación/);
  assert.match(answerPrompt('azul', 'implement'), /implementación/);
  assert.match(answerPrompt('azul', 'plan'), /Respuesta del usuario/);
});

test('buildStagePrompt: planning and research can ask with the blocked phase', () => {
  assert.match(buildStagePrompt(base, 'plan'), /"blocked"/);
  assert.match(buildStagePrompt({ ...base, type: 'documentation' }, 'research'), /"blocked"/);
});

test('stageTools: read stages can neither edit nor run npm', () => {
  const plan = stageTools('plan');
  assert.ok(plan.includes('Read'));
  assert.ok(!plan.includes('Edit') && !plan.includes('Write'));
  assert.ok(!plan.some((t) => t.startsWith('Bash(npm')));
});

test('stageTools: implementation can edit and use Bash without asking per command', () => {
  const impl = stageTools('implement');
  assert.ok(impl.includes('Edit') && impl.includes('Write'));
  assert.ok(impl.includes('Bash'));
});

test('stageDisallowed: blocks commits, pushes and destructive actions, also with git -c', () => {
  const deny = stageDisallowed();
  for (const rule of [
    'Bash(git commit*)',
    'Bash(git push*)',
    'Bash(git -c * commit*)',
    'Bash(git reset --hard*)',
    'Bash(rm *)'
  ]) {
    assert.ok(deny.includes(rule), `falta ${rule}`);
  }
});

test('stageTools: read stages can query tokensave but not edit it', () => {
  const plan = stageTools('plan');
  assert.ok(plan.includes('mcp__tokensave__tokensave_context'));
  assert.ok(
    !plan.some((t) => t.startsWith('mcp__tokensave') && /str_replace|insert_at|replace_symbol|multi_str/.test(t))
  );
});

test('approvalRule: Bash is approved only for the literal command', () => {
  assert.equal(approvalRule('Bash', 'git ls-files src'), 'Bash(git ls-files src)');
  assert.equal(approvalRule('Bash', 'rm -rf *'), null);
  assert.equal(
    approvalRule('Bash', 'node -e "console.log(\'ok\')" 2>&1 | tail -1'),
    'Bash(node -e "console.log(\'ok\')" 2>&1 | tail -1)'
  );
  assert.equal(approvalRule('Bash', 'a\nb'), null);
  assert.equal(approvalRule('Bash', ''), null);
  assert.equal(approvalRule('Bash', undefined), null);
});

test('approvalRule: non-Bash and MCP tools use their name; odd names are rejected', () => {
  assert.equal(approvalRule('WebSearch'), 'WebSearch');
  assert.equal(approvalRule('mcp__tokensave__tokensave_context'), 'mcp__tokensave__tokensave_context');
  assert.equal(approvalRule('Bash)(x'), null);
  assert.equal(approvalRule('../etc'), null);
});

test('stageTools: an unknown stage grants nothing', () => {
  assert.deepEqual(stageTools('nope'), []);
});

test('buildStagePrompt: every stage forbids redirecting to /dev/null', () => {
  for (const stage of ['plan', 'implement', 'review', 'commit']) {
    assert.match(buildStagePrompt(base, stage), /2>&1/);
  }
});

test('ensureGitGuardHooks: the commit and push hooks always fail', () => {
  const dir = mkTmpDir('gitguard');
  try {
    const hooksDir = ensureGitGuardHooks(dir);
    for (const name of ['pre-commit', 'pre-push']) {
      const r = spawnSync('sh', [path.join(hooksDir, name)], { encoding: 'utf8' });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /los commits, merges y pushes los hace el usuario/);
    }
  } finally {
    rmTmpDir(dir);
  }
});

test('parseCommitSuggestion: takes the last MENSAJE line, tolerating markdown', () => {
  const { parseCommitSuggestion } = require('../../server/bridge/taskStages');
  assert.equal(
    parseCommitSuggestion('git add src\n\nMENSAJE: feat(notes): add edit and delete'),
    'feat(notes): add edit and delete'
  );
  assert.equal(
    parseCommitSuggestion('**MENSAJE:** `fix(store): search ignores case`'),
    'fix(store): search ignores case'
  );
  assert.equal(parseCommitSuggestion('MENSAJE: a\nMENSAJE: b'), 'b');
  assert.equal(parseCommitSuggestion('sin propuesta'), null);
});

test('defaultCommitMessage: conventional type per task type and lower-case summary', () => {
  const { defaultCommitMessage } = require('../../server/bridge/taskStages');
  assert.equal(defaultCommitMessage({ type: 'bugfix', title: 'Arregla la búsqueda.' }), 'fix: arregla la búsqueda');
  assert.equal(defaultCommitMessage({ type: 'documentation', title: 'README de la API' }), 'docs: README de la API');
  assert.equal(defaultCommitMessage({ type: 'coding', title: 'Añade edición' }), 'feat: añade edición');
});

test('decideAfterStage: the commit stage stores its suggested message', () => {
  const { decideAfterStage } = require('../../server/bridge/taskStages');
  const { patch } = decideAfterStage({ type: 'coding' }, 'commit', {
    text: 'git add .\nMENSAJE: feat(api): add delete'
  });
  assert.equal(patch.suggestedCommit, 'feat(api): add delete');
  assert.equal(patch.status, 'ready_to_test');
});

test('stageDisallowed: read-only stages block the edit tools, edit stages do not', () => {
  const { stageDisallowed } = require('../../server/bridge/taskStages');
  for (const stage of ['plan', 'research', 'diagnose', 'audit', 'review']) {
    const deny = stageDisallowed(stage);
    for (const tool of ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
      assert.ok(deny.includes(tool), `${stage}: ${tool}`);
  }
  for (const stage of ['implement', 'write-tests', 'write', 'verify'])
    assert.ok(!stageDisallowed(stage).includes('Edit'));
  assert.ok(stageDisallowed('plan').includes('Bash(git commit*)'));
});

test('onboard: read-only study, report, hidden from the selector and without session details', () => {
  const { TASK_TYPES, buildStagePrompt, stageDisallowed } = require('../../server/bridge/taskStages');
  assert.equal(TASK_TYPES.onboard.internal, true);
  assert.equal(TASK_TYPES.onboard.reportOnly, true);
  assert.ok(stageDisallowed('onboard').includes('Edit'));
  const prompt = buildStagePrompt({ type: 'onboard', title: 'Conocer el repo', instruction: 'x' }, 'onboard');
  assert.match(prompt, /## Comandos/);
  assert.match(prompt, /worktree temporal/);
});

test('describe: PR prompt asks for the title line and leaves the internal process out; Jira is for the ticket', () => {
  const { buildStagePrompt } = require('../../server/bridge/taskStages');
  const task = {
    title: 'Login con Google',
    instruction: 'Añade login con Google',
    type: 'coding',
    baseBranch: 'develop',
    stageOutputs: { plan: 'Plan: usar passport' },
    verification: { ok: true, line: 'VEREDICTO: OK' }
  };
  const pr = buildStagePrompt(task, 'describe', {
    describeOptions: { target: 'pr', notes: 'no menciones la migración' }
  });
  assert.match(pr, /TÍTULO:/);
  assert.match(pr, /git diff develop\.\.\.HEAD/);
  assert.match(pr, /No cuentes el proceso interno/);
  assert.match(pr, /no menciones la migración/);
  assert.match(pr, /Plan: usar passport/);
  const jira = buildStagePrompt(task, 'describe', { describeOptions: { target: 'jira' } });
  assert.match(jira, /ticket de Jira/);
  assert.doesNotMatch(jira, /TÍTULO:/);
});

test('parseDescription: title out of the body, code fences removed', () => {
  const { parseDescription } = require('../../server/bridge/taskStages');
  assert.deepEqual(parseDescription('TÍTULO: feat(auth): login con Google\n\nResumen.\n\n## Cambios\n- x', 'pr'), {
    title: 'feat(auth): login con Google',
    body: 'Resumen.\n\n## Cambios\n- x'
  });
  assert.deepEqual(parseDescription('```markdown\n**TITULO:** `fix: y`\nCuerpo\n```', 'pr'), {
    title: 'fix: y',
    body: 'Cuerpo'
  });
  assert.deepEqual(parseDescription('Hecho X.\nPara probar: Y.', 'jira'), { body: 'Hecho X.\nPara probar: Y.' });
});

test('describe stage: keeps the report on the card and stores the description by target', () => {
  const { decideAfterStage, canRun } = require('../../server/bridge/taskStages');
  const task = {
    type: 'coding',
    status: 'ready_to_test',
    output: 'informe de verificación',
    delivery: { jira: { body: 'j' } }
  };
  assert.equal(canRun(task, 'describe'), null);
  assert.match(canRun({ ...task, status: 'pending' }, 'describe'), /lista para revisar/);
  const { patch, next } = decideAfterStage(task, 'describe', {
    text: 'TÍTULO: feat: x\n\nCuerpo',
    describeTarget: 'pr'
  });
  assert.equal(next, null);
  assert.equal(patch.status, 'ready_to_test');
  assert.equal(patch.output, 'informe de verificación');
  assert.equal(patch.delivery.pr.title, 'feat: x');
  assert.equal(patch.delivery.pr.body, 'Cuerpo');
  assert.equal(patch.delivery.jira.body, 'j', 'the other target is kept');
  const empty = decideAfterStage(task, 'describe', { text: '', describeTarget: 'jira' });
  assert.match(empty.patch.error, /no devolvió/);
});
