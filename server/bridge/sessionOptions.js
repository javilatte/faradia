'use strict';

const fs = require('fs');
const path = require('path');
const { loadMemory } = require('../store/memoryStore');
const { optimiaClaudeSettingsPath, agentClaudeSettingsPath, syncClaudeSettings } = require('./claudeSettingsSync');

const CHAT_TASKS_PROMPT = `## Crear tareas para agentes
Dispones de la tool MCP "create_task". Usala solo despues de cerrar un plan concreto con el
usuario (por ejemplo tras usar la skill plan-optimizer), nunca para un pedido vago o a mitad de
una exploracion. Cada tarea creada arranca un agente independiente en su propio worktree; dale una
instruccion autocontenida (el agente no vera el resto de esta conversacion).`;

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
 * `agent` (opcional): el agente del catalogo que ejecuta esta sesion (ver
 * server/agents/catalog.js). Si se pasa, su motor, modelo, effort y prompt de rol
 * mandan sobre los ajustes generales de IA, que quedan para el chat.
 *
 * Modelos locales: el CLI de claude actual (verificado con 2.1.x) envia a
 * ANTHROPIC_BASE_URL el nombre de modelo tal cual, tambien nombres de Ollama como
 * "qwen2.5-coder:7b", asi que ya no hace falta el alias de ensureOllamaAlias y
 * cada agente puede usar un modelo local distinto a la vez.
 */
function buildSessionOptions(settings, cwd, projectRoot = cwd, taskId, agent) {
  const ai = settings.ai;
  const opts = { projectRoot: cwd };

  const mcpConfigPath = path.join(projectRoot, '.optimia', 'mcp.json');
  if (fs.existsSync(mcpConfigPath)) opts.mcpConfigPath = mcpConfigPath;
  // Permisos de optimia (lista "Prohibido" global + del repo), sin escribir en el
  // repo. Se regeneran en cada sesión: un cambio global llega a todos los repos.
  if (Array.isArray(settings.preferences?.noGo)) syncClaudeSettings(projectRoot, settings.preferences.noGo);
  const settingsPath = taskId ? agentClaudeSettingsPath(projectRoot) : optimiaClaudeSettingsPath(projectRoot);
  if (fs.existsSync(settingsPath)) opts.settingsPath = settingsPath;
  if (taskId) {
    // Una tarea no hereda los conectores de claude.ai del usuario, solo el MCP de
    // optimia y el .mcp.json del repo (ver claudeProcess.js).
    opts.strictMcpConfig = true;
    const projectMcp = path.join(cwd, '.mcp.json');
    if (fs.existsSync(projectMcp)) opts.extraMcpConfigPaths = [projectMcp];
  }

  const parts = [];
  if (agent?.prompt) parts.push(`## Tu rol: ${agent.name}\n${agent.prompt}`);
  // Instrucciones de flujo de trabajo comunes a todos los repos y, después, las de
  // este repo (que mandan si contradicen a las comunes).
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
  if (opts.mcpConfigPath) parts.push(taskId ? taskProgressPrompt(taskId) : CHAT_TASKS_PROMPT);
  if (parts.length) opts.systemPrompt = parts.join('\n\n');

  const engine = agent ? agent.engine : ai.mode === 'local' ? 'local' : 'claude';
  if (engine === 'local') {
    Object.assign(opts, localDefaults(ai));
    if (!opts.baseUrl) throw new Error('configura la URL de la IA local en Ajustes > IA local');
    const model = (agent ? agent.model : '') || ai.localAi.model;
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

module.exports = { buildSessionOptions };
