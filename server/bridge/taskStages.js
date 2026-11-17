'use strict';

const path = require('path');

// Agent pipelines per task type. Each stage is one agent session (see server/agents/catalog.js) in
// the task's worktree. Transitions are deterministic: they depend on the task type, on whether the
// stage left changes and on the phase the agent itself marked with update_task_progress (blocked =
// it needs details from the user).
//
// coding:        plan -> implement -> verify -> (ready_to_test)
// bugfix:        diagnose -> implement -> verify -> (ready_to_test)
// tests:         plan -> write-tests -> verify -> (ready_to_test)
// documentation: research -> (awaiting_input: mode, format, target) -> write -> (ready_to_test)
// audit:         audit -> (ready_to_test, report only)
// custom:        custom (one stage with a custom agent)
// review, commit and describe (PR or Jira description) are started by hand once the task is ready
// for review.

const STAGES = {
  plan: { phase: 'plan', access: 'read', agent: 'planner', label: 'Planificación', asks: true },
  research: { phase: 'plan', access: 'read', agent: 'researcher', label: 'Investigación', asks: true },
  diagnose: { phase: 'plan', access: 'read', agent: 'debugger', label: 'Diagnóstico', asks: true },
  implement: { phase: 'implement', access: 'edit', agent: 'implementer', label: 'Implementación', asks: true },
  'write-tests': { phase: 'implement', access: 'edit', agent: 'test-writer', label: 'Tests', asks: true },
  write: { phase: 'implement', access: 'edit', agent: 'doc-writer', label: 'Redacción' },
  verify: { phase: 'test', access: 'edit', agent: 'verifier', label: 'Verificación', optional: true },
  audit: { phase: 'test', access: 'read', agent: 'auditor', label: 'Auditoría', asks: true },
  review: { phase: 'test', access: 'read', agent: 'reviewer', label: 'Revisión', manual: true },
  commit: { phase: 'test', access: 'read', agent: 'committer', label: 'Preparar commit', manual: true },
  describe: { phase: 'test', access: 'read', agent: 'pr-writer', label: 'Descripción', manual: true },
  custom: { phase: 'implement', access: null, agent: null, label: 'Agente propio' },
  onboard: { phase: 'plan', access: 'read', agent: 'researcher', label: 'Estudio del repo' }
};

const TASK_TYPES = {
  coding: { label: 'Código', pipeline: ['plan', 'implement', 'verify'] },
  bugfix: { label: 'Bug', pipeline: ['diagnose', 'implement', 'verify'] },
  tests: { label: 'Tests', pipeline: ['plan', 'write-tests', 'verify'] },
  documentation: { label: 'Documentación', pipeline: ['research', 'write'] },
  audit: { label: 'Auditoría', pipeline: ['audit'], reportOnly: true },
  custom: { label: 'Agente propio', pipeline: ['custom'] },
  // "Conocer este repo" (Settings > Memory): studies the repo and proposes its memory. Not listed
  // in the chat's mode selector.
  onboard: { label: 'Conocer el repo', pipeline: ['onboard'], reportOnly: true, internal: true }
};

const STAGE_PHASE = Object.fromEntries(Object.entries(STAGES).map(([k, v]) => [k, v.phase]));

const DOC_MODES = ['new', 'edit', 'fragments'];
const DOC_FORMATS = ['md', 'html', 'docx'];

// Stages that may stop to ask the user, and the kind of question they show. Answering always
// resumes the same stage in the same conversation.
const QUESTION_KIND = Object.fromEntries(
  Object.entries(STAGES)
    .filter(([, v]) => v.asks)
    .map(([k]) => [k, `${k}-details`])
);
const QUESTION_STAGE = Object.fromEntries(Object.entries(QUESTION_KIND).map(([stage, kind]) => [kind, stage]));

