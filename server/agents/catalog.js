'use strict';

const { eccAgents } = require('../ecc/library');

const fs = require('fs');
const path = require('path');
const { configDir } = require('../store/globalPaths');

// Agent catalog. An agent is a role with its own engine and model:
//   id, name, description, engine (claude | local), model, effort, access (read | edit),
//   enabled, and a role prompt (the body of the .md).
// Three sources, from lowest to highest priority:
//   builtin  default agents, defined in this file (restorable)
//   global   ~/.config/optimia/agents/<id>.md       (every project)
//   project  <project>/.optimia/agents/<id>.md       (that project only)
// A global or project file with a default agent's id overrides it field by field; a new id creates
// a custom agent.

const ENGINES = ['claude', 'local'];
const ACCESS = ['read', 'edit'];
// --effort levels of the claude CLI (2.1.x: low, medium, high, xhigh, max).
const EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
// Model aliases the claude CLI understands; 'default' = the account's default model.
const CLAUDE_MODELS = ['default', 'opus', 'sonnet', 'haiku', 'fable'];
const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const FIELDS = ['name', 'description', 'engine', 'model', 'effort', 'access', 'enabled'];

const BUILTIN_AGENTS = [
  {
    id: 'planner',
    name: 'Planificador',
    description: 'Entiende el encargo, lee el código y cierra un plan concreto para otro agente.',
    engine: 'claude',
    model: 'opus',
    effort: 'high',
    access: 'read',
    prompt:
      'Eres el Planificador. Tu trabajo es entender el encargo a fondo, leer el código relevante y producir un plan concreto: ficheros a tocar, cambios en cada uno, riesgos y cómo verificarlo. Prefiere reutilizar lo que ya existe antes que crear código nuevo.'
  },
  {
    id: 'implementer',
    name: 'Implementador',
    description: 'Implementa el plan en el worktree de la tarea, siguiendo el estilo del proyecto.',
    engine: 'claude',
    model: 'sonnet',
    effort: 'high',
    access: 'edit',
    prompt:
      'Eres el Implementador. Aplica el plan con cambios pequenos y coherentes con el estilo del proyecto. No anadas funcionalidad que no se pidio. Si un paso del plan es incorrecto, corrigelo y explica por que.'
  },
  {
    id: 'verifier',
    name: 'Verificador',
    description: 'Ejecuta tests, lint y build; arregla fallos pequeños y da un veredicto.',
    engine: 'claude',
    model: 'sonnet',
    effort: 'medium',
    access: 'edit',
    prompt:
      'Eres el Verificador. Descubre como se prueba este proyecto (package.json, Makefile, CI) y ejecuta los tests, el lint y la compilacion que existan. Si algo falla por el cambio de esta tarea y el arreglo es pequeno y evidente, arreglalo. No cambies tests para que pasen sin motivo.'
  },
  {
    id: 'reviewer',
    name: 'Revisor',
    description: 'Revisa los cambios antes de hacer commit: errores reales, seguridad y riesgos, sin ruido.',
    engine: 'claude',
    model: 'opus',
    effort: 'high',
    access: 'read',
    prompt:
      'Eres el Revisor. Busca errores reales (lógica, casos límite, seguridad, rendimiento) antes que cuestiones de estilo. Cada hallazgo con fichero:línea, gravedad y cómo arreglarlo.'
  },
  {
    id: 'committer',
    name: 'Redactor de commits',
    description: 'Propone qué ficheros incluir y un mensaje en Conventional Commits.',
    engine: 'claude',
    model: 'haiku',
    effort: 'low',
    access: 'read',
    prompt:
      'Eres el Redactor de commits. Escribe mensajes en Conventional Commits (tipo(ambito): resumen en imperativo), con un cuerpo breve que explique el porque cuando aporte. Nunca añadas firmas de IA ni trailers Co-Authored-By.'
  },
  {
    id: 'pr-writer',
    name: 'Redactor de PR y Jira',
    description: 'Redacta la descripción de la pull request o el comentario para Jira a partir de la tarea.',
    engine: 'claude',
    model: 'sonnet',
    effort: 'low',
    access: 'read',
    prompt:
      'Eres el Redactor de PR y Jira. Escribes para el lector concreto: quien revisa el código en la PR, quien sigue el ticket en Jira. Claro, breve y sin relleno; nunca inventes cambios que no estén en el diff.'
  },
  {
    id: 'wiki-keeper',
    name: 'Bibliotecario',
    description:
      'Mantiene la wiki del proyecto (y la personal) al día tras cada tarea. Usa el modelo local si hay uno; si no, este modelo de Claude.',
    engine: 'claude',
    model: 'haiku',
    effort: 'low',
    access: 'read',
    prompt:
      'Eres el Bibliotecario. Conviertes el trabajo de cada tarea en conocimiento duradero y fácil de encontrar: páginas cortas, bien enlazadas, sin duplicados, con la fuente citada. Mejor actualizar una página existente que crear otra.'
  },
  {
    id: 'researcher',
    name: 'Investigador',
    description: 'Reúne hechos verificados y huecos de información antes de redactar documentación.',
    engine: 'claude',
    model: 'sonnet',
    effort: 'medium',
    access: 'read',
    prompt:
      'Eres el Investigador. Distingue siempre entre hechos verificados (con su fuente: fichero o URL) y suposiciones. Senala lo que falta por saber.'
  },
  {
    id: 'doc-writer',
    name: 'Redactor de documentación',
    description: 'Redacta o edita documentos a partir de la investigación previa.',
    engine: 'claude',
    model: 'sonnet',
    effort: 'medium',
    access: 'edit',
    prompt:
      'Eres el Redactor de documentación. Escribe claro y directo, para el lector que lo va a usar. Respeta el tono y la estructura de la documentación existente.'
  },
  {
    id: 'debugger',
    name: 'Depurador',
    description: 'Reproduce un bug, encuentra la causa raíz y propone el arreglo mínimo.',
    engine: 'claude',
    model: 'opus',
    effort: 'high',
    access: 'read',
    prompt:
      'Eres el Depurador. Reproduce el fallo antes de teorizar, aisla la causa raíz con evidencias (trazas, comandos, líneas de código) y propone el arreglo mínimo que lo corrige sin efectos secundarios.'
  },
  {
    id: 'test-writer',
    name: 'Escritor de tests',
    description: 'Escribe tests que cubren el comportamiento pedido, con el framework del proyecto.',
    engine: 'claude',
    model: 'sonnet',
    effort: 'medium',
    access: 'edit',
    prompt:
      'Eres el Escritor de tests. Usa el framework y las convenciones de tests que ya tiene el proyecto. Prueba comportamiento observable, incluidos los casos límite y de error, no detalles de implementación.'
  },
  {
    id: 'auditor',
    name: 'Auditor',
    description: 'Audita el código (seguridad, rendimiento, calidad) y entrega un informe sin tocar nada.',
    engine: 'claude',
    model: 'opus',
    effort: 'high',
    access: 'read',
    prompt:
      'Eres el Auditor. Analiza el alcance pedido buscando problemas de seguridad, rendimiento, fiabilidad y mantenibilidad. Ordena los hallazgos por gravedad, con evidencia (fichero:línea) y recomendación concreta. No modifiques nada.'
  }
];

