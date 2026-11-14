'use strict';

const path = require('path');

// Pipelines de agentes por tipo de tarea. Cada etapa es una sesion de un agente
// (ver server/agents/catalog.js) en el worktree de la tarea. Las transiciones son
// deterministas: dependen del tipo de tarea, de si la etapa dejo cambios y de la
// fase que el propio agente marco con update_task_progress (blocked = necesita
// detalles del usuario).
//
// coding:        plan -> implement -> verify -> (ready_to_test)
// bugfix:        diagnose -> implement -> verify -> (ready_to_test)
// tests:         plan -> write-tests -> verify -> (ready_to_test)
// documentation: research -> (awaiting_input: modo, formato, destino) -> write -> (ready_to_test)
// audit:         audit -> (ready_to_test, solo informe)
// custom:        custom (una etapa con un agente propio)
// review y commit se lanzan a mano cuando la tarea esta lista para revisar.

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
  custom: { phase: 'implement', access: null, agent: null, label: 'Agente propio' }
};

const TASK_TYPES = {
  coding: { label: 'Código', pipeline: ['plan', 'implement', 'verify'] },
  bugfix: { label: 'Bug', pipeline: ['diagnose', 'implement', 'verify'] },
  tests: { label: 'Tests', pipeline: ['plan', 'write-tests', 'verify'] },
  documentation: { label: 'Documentación', pipeline: ['research', 'write'] },
  audit: { label: 'Auditoría', pipeline: ['audit'], reportOnly: true },
  custom: { label: 'Agente propio', pipeline: ['custom'] }
};

const STAGE_PHASE = Object.fromEntries(Object.entries(STAGES).map(([k, v]) => [k, v.phase]));

const DOC_MODES = ['new', 'edit', 'fragments'];
const DOC_FORMATS = ['md', 'html', 'docx'];

// Etapas que pueden parar para preguntar al usuario, y el tipo de pregunta que
// muestran. Responder siempre reanuda la misma etapa con la misma conversacion.
const QUESTION_KIND = Object.fromEntries(
  Object.entries(STAGES)
    .filter(([, v]) => v.asks)
    .map(([k]) => [k, `${k}-details`])
);
const QUESTION_STAGE = Object.fromEntries(Object.entries(QUESTION_KIND).map(([stage, kind]) => [kind, stage]));

const ASK_RULE = (phase) =>
  `Si no puedes avanzar sin datos que solo tiene el usuario, NO inventes: llama a update_task_progress con fase "${phase}" y estado "blocked" y termina tu respuesta con preguntas numeradas, concretas y cortas. Si puedes avanzar, no preguntes.`;

// Herramientas que cada etapa puede usar sin preguntar. Una sesion headless no
// tiene donde contestar a un permiso, asi que Bash va libre en todas las etapas:
// lo que no puede hacer se bloquea con STAGE_DISALLOWED (y el hook de git para
// commits y pushes), no con una lista blanca que obliga a aprobar cada comando.
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
// Denegaciones que ganan sobre cualquier allow. Coinciden con el texto del
// comando, asi que tambien van las variantes con `git -c ...`.
const STAGE_DISALLOWED = [
  'Bash(rm *)',
  'Bash(sudo *)',
  'Bash(chmod -R *)',
  'Bash(find * -delete*)',
  'Bash(git reset --hard*)',
  'Bash(git clean *)',
  'Bash(git checkout -- *)',
  'Bash(git restore *)',
  'Bash(git branch -D *)',
  'Bash(git branch -d *)',
  'Bash(git worktree remove *)',
  'Bash(git stash drop*)',
  'Bash(git commit*)',
  'Bash(git push*)',
  'Bash(git merge*)',
  'Bash(git rebase*)',
  'Bash(git -c * commit*)',
  'Bash(git -c * push*)',
  'Bash(git -c * merge*)',
  'Bash(git -c * rebase*)'
];

function isKnownType(type) {
  return Object.prototype.hasOwnProperty.call(TASK_TYPES, type);
}

function pipelineOf(type) {
  return (TASK_TYPES[type] || TASK_TYPES.coding).pipeline;
}

/** Acceso de una etapa: el de la etapa, o el del agente para la etapa custom. */
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