const ASK_RULE = (phase) =>
  `Si no puedes avanzar sin datos que solo tiene el usuario, NO inventes: llama a update_task_progress con fase "${phase}" y estado "blocked" y termina tu respuesta con preguntas numeradas, concretas y cortas. Si puedes avanzar, no preguntes.`;

// Tools each stage may use without asking. A headless session has nowhere to answer a permission
// prompt, so Bash is allowed in every stage: what a stage must not do is blocked with
// the safety policy (policy.js, plus the git hook for commits and pushes), not with an allow list
// that would require approving every command.
const READ_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'LS',
  'WebSearch',
  'WebFetch',
  'Bash',
  'mcp__tokensave__tokensave_context',
  'mcp__tokensave__tokensave_search',
  'mcp__tokensave__tokensave_node',
  'mcp__tokensave__tokensave_callers',
  'mcp__tokensave__tokensave_callees',
  'mcp__tokensave__tokensave_impact',
  'mcp__tokensave__tokensave_files',
  'mcp__tokensave__tokensave_dependencies'
];
const EDIT_TOOLS = ['Edit', 'MultiEdit', 'Write'];
// Denials that win over any allow rule. They match the command text, so the `git -c ...` variants
// are listed too.
// Destructive commands, commits and pushes are not deny rules any more: the PreToolUse hook of
// policy.js blocks them, explains why to the agent and lets the user approve exact commands from the
// card. The git hook (gitGuard.js) still blocks commits and pushes at the git level.
const STAGE_DISALLOWED = [];

function isKnownType(type) {
  return Object.prototype.hasOwnProperty.call(TASK_TYPES, type);
}

function pipelineOf(type) {
  return (TASK_TYPES[type] || TASK_TYPES.coding).pipeline;
}

/** A stage's access: the stage's own, or the agent's for the custom stage. */
function stageAccess(stage, agent) {
  if (stage === 'custom') return agent?.access === 'edit' ? 'edit' : 'read';
  return STAGES[stage]?.access || null;
}

function stageTools(stage, agent) {
  const access = stageAccess(stage, agent);
  if (access === 'edit') return [...READ_TOOLS, ...EDIT_TOOLS];
  if (access === 'read') return [...READ_TOOLS];
  return [];
}

// What a stage can never do. Read-only stages also block the edit tools: a deny wins over any allow
// (including a permission the user approved in another stage or an inherited acceptEdits
// defaultMode).
function stageDisallowed(stage, agent) {
  const deny = [...STAGE_DISALLOWED];
  if (stage && stageAccess(stage, agent) !== 'edit') deny.push(...EDIT_TOOLS, 'NotebookEdit');
  return deny;
}

// Exact permission rule for a tool a stage had to ask for. Bash is approved only for that literal
// command: no wildcards (*) or line breaks, which would widen the rule.
function approvalRule(tool, command) {
  if (typeof tool !== 'string' || !/^(mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+|[A-Z][A-Za-z]+)$/.test(tool)) return null;
  if (tool !== 'Bash') return tool;
  if (typeof command !== 'string') return null;
  const c = command.trim();
  if (!c || c.length > 300 || /[*\n\r]/.test(c)) return null;
  return `Bash(${c})`;
}

// Claude Code asks for approval for any redirection to /dev/null even when a rule matches, so a
// stage that uses one gets stuck with no way to approve it from the card. Every stage is asked to
// avoid it.
const SHELL_RULE =
  'Al ejecutar comandos no uses redirecciones a /dev/null (2>/dev/null ni >/dev/null): para silenciar errores usa 2>&1.';

function firstStage(type) {
  return pipelineOf(type)[0];
}

/**
 * Stage that follows `stage` in the type's pipeline, skipping disabled optional stages (`skip`,
 * e.g. verify when the Verifier is turned off).
 */