// optimia's agents follow the method of their best ECC counterpart (MIT, vendor/ecc): the agent
// keeps its id, name, stage and access, and its prompt is its own role plus that method. Without the
// bundle, the short prompt alone.
const ECC_METHOD = {
  planner: ['ecc-planner', 'ecc-architect'],
  verifier: ['ecc-build-error-resolver'],
  reviewer: ['ecc-code-reviewer'],
  committer: ['ecc-commit-reviewer'],
  researcher: ['ecc-code-explorer'],
  'doc-writer': ['ecc-doc-updater'],
  'test-writer': ['ecc-tdd-guide'],
  auditor: ['ecc-security-reviewer', 'ecc-performance-optimizer']
};
const methodCache = new Map();
function withEccMethod(id, own) {
  if (methodCache.has(id)) return methodCache.get(id);
  const methods = (ECC_METHOD[id] || []).map((eid) => eccAgents().find((a) => a.id === eid)).filter(Boolean);
  const prompt = methods.length
    ? [
        own,
        'Responde en el idioma del usuario. Las instrucciones de la etapa de optimia mandan sobre este método (por ejemplo, no hagas commit ni push, y respeta el acceso de tu etapa).',
        ...methods.map((m) => `## Método: ${m.name.replace(' (ECC)', '')} (de ECC, licencia MIT)\n\n${m.prompt}`)
      ].join('\n\n')
    : own;
  methodCache.set(id, prompt);
  return prompt;
}

