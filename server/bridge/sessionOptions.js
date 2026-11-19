'use strict';

const fs = require('fs');
const path = require('path');
const { loadMemory } = require('../store/memoryStore');
const { prepareActiveDir } = require('../ecc/library');
const { pstackPrinciple } = require('../skills/library');
const { engineOverride } = require('../ai/fallback');
const wiki = require('../knowledge/wikiStore');
const { optimiaClaudeSettingsPath, agentClaudeSettingsPath, syncClaudeSettings } = require('./claudeSettingsSync');

const CHAT_TASKS_PROMPT = `## Crear tareas para agentes
Dispones de la tool MCP "create_task". Usala solo despues de cerrar un plan concreto con el
usuario (por ejemplo tras usar la skill plan-optimizer), nunca para un pedido vago o a mitad de
una exploracion. Cada tarea creada arranca un agente independiente en su propio worktree; dale una
instruccion autocontenida (el agente no vera el resto de esta conversacion).`;

// For every session: fewer round trips, so tasks take less time.
const WORK_PACE_PROMPT = `## Ritmo de trabajo
Lee en paralelo (en un mismo turno) todos los ficheros y búsquedas que necesites. Cuando ya sepas qué
cambiar, haz todos los cambios seguidos: lanza en el mismo turno todas las ediciones independientes
(varias llamadas a herramientas a la vez), sin releer ni comentar entre una y otra. Comprueba el
resultado una sola vez al final (tests, build o lint), no tras cada edición.`;

function taskProgressPrompt(taskId) {
  return `## Reportar progreso de esta tarea
Esta sesion corresponde a la tarea con id "${taskId}". Dispones de la tool MCP "update_task_progress"
para reportar el avance real en el panel de agentes del usuario, en sus 3 fases: "plan" (al entender
el encargo y antes de tocar codigo), "implement" (mientras editas) y "test" (verificacion final).
Llama a la tool con ese taskId al EMPEZAR cada fase (status "active") y al TERMINARLA (status "done"),
o "blocked" si no puedes continuar. No esperes al final para reportar todo de golpe.`;
}

/**
 * Builds ClaudeSession constructor options from settings, for a given
 * working directory (the main project root for the chat panel, or a task's
 * worktree directory for a dedicated task session). Shared so both paths
 * apply the same local-AI aliasing (see Fase 4) and the same Instructions +
 * Memory system prompt (see Fase 8) — Memory is always read from the main
 * projectRoot's .optimia/memory.md, even for a task session running in a
 * worktree, since memory is project-wide, not per-worktree.
 *
 * `taskId`: pass it for a task's own session so it can self-report progress
 * via update_task_progress without having to carry its own id around; leave
 * it undefined for the main chat session, which instead gets create_task.
 */
function localDefaults(ai) {
  return {
    baseUrl: ai.localAi.url || undefined,
    authHeader: ai.localAi.authHeader || undefined
  };
}

/**
 * `agent` (optional): the catalog agent that runs this session (see server/agents/catalog.js). When
 * given, its engine, model, effort and role prompt win over the general AI settings, which are left
 * for the chat.
 *
 * Local models (Ollama, LM Studio): the current claude CLI (verified with 2.1.x) sends the model
 * name as is to ANTHROPIC_BASE_URL ("qwen2.5-coder:7b", "google/gemma-4-12b"), so each agent can use
 * a different local model at the same time. See localAi.js for the environment of those sessions.
 */
/**
 * The engine a session runs on. While Claude is out of usage (see ai/fallback.js), the local model
 * takes the place of Claude for the sessions that would use it.
 */
function engineFor(settings, agent) {
  const wanted = agent ? agent.engine : settings.ai.mode === 'local' ? 'local' : 'claude';
  if (wanted !== 'claude') return wanted;
  const override = engineOverride(settings);
  return override || 'claude';
}

/**
 * The pstack principles of an agent (Lauren Tan, MIT; vendor/pstack/principles), with the rule that
 * makes them visible in its report. Off for every agent with Settings › Agents, or for one agent with
 * an empty list.
 */