function nextStage(type, stage, { skip = [] } = {}) {
  const pipeline = pipelineOf(type);
  for (let i = pipeline.indexOf(stage) + 1; i > 0 && i < pipeline.length; i++) {
    const candidate = pipeline[i];
    if (STAGES[candidate]?.optional && skip.includes(candidate)) continue;
    return candidate;
  }
  return null;
}

function isSafeRelPath(p) {
  if (typeof p !== 'string' || p.trim() === '') return false;
  if (path.isAbsolute(p)) return false;
  return !p.split(/[\\/]/).includes('..');
}

function validateDocOptions(o) {
  if (!o || typeof o !== 'object') return 'elige el modo de salida, el formato y el destino';
  if (!DOC_MODES.includes(o.mode)) return 'modo de salida no válido';
  if (!DOC_FORMATS.includes(o.format)) return 'formato no válido (md, html o docx)';
  if (o.mode !== 'new' && !isSafeRelPath(o.targetPath)) return 'indica la ruta relativa del documento existente';
  if (o.mode === 'new' && o.targetPath && !isSafeRelPath(o.targetPath)) return 'ruta de destino no valida';
  if (o.template && !isSafeRelPath(o.template)) return 'ruta de plantilla no valida';
  return null;
}

// Returns null if the stage can start now, or the reason as a string.
function canRun(task, stage, { answer, docOptions } = {}) {
  if (!task) return 'tarea no encontrada';
  const { status, pendingQuestion } = task;

  if (stage === 'review' || stage === 'commit' || stage === 'describe') {
    return status === 'ready_to_test'
      ? null
      : 'la revisión, el commit y la descripción solo están disponibles cuando la tarea está lista para revisar';
  }

  if (answer !== undefined) {
    if (typeof answer !== 'string' || !answer.trim()) return 'la respuesta no puede estar vacía';
    return status === 'awaiting_input' && QUESTION_STAGE[pendingQuestion?.kind] === stage
      ? null
      : 'no hay preguntas pendientes para esta etapa';
  }

  if (stage === 'write') {
    if (status === 'awaiting_input' && pendingQuestion?.kind === 'doc-options') return validateDocOptions(docOptions);
    // Retry after a failure: reuses the options already stored.
    if (status === 'pending' && task.docOptions) return validateDocOptions(task.docOptions);
    return 'la redacción requiere elegir antes el formato y el destino';
  }

  if (stage === 'custom' && !task.agentId) return 'la tarea no tiene agente asignado';

  if (STAGES[stage] && !STAGES[stage].manual) {
    if (!pipelineOf(task.type).includes(stage)) return `la etapa "${stage}" no es de este tipo de tarea`;
    // Verifying again a task that is already ready for review is allowed too.
    if (stage === 'verify' && status === 'ready_to_test') return null;
    return status === 'pending' ? null : 'la etapa solo puede lanzarse desde una tarea pendiente';
  }

  return `etapa desconocida: ${stage}`;
}

function buildWritePrompt(task, { mode, format, targetPath, template }, research) {
  const goal = task.instruction || task.title;
  const tpl = template ? ` Usa la plantilla ${template} como base de estructura y estilo.` : '';
  const fmtNote =
    format === 'docx'
      ? 'Formato: docx. Genera el fichero con la skill docx si está disponible; si no, dilo claramente.'
      : `Formato: ${format}.`;
  const notes = research ? `Notas de investigación:\n${research}` : 'No hay notas de investigación previas.';

  if (mode === 'edit') {
    return [
      'Etapa de REDACCION: editar un documento existente.',
      `Edita ${targetPath} manteniendo su estructura, tono y estilo. ${fmtNote}${tpl}`,
      `Encargo:\n${goal}`,
      notes
    ].join('\n\n');
  }
  if (mode === 'fragments') {
    return [
      'Etapa de REDACCION: trozos para añadir a un documento existente.',
      `NO modifiques ${targetPath}. Devuelve en tu respuesta los trozos de texto que habria que añadir, indicando en cada uno donde insertarlo (seccion o ancla). ${fmtNote}${tpl}`,
      `Encargo:\n${goal}`,
      notes
    ].join('\n\n');
  }
  const dest = targetPath || `docs/<nombre-kebab>.${format}`;
  return [
    'Etapa de REDACCION: documento nuevo.',
    `Crea el documento en ${dest}. ${fmtNote}${tpl}`,
    `Encargo:\n${goal}`,
    notes
  ].join('\n\n');
}