// Base definition of an agent: optimia's own (with its ECC method) or one from the ECC library.
function baseAgent(id) {
  const own = BUILTIN_AGENTS.find((a) => a.id === id);
  if (own) return { ...own, prompt: withEccMethod(id, own.prompt) };
  return eccAgents().find((a) => a.id === id) || null;
}

function globalAgentsDir() {
  return path.join(configDir(), 'agents');
}

function projectAgentsDir(projectRoot) {
  return path.join(projectRoot, '.optimia', 'agents');
}

function dirFor(scope, projectRoot) {
  if (scope === 'global') return globalAgentsDir();
  if (scope === 'project') return projectAgentsDir(projectRoot);
  throw new Error('scope debe ser "global" o "project"');
}

// Minimal frontmatter: "key: value" lines between two "---". No YAML dependency.
function parseAgentFile(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { fields: {}, prompt: text.trim() };
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if (/^".*"$/.test(value)) {
      try {
        value = JSON.parse(value);
      } catch {
        /* kept as text */
      }
    }
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    fields[key] = value;
  }
  return { fields, prompt: m[2].trim() };
}

function serializeAgent(agent) {
  const lines = ['---'];
  for (const key of FIELDS) {
    if (agent[key] === undefined) continue;
    const v = agent[key];
    lines.push(`${key}: ${typeof v === 'string' && /[:#"\n]|^\s|\s$/.test(v) ? JSON.stringify(v) : v}`);
  }
  lines.push('---', '');
  if (agent.prompt) lines.push(agent.prompt.trim(), '');
  return lines.join('\n');
}

function readDir(dir) {
  const out = new Map();
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.md'));
  } catch {
    return out;
  }
  for (const name of names) {
    const id = name.slice(0, -3);
    if (!ID_RE.test(id)) continue;
    try {
      const { fields, prompt } = parseAgentFile(fs.readFileSync(path.join(dir, name), 'utf8'));
      out.set(id, { ...fields, ...(prompt ? { prompt } : {}) });
    } catch {
      /* unreadable file: ignored */
    }
  }
  return out;
}

function normalize(agent) {
  const a = { ...agent };
  if (!ENGINES.includes(a.engine)) a.engine = 'claude';
  if (!ACCESS.includes(a.access)) a.access = 'read';
  if (!EFFORTS.includes(a.effort)) a.effort = 'default';
  if (typeof a.model !== 'string' || !a.model.trim()) a.model = a.engine === 'claude' ? 'default' : '';
  a.enabled = a.enabled !== false;
  a.name = typeof a.name === 'string' && a.name.trim() ? a.name.trim() : a.id;
  a.description = typeof a.description === 'string' ? a.description : '';
  a.prompt = typeof a.prompt === 'string' ? a.prompt : '';
  return a;
}

/**
 * Effective agents for a project, already merged. Each one tells where it comes from (`source`) and
 * in which scopes it has its own settings (`overriddenIn`).
 */