function principlesPrompt(settings, agent) {
  if (!agent || settings.principles?.enabled === false) return '';
  const texts = (agent.principles || []).map((name) => pstackPrinciple(name)).filter(Boolean);
  if (!texts.length) return '';
  return [
    '## Principios de ingeniería (de pstack, Lauren Tan, licencia MIT)',
    'Aplica los que correspondan a tu trabajo. En tu informe, nombra cada principio que cambió una decisión y qué decisión cambió; no cites los que no aplicaste.',
    ...texts.map((t) => t.replace(/^# /, '### '))
  ].join('\n\n');
}

function buildSessionOptions(settings, cwd, projectRoot = cwd, taskId, agent) {
  const ai = settings.ai;
  const opts = { projectRoot: cwd };

  const mcpConfigPath = path.join(projectRoot, '.optimia', 'mcp.json');
  if (fs.existsSync(mcpConfigPath)) opts.mcpConfigPath = mcpConfigPath;
  // optimia's permissions (the global + repo "Prohibido" list), without writing to the repo.
  // Regenerated on every session: a global change reaches every repo.
  if (Array.isArray(settings.preferences?.noGo)) syncClaudeSettings(projectRoot, settings.preferences.noGo);
  const settingsPath = taskId ? agentClaudeSettingsPath(projectRoot) : optimiaClaudeSettingsPath(projectRoot);
  if (fs.existsSync(settingsPath)) opts.settingsPath = settingsPath;
  if (taskId) {
    // A task does not inherit the user's claude.ai connectors, only optimia's MCP server and the
    // repo's .mcp.json (see claudeProcess.js).
    opts.strictMcpConfig = true;
    const projectMcp = path.join(cwd, '.mcp.json');
    if (fs.existsSync(projectMcp)) opts.extraMcpConfigPaths = [projectMcp];
  }

  // optimia's built-in skills plus the ECC skills and commands the user enabled (copied to a folder
  // Claude Code reads with --add-dir).
  try {
    const eccDir = prepareActiveDir(settings.ecc || {});
    if (eccDir) opts.addDirs = [eccDir];
  } catch {
    /* without them */
  }

  const parts = [];
  if (agent?.prompt) parts.push(`## Tu rol: ${agent.name}\n${agent.prompt}`);
  const principles = principlesPrompt(settings, agent);
  if (principles) parts.push(principles);
  parts.push(WORK_PACE_PROMPT);
  // Workflow instructions shared by all repos and then this repo's (which win if they contradict
  // the shared ones).
  const prefs = settings.preferences || {};
  if (prefs.globalInstructions !== undefined || prefs.projectInstructions !== undefined) {
    if (prefs.globalInstructions) parts.push(`## Instrucciones para todos los repos\n${prefs.globalInstructions}`);
    if (prefs.projectInstructions)
      parts.push(`## Instrucciones de este repo (mandan sobre las anteriores)\n${prefs.projectInstructions}`);
  } else if (prefs.instructions) {
    parts.push(prefs.instructions);
  }
  const memory = loadMemory(projectRoot);
  if (memory.trim()) parts.push(`## Memoria del proyecto\n${memory}`);
  // The wikis: only where they are (read on demand with Read/Grep), not their content.
  try {
    const projectWiki = wiki.ensureWiki(wiki.wikiFor('project', projectRoot), projectRoot);
    const personalWiki = wiki.ensureWiki(wiki.wikiFor('personal'));
    opts.addDirs = [...(opts.addDirs || []), wiki.wikisDir()];
    parts.push(
      `## Wikis\nLa wiki de este proyecto está en ${projectWiki.dir} y la wiki personal del usuario en ${personalWiki.dir} (index.md es la portada de cada una; las páginas se enlazan con [[Página]]). Consúltalas con Read o Grep cuando necesites contexto (decisiones, guías, cómo funciona algo) antes de redescubrirlo; no las cargues enteras.`
    );
  } catch {
    /* without wikis */
  }
  if (opts.mcpConfigPath) parts.push(taskId ? taskProgressPrompt(taskId) : CHAT_TASKS_PROMPT);
  if (parts.length) opts.systemPrompt = parts.join('\n\n');

  const engine = engineFor(settings, agent);
  opts.engine = engine;
  if (engine === 'local') {
    Object.assign(opts, localDefaults(ai));
    if (!opts.baseUrl) {
      throw new Error(
        `${agent ? `el agente "${agent.name}" usa un modelo local, pero` : 'el chat usa IA local, pero'} no hay servidor configurado: abre Ajustes › IA local y pulsa «Detectar servidores locales»`
      );
    }
    // An agent that runs on the local model only because Claude is out keeps no Claude model name.
    const model = (agent?.engine === 'local' ? agent.model : '') || ai.localAi.model;
    if (!model) throw new Error('elige un modelo local para este agente o en Ajustes > IA local');
    opts.model = model;
  } else {
    const model = agent ? agent.model : ai.claude.model;
    const effort = agent ? agent.effort : ai.claude.effort;
    opts.model = model && model !== 'default' ? model : undefined;
    opts.effort = effort && effort !== 'default' ? effort : undefined;
  }
  return opts;
}

module.exports = { buildSessionOptions, engineFor, principlesPrompt };