const DESCRIBE_TARGETS = ['pr', 'jira'];

// What the describe stage knows about the task: the request and what the earlier stages concluded.
// The diff is read by the agent itself, against the base branch.
function taskContext(task) {
  const out = task.stageOutputs || {};
  const parts = [`Encargo original:\n${task.instruction || task.title}`];
  const plan = out.plan || out.diagnose;
  if (plan) parts.push(`${out.diagnose ? 'Diagnóstico' : 'Plan'} de la tarea:\n${plan.slice(0, 6000)}`);
  if (task.verification?.line) parts.push(`Verificación: ${task.verification.line}`);
  return parts.join('\n\n');
}

function buildDescribePrompt(task, { target, notes }) {
  const base = task.baseBranch || 'la rama base';
  const range = task.baseBranch ? `${task.baseBranch}...HEAD` : 'HEAD~1...HEAD';
  const common = [
    'Etapa de DESCRIPCION. No modifiques ficheros ni ejecutes git commit, git push ni gh.',
    `Lee los cambios de esta rama respecto a ${base}: git log --oneline ${range} y git diff ${range}.`,
    taskContext(task),
    notes ? `Indicaciones del usuario (mandan sobre todo lo demás):\n${notes}` : null,
    'Escribe en el idioma de los commits del repo. Sin firmas de agente, sin "Generated with" ni menciones a la IA.'
  ];
  if (target === 'jira') {
    return [
      ...common,
      [
        'Escribe un comentario para el ticket de Jira de esta tarea, para quien sigue el ticket (producto, QA, el equipo):',
        '- Qué se ha hecho y por qué, en lenguaje de negocio.',
        '- Cómo probarlo o verificarlo.',
        '- Decisiones tomadas, limitaciones y lo que queda pendiente.',
        'Detalles de código solo los imprescindibles. Markdown sencillo (Jira lo convierte al pegarlo).',
        'Responde SOLO con el comentario, sin preámbulo.'
      ].join('\n')
    ]
      .filter(Boolean)
      .join('\n\n');
  }
  return [
    ...common,
    [
      'Escribe la descripción de la pull request, para quien la va a revisar:',
      '- Si el repo tiene plantilla de PR (.github/pull_request_template.md, .github/PULL_REQUEST_TEMPLATE/, docs/pull_request_template.md), síguela.',
      '- Si no: un resumen de 1-3 frases, "## Cambios" con los cambios principales y "## Cómo probarlo".',
      '- Describe solo lo que contiene el diff. No cuentes el proceso interno de la tarea (planes descartados, intentos fallidos, preguntas al usuario) ni contexto interno que no aporte a la revisión.',
      'Primera línea exactamente "TÍTULO: <título de la PR>", corto y en el estilo de los commits del repo (Conventional Commits si los usa). Después, la descripción en markdown, sin preámbulo.'
    ].join('\n')
  ]
    .filter(Boolean)
    .join('\n\n');
}

// Title and body out of the describe stage's answer ("TÍTULO: ..." first, then the body).
function parseDescription(text, target) {
  let body = String(text || '').trim();
  const fenced = /^```(?:markdown|md)?\n([\s\S]*?)\n```$/.exec(body);
  if (fenced) body = fenced[1].trim();
  if (target === 'jira') return { body };
  const m = /^\s*\**T[IÍ]TULO:\**\s*`?(.+?)`?\s*$/im.exec(body);
  const title = m ? m[1].trim().slice(0, 120) : '';
  if (m) body = (body.slice(0, m.index) + body.slice(m.index + m[0].length)).trim();
  return { title, body };
}