function loadAgents(projectRoot) {
  const global = readDir(globalAgentsDir());
  const project = projectRoot ? readDir(projectAgentsDir(projectRoot)) : new Map();
  const ids = new Set([
    ...BUILTIN_AGENTS.map((a) => a.id),
    ...eccAgents().map((a) => a.id),
    ...global.keys(),
    ...project.keys()
  ]);
  const agents = [];
  for (const id of ids) {
    const base = baseAgent(id);
    const overriddenIn = [global.has(id) && 'global', project.has(id) && 'project'].filter(Boolean);
    const merged = { ...(base || {}), ...(global.get(id) || {}), ...(project.get(id) || {}), id };
    const source = base?.library === 'ecc' ? 'ecc' : base ? 'builtin' : project.has(id) ? 'project' : 'global';
    agents.push({ ...normalize(merged), builtin: Boolean(base), source, overriddenIn });
  }
  return agents;
}

function getAgent(projectRoot, id) {
  return loadAgents(projectRoot).find((a) => a.id === id) || null;
}

function validateAgentInput(input, { isNew }) {
  if (input.engine !== undefined && !ENGINES.includes(input.engine)) return 'motor no válido (claude o local)';
  if (input.access !== undefined && !ACCESS.includes(input.access)) return 'acceso no válido (read o edit)';
  if (input.effort !== undefined && !EFFORTS.includes(input.effort)) return 'effort no válido';
  if (input.model !== undefined && (typeof input.model !== 'string' || input.model.length > 100))
    return 'modelo no válido';
  if (
    input.engine === 'claude' &&
    input.model &&
    !CLAUDE_MODELS.includes(input.model) &&
    !/^claude-[a-z0-9.-]+$/.test(input.model)
  ) {
    return `modelo de Claude no válido: usa ${CLAUDE_MODELS.join(', ')} o un id claude-...`;
  }
  if (isNew && (typeof input.name !== 'string' || !input.name.trim())) return 'el agente necesita un nombre';
  if (input.name !== undefined && String(input.name).length > 60) return 'nombre demasiado largo';
  if (input.prompt !== undefined && String(input.prompt).length > 20000) return 'prompt demasiado largo';
  return null;
}

function slugify(name) {
  return String(name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** Saves the given agent fields in a scope (merged with whatever was already there). */
function saveAgent(projectRoot, scope, id, input) {
  if (!ID_RE.test(id)) throw new Error('id de agente no válido');
  const exists = Boolean(baseAgent(id)) || loadAgents(projectRoot).some((a) => a.id === id);
  const problem = validateAgentInput(input, { isNew: !exists });
  if (problem) throw new Error(problem);
  const dir = dirFor(scope, projectRoot);
  const file = path.join(dir, `${id}.md`);
  const current = fs.existsSync(file)
    ? (() => {
        const { fields, prompt } = parseAgentFile(fs.readFileSync(file, 'utf8'));
        return { ...fields, prompt };
      })()
    : {};
  const next = { ...current };
  for (const key of [...FIELDS, 'prompt']) if (input[key] !== undefined) next[key] = input[key];
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, serializeAgent(next));
  return getAgent(projectRoot, id);
}

/** Creates a custom agent and returns the effective agent. */
function createAgent(projectRoot, scope, input) {
  let id = typeof input.id === 'string' && input.id ? input.id : slugify(input.name || '');
  if (!ID_RE.test(id)) throw new Error('el nombre necesita al menos dos letras o numeros');
  const taken = new Set(loadAgents(projectRoot).map((a) => a.id));
  if (taken.has(id)) {
    let n = 2;
    while (taken.has(`${id}-${n}`)) n++;
    id = `${id}-${n}`;
  }
  return saveAgent(projectRoot, scope, id, {
    engine: 'claude',
    model: 'default',
    effort: 'default',
    access: 'read',
    ...input
  });
}

/** Removes an agent's settings in a scope: restores the default one or deletes a custom agent. */
function removeAgent(projectRoot, scope, id) {
  if (!ID_RE.test(id)) throw new Error('id de agente no válido');
  const file = path.join(dirFor(scope, projectRoot), `${id}.md`);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

module.exports = {
  BUILTIN_AGENTS,
  CLAUDE_MODELS,
  ENGINES,
  ACCESS,
  EFFORTS,
  parseAgentFile,
  serializeAgent,
  loadAgents,
  getAgent,
  saveAgent,
  createAgent,
  removeAgent,
  globalAgentsDir,
  projectAgentsDir,
  slugify
};