function stageDisallowed() {
  return [...STAGE_DISALLOWED];
}

// Regla de permiso exacta para una herramienta que una etapa tuvo que pedir.
// Bash se aprueba solo para ese comando literal: sin comodines (*) ni saltos
// de linea, que ampliarian la regla.
function approvalRule(tool, command) {
  if (typeof tool !== 'string' || !/^(mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+|[A-Z][A-Za-z]+)$/.test(tool)) return null;
  if (tool !== 'Bash') return tool;
  if (typeof command !== 'string') return null;
  const c = command.trim();
  if (!c || c.length > 300 || /[*\n\r]/.test(c)) return null;
  return `Bash(${c})`;
}

// Claude Code pide aprobacion para cualquier redireccion a /dev/null aunque la
// regla coincida, asi que una etapa que la use se bloquea sin remedio desde la
// tarjeta. Se le pide evitarla en todas las etapas.
const SHELL_RULE =
  'Al ejecutar comandos no uses redirecciones a /dev/null (2>/dev/null ni >/dev/null): para silenciar errores usa 2>&1.';

function firstStage(type) {
  return pipelineOf(type)[0];
}

/**
 * Etapa que sigue a `stage` en el pipeline del tipo, saltando las etapas
 * opcionales desactivadas (`skip`, p. ej. verify si el Verificador esta apagado).
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
  if (!DOC_MODES.includes(o.mode)) return 'modo de salida no valido';
  if (!DOC_FORMATS.includes(o.format)) return 'formato no valido (md, html o docx)';
  if (o.mode !== 'new' && !isSafeRelPath(o.targetPath)) return 'indica la ruta relativa del documento existente';
  if (o.mode === 'new' && o.targetPath && !isSafeRelPath(o.targetPath)) return 'ruta de destino no valida';
  if (o.template && !isSafeRelPath(o.template)) return 'ruta de plantilla no valida';
  return null;
}

// Devuelve null si la etapa puede lanzarse ahora, o el motivo como string.
function canRun(task, stage, { answer, docOptions } = {}) {
  if (!task) return 'tarea no encontrada';
  const { status, pendingQuestion } = task;

  if (stage === 'review' || stage === 'commit') {
    return status === 'ready_to_test'
      ? null
      : 'la revision y el commit solo estan disponibles cuando la tarea esta lista para revisar';
  }

  if (answer !== undefined) {
    if (typeof answer !== 'string' || !answer.trim()) return 'la respuesta no puede estar vacia';
    return status === 'awaiting_input' && QUESTION_STAGE[pendingQuestion?.kind] === stage
      ? null
      : 'no hay preguntas pendientes para esta etapa';
  }

  if (stage === 'write') {
    if (status === 'awaiting_input' && pendingQuestion?.kind === 'doc-options') return validateDocOptions(docOptions);
    // Reintento tras un fallo: reutiliza las opciones ya guardadas.
    if (status === 'pending' && task.docOptions) return validateDocOptions(task.docOptions);
    return 'la redaccion requiere elegir antes el formato y el destino';
  }

  if (stage === 'custom' && !task.agentId) return 'la tarea no tiene agente asignado';

  if (STAGES[stage] && !STAGES[stage].manual) {
    if (!pipelineOf(task.type).includes(stage)) return `la etapa "${stage}" no es de este tipo de tarea`;
    // Verificar otra vez una tarea ya lista para revisar tambien vale.
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
      ? 'Formato: docx. Genera el fichero con la skill docx si esta disponible; si no, dilo claramente.'
      : `Formato: ${format}.`;
  const notes = research ? `Notas de investigacion:\n${research}` : 'No hay notas de investigacion previas.';

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
      'Etapa de REDACCION: trozos para anadir a un documento existente.',
      `NO modifiques ${targetPath}. Devuelve en tu respuesta los trozos de texto que habria que anadir, indicando en cada uno donde insertarlo (seccion o ancla). ${fmtNote}${tpl}`,
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

function buildStagePrompt(task, stage, opts = {}) {
  return `${buildStageBody(task, stage, opts)}\n\n${SHELL_RULE}`;
}

// Lo que la etapa anterior dejo escrito y que la etapa de implementacion necesita.
function previousOutput(task, stage) {
  const out = (s) => (task.stageOutputs && task.stageOutputs[s]) || '';
  const pipeline = pipelineOf(task.type);
  const idx = pipeline.indexOf(stage);
  return idx > 0 ? out(pipeline[idx - 1]) : '';
}

function buildStageBody(task, stage, { docOptions, agent } = {}) {
  const goal = task.instruction || task.title;
  const out = (s) => (task.stageOutputs && task.stageOutputs[s]) || '';
  switch (stage) {
    case 'plan':
      return [
        'Etapa de PLANIFICACION. No modifiques ficheros del repositorio.',
        'Usa la skill plan y la skill plan-optimizer si estan disponibles para cerrar un plan concreto.',
        `Encargo:\n${goal}`,
        ASK_RULE('plan'),
        task.type === 'tests'
          ? 'Si planificas, termina con el plan de tests: que comportamientos cubrir, casos limite y donde van los ficheros de test.'
          : 'Si planificas, termina con el plan final en texto, listo para que otro agente lo implemente.'
      ].join('\n\n');
    case 'diagnose':
      return [
        'Etapa de DIAGNOSTICO. No modifiques ficheros del repositorio.',
        `Bug a resolver:\n${goal}`,
        'Reproduce el fallo si es posible (tests, scripts, comandos), localiza la causa raiz con evidencias y termina con: 1) causa raiz, 2) ficheros y lineas implicados, 3) el arreglo minimo propuesto, 4) como comprobar que queda arreglado.',
        ASK_RULE('plan')
      ].join('\n\n');
    case 'implement':
      return [
        'Etapa de IMPLEMENTACION. Implementa el plan siguiente en este worktree.',
        `${task.type === 'bugfix' ? 'Diagnostico' : 'Plan'}:\n${previousOutput(task, 'implement') || goal}`,
        'Reporta el progreso con update_task_progress (fase "implement").',
        'Si te falta un dato para continuar, llama a update_task_progress con fase "implement" y estado "blocked", y termina tu respuesta con las preguntas concretas que necesitas que responda el usuario.',
        'No hagas git commit ni git push.'
      ].join('\n\n');
    case 'write-tests':
      return [
        'Etapa de TESTS. Escribe los tests del plan siguiente en este worktree, con el framework que ya usa el proyecto.',
        `Plan de tests:\n${out('plan') || goal}`,
        'Ejecuta los tests nuevos y comprueba que pasan (o que fallan por un bug real, explicandolo).',
        ASK_RULE('implement'),
        'No hagas git commit ni git push.'
      ].join('\n\n');
    case 'verify':
      return [
        'Etapa de VERIFICACION de los cambios de este worktree (git diff HEAD).',
        `Encargo original:\n${goal}`,
        'Ejecuta los tests, el lint y la compilacion que tenga el proyecto. Si algo falla por estos cambios y el arreglo es pequeno y evidente, arreglalo; si no, no lo toques y explica el fallo.',
        'No hagas git commit ni git push.',
        'Termina tu respuesta con una linea exactamente "VEREDICTO: OK" si todo pasa, o "VEREDICTO: FALLA" seguido del motivo.'
      ].join('\n\n');
    case 'review':
      return [
        'Etapa de REVISION FINAL. No modifiques ficheros.',
        'Revisa los cambios staged de este worktree (git diff --cached). Usa la skill code-review si esta disponible.',
        'Devuelve los hallazgos ordenados por gravedad, con fichero:linea, y un veredicto final: listo para ship o cambios necesarios.'
      ].join('\n\n');
    case 'commit':
      return [
        'Etapa de PREPARAR COMMIT. No ejecutes git add, git commit ni git push.',
        'Revisa los cambios staged (git diff --cached --stat) y devuelve: 1) el comando git add con los ficheros a incluir, 2) un mensaje de commit en formato conventional commits. No anadas lineas Co-Authored-By ni firmas de agente.'
      ].join('\n\n');
    case 'research':
      return [
        'Etapa de INVESTIGACION. No escribas ni modifiques documentos.',
        `Encargo de documentacion:\n${goal}`,
        ASK_RULE('plan'),
        'Si investigas, lee el repositorio y las fuentes necesarias. Devuelve notas estructuradas: hechos verificados (con fuente), huecos de informacion y ficheros existentes relacionados.'
      ].join('\n\n');
    case 'write':
      return buildWritePrompt(task, docOptions || task.docOptions || {}, out('research'));
    case 'audit':
      return [
        'Etapa de AUDITORIA. No modifiques ficheros.',
        `Alcance de la auditoria:\n${goal}`,
        ASK_RULE('test'),
        'Devuelve un informe con los hallazgos ordenados por gravedad (critica, alta, media, baja), cada uno con evidencia (fichero:linea), impacto y recomendacion concreta, y un resumen final.'
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
      plan: 'Continua la planificacion con esta respuesta y termina con el plan final.',
      research: 'Continua la investigacion con esta respuesta y termina con las notas estructuradas.',
      diagnose: 'Continua el diagnostico con esta respuesta y termina con la causa raiz y el arreglo propuesto.',
      implement: 'Continua la implementacion y termina cuando el cambio este completo.',
      'write-tests': 'Continua con los tests y termina cuando esten escritos y ejecutados.',
      audit: 'Continua la auditoria con esta respuesta y termina con el informe.'
    }[stage] || 'Continua y termina tu etapa.';
  return `Respuesta del usuario a tus preguntas:\n${answer.trim()}\n\n${tail}`;
}

// "VEREDICTO: OK" / "VEREDICTO: FALLA ..." al final de la verificacion.
function parseVerdict(text) {
  const m = /VEREDICTO:\s*(OK|FALLA)\b[^\n]*/i.exec(text || '');
  if (!m) return null;
  return { ok: m[1].toUpperCase() === 'OK', line: m[0].trim() };
}