// Agents work with as little human intervention as possible: they stop only for missing details.
const AUTONOMY_RULE =
  'Trabaja de forma autónoma: decide tú los detalles razonables y anótalos en tu respuesta. Para solo si falta concreción o contexto que no puedas deducir del repo. Si una acción queda bloqueada por seguridad, no te detengas: sigue por otro camino y, si era imprescindible, di al final qué necesitabas y para qué (el usuario puede permitirla desde la tarjeta).';

function buildStagePrompt(task, stage, opts = {}) {
  return `${buildStageBody(task, stage, opts)}\n\n${AUTONOMY_RULE}\n\n${SHELL_RULE}`;
}

// What the previous stage wrote and the implementation stage needs.
function previousOutput(task, stage) {
  const out = (s) => (task.stageOutputs && task.stageOutputs[s]) || '';
  const pipeline = pipelineOf(task.type);
  const idx = pipeline.indexOf(stage);
  return idx > 0 ? out(pipeline[idx - 1]) : '';
}

function buildStageBody(task, stage, { docOptions, agent, describeOptions } = {}) {
  const goal = task.instruction || task.title;
  const out = (s) => (task.stageOutputs && task.stageOutputs[s]) || '';
  switch (stage) {
    case 'plan':
      return [
        'Etapa de PLANIFICACION. No modifiques ficheros del repositorio.',
        'Usa la skill plan y la skill plan-optimizer si están disponibles para cerrar un plan concreto.',
        `Encargo:\n${goal}`,
        ASK_RULE('plan'),
        task.type === 'tests'
          ? 'Si planificas, termina con el plan de tests: que comportamientos cubrir, casos límite y donde van los ficheros de test.'
          : 'Si planificas, termina con el plan final en texto, listo para que otro agente lo implemente.'
      ].join('\n\n');
    case 'diagnose':
      return [
        'Etapa de DIAGNOSTICO. No modifiques ficheros del repositorio.',
        `Bug a resolver:\n${goal}`,
        'Reproduce el fallo si es posible (tests, scripts, comandos), localiza la causa raíz con evidencias y termina con: 1) causa raíz, 2) ficheros y líneas implicados, 3) el arreglo minimo propuesto, 4) como comprobar que queda arreglado.',
        ASK_RULE('plan')
      ].join('\n\n');
    case 'implement':
      return [
        'Etapa de IMPLEMENTACION. Implementa el plan siguiente en este worktree.',
        // The original request always goes in: the plan may not capture every detail or acceptance
        // criterion the user asked for.
        `Encargo original del usuario (manda si el plan lo contradice u omite algo):\n${goal}`,
        previousOutput(task, 'implement')
          ? `${task.type === 'bugfix' ? 'Diagnóstico' : 'Plan'}:\n${previousOutput(task, 'implement')}`
          : null,
        'Reporta el progreso con update_task_progress (fase "implement").',
        'Si te falta un dato para continuar, llama a update_task_progress con fase "implement" y estado "blocked", y termina tu respuesta con las preguntas concretas que necesitas que responda el usuario.',
        'No hagas git commit ni git push.'
      ]
        .filter(Boolean)
        .join('\n\n');
    case 'write-tests':
      return [
        'Etapa de TESTS. Escribe los tests del plan siguiente en este worktree, con el framework que ya usa el proyecto.',
        `Encargo original del usuario:\n${goal}`,
        out('plan') ? `Plan de tests:\n${out('plan')}` : null,
        'Ejecuta los tests nuevos y comprueba que pasan (o que fallan por un bug real, explicandolo).',
        ASK_RULE('implement'),
        'No hagas git commit ni git push.'
      ]
        .filter(Boolean)
        .join('\n\n');
    case 'verify':
      return [
        'Etapa de VERIFICACION de los cambios de este worktree (git diff HEAD).',
        `Encargo original:\n${goal}`,
        'Ejecuta los tests, el lint y la compilacion que tenga el proyecto. Si algo falla por estos cambios y el arreglo es pequeno y evidente, arreglalo; si no, no lo toques y explica el fallo.',
        'No hagas git commit ni git push.',
        'Termina tu respuesta con una línea exactamente "VEREDICTO: OK" si todo pasa, o "VEREDICTO: FALLA" seguido del motivo.'
      ].join('\n\n');
    case 'review':
      return [
        'Etapa de REVISION FINAL. No modifiques ficheros.',
        `Encargo original:\n${goal}`,
        'Comprueba que los cambios cumplen el encargo y revisa los cambios staged de este worktree (git diff --cached). Usa la skill code-review si está disponible.',
        'Devuelve los hallazgos ordenados por gravedad, con fichero:línea, y un veredicto final: listo para ship o cambios necesarios.'
      ].join('\n\n');
    case 'commit':
      return [
        'Etapa de PREPARAR COMMIT. No ejecutes git add, git commit ni git push.',
        'Revisa los cambios staged (git diff --cached --stat y git diff --cached) y el estilo de los ultimos commits (git log --oneline -10).',
        'Propon un mensaje en formato Conventional Commits: tipo(ambito): resumen en minusculas, imperativo, sin punto final y de 72 caracteres como mucho; si hace falta, un cuerpo breve tras una línea en blanco. Sigue el idioma de los commits anteriores del repo. No anadas líneas Co-Authored-By ni firmas de agente.',
        'Termina SIEMPRE con una línea exacta "MENSAJE: <primera línea del commit>", que optimia usa para rellenar el campo de commit.'
      ].join('\n\n');
    case 'describe':
      return buildDescribePrompt(task, describeOptions || {});
    case 'research':
      return [
        'Etapa de INVESTIGACION. No escribas ni modifiques documentos.',
        `Encargo de documentación:\n${goal}`,
        ASK_RULE('plan'),
        'Si investigas, lee el repositorio y las fuentes necesarias. Devuelve notas estructuradas: hechos verificados (con fuente), huecos de información y ficheros existentes relacionados.'
      ].join('\n\n');
    case 'write':
      return buildWritePrompt(task, docOptions || task.docOptions || {}, out('research'));
    case 'onboard':
      return [
        'Etapa de ESTUDIO DEL REPO. No modifiques ficheros.',
        'Vas a escribir la memoria de este repositorio: el conocimiento que el chat y todos los agentes reciben en cada sesión para trabajar aquí sin redescubrirlo. Si ya hay una memoria (la tienes en el system prompt), mejórala: conserva lo que siga siendo cierto y útil.',
        `Indicaciones del usuario:\n${goal}`,
        'Investiga leyendo los ficheros (manifiestos, README, configuración de CI, scripts, estructura de carpetas) y el historial (git log --oneline -30). Puedes ejecutar comandos de solo lectura y, si son rápidos, comprobar que el comando de tests funciona.',
        [
          'Responde SOLO con el markdown completo de la memoria, sin preámbulo, con estos apartados (omite los que no apliquen):',
          '## Qué es — una o dos frases.',
          '## Comandos — instalar, arrancar, tests, lint, formato y build, exactamente como se ejecutan aquí (marca los que no hayas podido comprobar).',
          '## Estructura — dónde está cada cosa importante.',
          '## Convenciones — estilo de código, idioma, mensajes de commit (según el historial), cómo se escriben los tests.',
          '## Cuidado con — trampas, ficheros generados, cosas que no se deben tocar.',
          'Sé concreto y breve (unas 60 líneas como mucho): es contexto que se paga en cada sesión.',
          'Escribe solo conocimiento estable del repo. No incluyas nada de esta sesión: estás en un worktree temporal de optimia en una rama de tarea (optimia/task-…), y esa ruta y esa rama no son del repo. La rama principal sí. Tampoco repitas las instrucciones que ya recibes en el system prompt.'
        ].join('\n')
      ].join('\n\n');
    case 'audit':
      return [
        'Etapa de AUDITORIA. No modifiques ficheros.',
        `Alcance de la auditoría:\n${goal}`,
        ASK_RULE('test'),
        'Devuelve un informe con los hallazgos ordenados por gravedad (critica, alta, media, baja), cada uno con evidencia (fichero:línea), impacto y recomendacion concreta, y un resumen final.'
      ].join('\n\n');
    case 'custom':
      return [
        `Encargo:\n${goal}`,
        agent?.access === 'edit'
          ? 'Trabaja en este worktree. No hagas git commit ni git push.'
          : 'No modifiques ficheros del repositorio: entrega tu resultado en la respuesta.'
      ].join('\n\n');
    default:
      throw new Error(`etapa desconocida: ${stage}`);
  }
}