/**
 * Decide el estado de la tarea tras terminar una etapa.
 * outcome: { text, hasChanges, phaseStatus, isError, skip, agent }
 * Devuelve { patch, next }: patch se aplica a la tarea; next es la etapa que
 * debe lanzarse a continuacion automaticamente (o null).
 */
function decideAfterStage(
  task,
  stage,
  { text = '', hasChanges = false, phaseStatus, isError = false, skip = [], agent } = {}
) {
  const stageOutputs = { ...(task.stageOutputs || {}), [stage]: text };
  const base = { stage, stageOutputs, output: text, pendingQuestion: null, pendingPermission: null, error: null };
  const done = (patch, next = null) => ({ patch: { ...base, ...patch }, next });
  const following = nextStage(task.type, stage, { skip });
  const reportOnly = Boolean(TASK_TYPES[task.type]?.reportOnly);

  // La revision y el commit no tocan el estado de los cambios: un fallo solo
  // se muestra, la tarea sigue lista para revisar.
  if (stage === 'review' || stage === 'commit') {
    return done({ status: 'ready_to_test', error: isError ? 'la etapa termino con error' : null });
  }
  if (isError) return done({ status: 'pending', error: 'la etapa termino con error; puedes reintentarla' });
  if (QUESTION_KIND[stage] && phaseStatus === 'blocked') {
    return done({
      status: 'awaiting_input',
      pendingQuestion: { kind: QUESTION_KIND[stage], text: text || 'El agente necesita mas detalles para continuar.' }
    });
  }

  const access = stageAccess(stage, agent);
  if (stage === 'research') {
    if (!text.trim()) return done({ status: 'pending', error: 'la investigacion no devolvio texto' });
    return done({
      status: 'awaiting_input',
      pendingQuestion: {
        kind: 'doc-options',
        text: 'Investigacion lista. Elige el modo de salida, el formato y el destino.'
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
    // Etapas que solo preparan texto para la siguiente (plan, diagnostico) o agentes propios de lectura.
    if (!text.trim()) {
      const what = { plan: 'la planificacion', diagnose: 'el diagnostico' }[stage] || 'la etapa';
      return done({ status: 'pending', error: `${what} no devolvio texto` });
    }
    if (following) return done({ status: 'pending' }, following);
    return done({ status: 'ready_to_test', reportOnly: !hasChanges });
  }
  // Etapas que editan: sin cambios no hay nada que revisar.
  if (!hasChanges) return done({ status: 'pending', error: 'no se detectaron cambios en el worktree' });
  if (following) return done({ status: 'pending' }, following);
  return done({ status: 'ready_to_test' });
}

module.exports = {
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