function answerPrompt(answer, stage) {
  const tail =
    {
      plan: 'Continua la planificación con esta respuesta y termina con el plan final.',
      research: 'Continua la investigación con esta respuesta y termina con las notas estructuradas.',
      diagnose: 'Continua el diagnóstico con esta respuesta y termina con la causa raíz y el arreglo propuesto.',
      implement: 'Continua la implementación y termina cuando el cambio este completo.',
      'write-tests': 'Continua con los tests y termina cuando esten escritos y ejecutados.',
      audit: 'Continua la auditoría con esta respuesta y termina con el informe.'
    }[stage] || 'Continua y termina tu etapa.';
  return `Respuesta del usuario a tus preguntas:\n${answer.trim()}\n\n${tail}`;
}

// "VEREDICTO: OK" / "VEREDICTO: FALLA ..." at the end of the verification.
function parseVerdict(text) {
  const m = /VEREDICTO:\s*(OK|FALLA)\b[^\n]*/i.exec(text || '');
  if (!m) return null;
  return { ok: m[1].toUpperCase() === 'OK', line: m[0].trim() };
}

// Message proposed by the "Preparar commit" stage (its last "MENSAJE: ..." line).
function parseCommitSuggestion(text) {
  const matches = [...String(text || '').matchAll(/^\s*\**MENSAJE:\**\s*`?([^`\n]+?)`?\s*$/gim)];
  const msg = matches.length ? matches[matches.length - 1][1].trim() : '';
  return msg && msg.length <= 120 ? msg : null;
}

// Default message when no commit was prepared: conventional type from the task type and the title
// starting in lower case.
const COMMIT_TYPE = { coding: 'feat', bugfix: 'fix', tests: 'test', documentation: 'docs', audit: 'chore' };
function defaultCommitMessage(task) {
  const type = COMMIT_TYPE[task.type] || 'feat';
  const title = String(task.title || '')
    .trim()
    .replace(/[.:]+$/, '');
  // "Añade X" -> "añade X", but acronyms stay as they are ("README", "API").
  const acronym = /^\p{Lu}{2,}/u.test(title);
  const summary = acronym ? title : title.charAt(0).toLocaleLowerCase('es') + title.slice(1);
  return `${type}: ${summary}`.slice(0, 72);
}

/**
 * Decides the task's state after a stage ends.
 * outcome: { text, hasChanges, phaseStatus, isError, skip, agent }
 * Returns { patch, next }: patch is applied to the task; next is the stage to start automatically
 * right after (or null).
 */
function decideAfterStage(
  task,
  stage,
  { text = '', hasChanges = false, phaseStatus, isError = false, skip = [], agent, describeTarget } = {}
) {
  const stageOutputs = { ...(task.stageOutputs || {}), [stage]: text };
  const base = { stage, stageOutputs, output: text, pendingQuestion: null, pendingPermission: null, error: null };
  const done = (patch, next = null) => ({ patch: { ...base, ...patch }, next });
  const following = nextStage(task.type, stage, { skip });
  const reportOnly = Boolean(TASK_TYPES[task.type]?.reportOnly);

  // Review and commit do not change the state of the changes: a failure is only shown, and the task
  // stays ready for review.
  if (stage === 'describe') {
    const target = DESCRIBE_TARGETS.includes(describeTarget) ? describeTarget : 'pr';
    const parsed = isError ? null : parseDescription(text, target);
    const delivery = { ...(task.delivery || {}) };
    if (parsed?.body) delivery[target] = { ...parsed, generatedAt: new Date().toISOString() };
    return done({
      status: 'ready_to_test',
      // The previous report stays on the card: the description goes into its own editor.
      output: task.output,
      error: isError ? 'la etapa terminó con error' : parsed?.body ? null : 'el agente no devolvió ninguna descripción',
      delivery
    });
  }
  if (stage === 'review' || stage === 'commit') {
    const suggested = stage === 'commit' ? parseCommitSuggestion(text) : null;
    return done({
      status: 'ready_to_test',
      error: isError ? 'la etapa terminó con error' : null,
      ...(suggested ? { suggestedCommit: suggested } : {})
    });
  }
  if (isError) return done({ status: 'pending', error: 'la etapa terminó con error; puedes reintentarla' });
  if (QUESTION_KIND[stage] && phaseStatus === 'blocked') {
    return done({
      status: 'awaiting_input',
      pendingQuestion: { kind: QUESTION_KIND[stage], text: text || 'El agente necesita más detalles para continuar.' }
    });
  }

  const access = stageAccess(stage, agent);
  if (stage === 'research') {
    if (!text.trim()) return done({ status: 'pending', error: 'la investigación no devolvio texto' });
    return done({
      status: 'awaiting_input',
      pendingQuestion: {
        kind: 'doc-options',
        text: 'Investigación lista. Elige el modo de salida, el formato y el destino.'
      }
    });
  }
  if (stage === 'verify') {
    const verdict = parseVerdict(text);
    return done({
      status: 'ready_to_test',
      verification: verdict ? { ...verdict, at: new Date().toISOString() } : null
    });
  }
  if (stage === 'write') return done({ status: 'ready_to_test' });
  if (stage === 'audit' || reportOnly) {
    if (!text.trim()) return done({ status: 'pending', error: 'la etapa no devolvio ningun informe' });
    return done({ status: 'ready_to_test', reportOnly: true });
  }
  if (access === 'read') {
    // Stages that only prepare text for the next one (plan, diagnosis) or read-only custom agents.
    if (!text.trim()) {
      const what = { plan: 'la planificación', diagnose: 'el diagnóstico' }[stage] || 'la etapa';
      return done({ status: 'pending', error: `${what} no devolvio texto` });
    }
    if (following) return done({ status: 'pending' }, following);
    return done({ status: 'ready_to_test', reportOnly: !hasChanges });
  }
  // Stages that edit: without changes there is nothing to review.
  if (!hasChanges) return done({ status: 'pending', error: 'no se detectaron cambios en el worktree' });
  if (following) return done({ status: 'pending' }, following);
  return done({ status: 'ready_to_test' });
}

module.exports = {
  DESCRIBE_TARGETS,
  parseDescription,
  parseCommitSuggestion,
  defaultCommitMessage,
  STAGES,
  TASK_TYPES,
  STAGE_PHASE,
  QUESTION_KIND,
  QUESTION_STAGE,
  DOC_MODES,
  DOC_FORMATS,
  isKnownType,
  pipelineOf,
  firstStage,
  nextStage,
  stageAccess,
  stageTools,
  stageDisallowed,
  approvalRule,
  validateDocOptions,
  canRun,
  buildStagePrompt,
  answerPrompt,
  parseVerdict,
  decideAfterStage
};
