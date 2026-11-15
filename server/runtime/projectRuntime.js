'use strict';

// Estado vivo de un proyecto: sesiones de chat y de tareas, la terminal y la API
// HTTP del proyecto. El servidor crea un runtime por proyecto abierto (ver
// server/index.js) y le pasa sendToClients para emitir por el WebSocket comun.

const fs = require('fs');
const path = require('path');
const { loadSettings, loadProjectLayer, saveProjectSettings } = require('../store/settingsStore');
const { loadTasks, updateTask, updateTaskPhase } = require('../store/taskStore');
const { loadChat, updateChatMeta, appendMessage } = require('../store/chatStore');
const { ClaudeSession } = require('../bridge/claudeProcess');
const { PtySession } = require('../bridge/ptySession');
const { buildSessionOptions } = require('../bridge/sessionOptions');
const { resolveStageAgent, skippedStages } = require('../agents/stageMap');
const { createTaskWorktree, stageForReview, changedFiles, ignoredAmong } = require('../bridge/worktree');
const logger = require('../bridge/logger');

const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write']);
// Texto de preguntas y respuestas que se guarda en el registro, recortado.
const cut = (text, n = 500) => (typeof text !== 'string' ? null : text.length > n ? `${text.slice(0, n)}…` : text);
// Ruta relativa a la base del proyecto o del worktree, para que el registro no
// dependa de la carpeta donde está el repo del usuario.
function relPath(base, p) {
  if (typeof p !== 'string' || !p) return null;
  return path.isAbsolute(p) ? path.relative(base, p) : p;
}
const { ensureGitGuardHooks } = require('../bridge/gitGuard');
const { syncClaudeSettings, optimiaClaudeSettingsPath } = require('../bridge/claudeSettingsSync');
const { listFilesModifiedSince } = require('../bridge/taskFiles');
const {
  STAGE_PHASE,
  firstStage,
  stageTools,
  stageDisallowed,
  approvalRule,
  canRun,
  buildStagePrompt,
  answerPrompt,
  decideAfterStage,
  defaultCommitMessage
} = require('../bridge/taskStages');
const { createApp } = require('./projectApp');

// Escrito al abrir el proyecto: --mcp-config necesita este fichero antes de que
// arranque cualquier sesion, para que create_task y update_task_progress lleguen
// de vuelta al servidor por HTTP (el servidor MCP es hijo de `claude`, no de
// optimia; ver server/mcp/tasksServer.js).
function writeMcpConfig(projectRoot, { port, projectId, token }) {
  const dir = path.join(projectRoot, '.optimia');
  fs.mkdirSync(dir, { recursive: true });
  const env = { OPTIMIA_PORT: String(port), OPTIMIA_PROJECT: projectId };
  if (token) env.OPTIMIA_TOKEN = token;
  const config = {
    mcpServers: {
      'optimia-tasks': {
        // El mismo node que ejecuta optimia: con nvm u otros gestores, "node" puede
        // no estar en el PATH del proceso de claude y el MCP no arrancaria.
        command: process.execPath,
        args: [path.join(__dirname, '..', 'mcp', 'tasksServer.js')],
        env
      }
    }
  };
  fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

// La carpeta .optimia de un repo abierto desde un workbench no debe aparecer como
// cambio en git. Se excluye en .git/info/exclude (local, no versionado) en vez de
// tocar el .gitignore del usuario. Si ya la ignora, no se hace nada.
function ensureOptimiaExcluded(projectRoot) {
  const gitDir = path.join(projectRoot, '.git');
  try {
    if (!fs.statSync(gitDir).isDirectory()) return; // worktree o submodulo: .git es un fichero
    const gitignore = path.join(projectRoot, '.gitignore');
    const ignored = fs.existsSync(gitignore) && /^\/?\.optimia\/?$/m.test(fs.readFileSync(gitignore, 'utf8'));
    if (ignored) return;
    const exclude = path.join(gitDir, 'info', 'exclude');
    const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    if (/^\/?\.optimia\/?$/m.test(current)) return;
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}/.optimia\n`);
  } catch {
    /* no es un repo git o no se puede escribir: nada que excluir */
  }
}

// Denegaciones por politica que se toleran en una etapa antes de pararla.
const MAX_POLICY_DENIALS = 5;

// Cierra la ultima ejecucion de `stage` en stageRuns con un estado.
function closeLastRun(task, stage, status) {
  const runs = [...(task?.stageRuns || [])];
  const last = runs[runs.length - 1];
  if (last && last.stage === stage && !last.finishedAt) {
    runs[runs.length - 1] = { ...last, finishedAt: new Date().toISOString(), status };
  }
  return runs;
}

function createProjectRuntime({ projectId, projectRoot, port, token, sendToClients }) {
  ensureOptimiaExcluded(projectRoot);
  // Permisos de las sesiones de optimia, pasados con --settings (nada en el repo).
  syncClaudeSettings(projectRoot, loadSettings(projectRoot).preferences.noGo);
  const log = logger.createLogger(projectRoot);
  writeMcpConfig(projectRoot, { port, projectId, token });
  // Both task and chat sessions are project-wide (one ClaudeSession per
  // task/chat, independent of which browser tab is open or whether any tab
  // is open at all) — closing or refreshing a WebSocket no longer kills the
  // underlying `claude` process; only the transcript viewer disconnects.
  const taskSessions = new Map(); // taskId -> ClaudeSession
  const chatSessions = new Map(); // chatId -> ClaudeSession
  let terminalSession = null; // one project-wide PtySession, independent of chat/task sessions
  let terminalOwner = null; // { scope, id } when the terminal is running because a chat/task was handed off to it

  // Todo lo que se emite lleva el id del proyecto: un mismo navegador ve varios.
  const broadcast = (payload) => sendToClients({ ...payload, projectId });

  // Called from both the task and chat event handlers below. The moment a
  // tool is denied, the headless session is no use for the rest of this turn
  // (--permission-prompts none means every further approval-requiring call
  // will deny too, see claude's own message to the user), so hand off right
  // away instead of waiting for the turn to finish — killing it here (not
  // after `result`) is what makes the handoff immediate, and since the old
  // process is dead before the terminal's is spawned, the same
  // "no dual-driving one session" rule from before still holds.
  function watchForPermissionHandoff(scope, id, session, sessionsMap, event) {
    if (event.type !== 'system' || event.subtype !== 'permission_denied') return;
    broadcast({ type: 'permission_needed', scope, id, toolName: event.tool_name, message: event.message });
    // Flagged so the session's own 'exit' handler (below) knows this kill is
    // an intentional handoff, not a real/unexpected end — without this, the
    // generic claude_exit broadcast races with terminal_handoff and the chat
    // shows a confusing "session ended" message right on top of the handoff.
    session._handoffInProgress = true;
    log.warn('handoff.terminal', { scope, id, tool: event.tool_name });
    session.kill();
    sessionsMap.delete(id);
    startOrGetTerminalSession(session.sessionId, { scope, id });
    broadcast({ type: 'terminal_handoff', scope, id, toolName: event.tool_name });
  }

  // Lanza una etapa del pipeline de la tarea (ver bridge/taskStages.js) en su
  // worktree. Una sesion de Claude por etapa; al terminar, la etapa decide el
  // siguiente estado y, si toca, lanza la siguiente etapa automaticamente.
  // Devuelve { task } o { error, code } para que la ruta HTTP responda.
  function runTaskStage(taskId, { stage, answer, docOptions } = {}) {
    const task = loadTasks(projectRoot).find((t) => t.id === taskId);
    if (!task) return { error: 'task not found', code: 404 };
    if (taskSessions.has(taskId)) return { error: 'la tarea ya tiene un agente en marcha', code: 409 };

    const effectiveDocOptions = stage === 'write' ? docOptions || task.docOptions : undefined;
    const problem = canRun(task, stage, { answer, docOptions: effectiveDocOptions });
    if (problem) return { error: problem, code: 409 };

    let worktreeDir = task.worktreePath;
    let branch = task.branch;
    if (!worktreeDir) {
      try {
        const worktree = createTaskWorktree(projectRoot, task.id, {
          baseRef: task.baseBranch,
          branchName: task.branchName
        });
        worktreeDir = worktree.dir;
        branch = worktree.branch;
      } catch (err) {
        log.error('task.worktree_error', { taskId: task.id, error: err.message });
        updateTask(projectRoot, task.id, { status: 'pending', error: `no se pudo crear el worktree: ${err.message}` });
        return { error: `no se pudo crear el worktree: ${err.message}`, code: 500 };
      }
    }

    // Cada etapa la hace un agente del catalogo, con su motor, modelo y prompt de rol.
    const agent = resolveStageAgent(projectRoot, task, stage);
    if (!agent) return { error: `no hay ningun agente para la etapa "${stage}"`, code: 409 };
    if (!agent.enabled && stage === 'custom') return { error: `el agente "${agent.name}" está desactivado`, code: 409 };

    let opts;
    const settings = loadSettings(projectRoot);
    try {
      opts = buildSessionOptions(settings, worktreeDir, projectRoot, task.id, agent);
    } catch (err) {
      return { error: err.message, code: 500 };
    }

    // Responder a una pregunta de implementacion reanuda la misma conversacion
    // (la sesion de la etapa anterior) para que el agente conserve el contexto.
    const resuming = answer !== undefined && Boolean(task.sessionId);
    if (resuming) opts.resumeSessionId = task.sessionId;
    let prompt = buildStagePrompt(task, stage, { docOptions: effectiveDocOptions, agent });
    if (answer !== undefined)
      prompt = resuming
        ? answerPrompt(answer, stage)
        : `${prompt}\n\nRespuesta del usuario a tus preguntas:\n${answer.trim()}`;

    const approved = Array.isArray(settings.preferences.approvedTools) ? settings.preferences.approvedTools : [];
    opts.extraAllowedTools = [...stageTools(stage, agent), ...approved];
    opts.disallowedTools = stageDisallowed(stage, agent);
    opts.gitHooksPath = ensureGitGuardHooks(projectRoot);
    const session = new ClaudeSession(opts);
    taskSessions.set(taskId, session);
    updateTaskPhase(projectRoot, taskId, STAGE_PHASE[stage], 'active');
    log.info('task.stage.start', {
      taskId,
      stage,
      branch,
      resumed: resuming,
      agent: agent.id,
      model: opts.model || 'default'
    });
    if (answer !== undefined) log.info('task.answer', { taskId, stage, text: cut(answer) });
    const started = updateTask(projectRoot, taskId, {
      stage,
      status: 'in_progress',
      error: null,
      pendingQuestion: null,
      pendingPermission: null,
      branch,
      worktreePath: worktreeDir,
      sessionId: session.sessionId,
      // Historial de etapas: que agente y modelo hizo cada una (lo muestra la tarjeta).
      stageRuns: [
        ...(task.stageRuns || []),
        {
          stage,
          agentId: agent.id,
          agentName: agent.name,
          engine: agent.engine,
          model: agent.model || 'default',
          startedAt: new Date().toISOString()
        }
      ],
      docOptions: effectiveDocOptions || task.docOptions
    });
    broadcast({ type: 'task_updated', task: started });

    // El evento de denegacion solo trae el nombre de la herramienta; el comando
    // concreto viene en el bloque tool_use previo con el mismo id.
    const toolUses = new Map();
    session.on('event', (event) => {
      broadcast({ type: 'task_claude_event', taskId, event });
      if (event.type === 'assistant') {
        for (const block of event.message?.content || []) {
          if (block.type === 'tool_use') toolUses.set(block.id, { name: block.name, input: block.input });
          if (block.type === 'tool_use' && FILE_TOOLS.has(block.name)) {
            log.info('file.edit', {
              scope: 'task',
              taskId,
              stage,
              tool: block.name,
              path: relPath(worktreeDir, block.input?.file_path)
            });
          }
        }
      }
      if (event.type === 'result') finishTaskStage(taskId, stage, worktreeDir, session, event);
      // Una tarea no es interactiva: si la etapa necesita un permiso que no tiene,
      // se detiene y la tarjeta ofrece aprobarlo y reintentar. No se abre la terminal.
      if (event.type === 'system' && event.subtype === 'permission_denied' && !session._stageDone) {
        const tool = event.tool_name || 'una herramienta';
        const use = toolUses.get(event.tool_use_id);
        const command = use?.name === 'Bash' ? use.input?.command : undefined;
        // Bash va libre en las etapas: lo que aun asi se deniega es politica
        // (comandos destructivos, commits...) y no se aprueba desde la tarjeta.
        // Como en Claude Code normal, el agente recibe la denegacion y sigue por
        // otro camino; solo si insiste demasiado se para la etapa.
        const rule = tool === 'Bash' ? null : approvalRule(tool);
        const approvedNow = loadSettings(projectRoot).preferences.approvedTools || [];
        const alreadyApproved = rule !== null && approvedNow.includes(rule);
        session._denials = (session._denials || 0) + 1;
        log.warn('task.stage.denied', { taskId, stage, tool, command: cut(command), alreadyApproved });
        const blocked = { stage, tool, command: command ? cut(command) : undefined, at: new Date().toISOString() };
        const policyDenial = !rule || alreadyApproved;
        if (policyDenial && session._denials < MAX_POLICY_DENIALS) {
          const current = loadTasks(projectRoot).find((t) => t.id === taskId);
          const updated = updateTask(projectRoot, taskId, {
            blockedCommands: [...(current?.blockedCommands || []), blocked].slice(-20)
          });
          if (updated) broadcast({ type: 'task_updated', task: updated });
          return;
        }
        session._stageDone = true;
        session.kill();
        if (taskSessions.get(taskId) === session) taskSessions.delete(taskId);
        const current = loadTasks(projectRoot).find((t) => t.id === taskId);
        const updated = updateTask(projectRoot, taskId, {
          status: 'pending',
          stageRuns: closeLastRun(current, stage, 'blocked'),
          error: policyDenial
            ? `la etapa "${stage}" se detuvo: el agente insistió en acciones prohibidas para los agentes (la última: ${command ? cut(command) : tool}). Reinténtala con más indicaciones o cambia de agente.`
            : `la etapa "${stage}" necesita permiso para ${tool}.`,
          pendingPermission: policyDenial ? null : { tool }
        });
        if (updated) broadcast({ type: 'task_updated', task: updated });
      }
    });
    session.on('error', (err) => {
      log.error('task.session_error', { taskId, stage, error: err.message });
      broadcast({ type: 'task_error', taskId, error: err.message });
    });
    session.on('exit', () => {
      if (taskSessions.get(taskId) === session) taskSessions.delete(taskId);
      if (session._stageDone) return;
      // Salida sin `result` (fallo, kill o handoff a la terminal): la tarea no
      // puede quedarse en in_progress para siempre.
      const before = loadTasks(projectRoot).find((t) => t.id === taskId);
      const current = updateTask(projectRoot, taskId, {
        status: 'pending',
        stageRuns: closeLastRun(before, stage, 'error'),
        error: `la etapa "${stage}" terminó sin completarse`
      });
      if (current) broadcast({ type: 'task_updated', task: current });
    });

    session._startedAt = Date.now();
    log.info('claude.session.spawn', { scope: 'task', taskId, stage, sessionId: session.sessionId });
    session.send(prompt);
    return { task: started };
  }

  function approveAndRetryTask(taskId, { tool, command } = {}) {
    const task = loadTasks(projectRoot).find((t) => t.id === taskId);
    if (!task) return { error: 'task not found', code: 404 };
    if (!task.stage || !task.pendingPermission)
      return { error: 'la tarea no esta esperando ningun permiso', code: 409 };
    const rule = approvalRule(tool, command);
    if (!rule) return { error: 'esta herramienta no se puede aprobar desde la tarjeta', code: 400 };
    if (tool !== task.pendingPermission.tool || (tool === 'Bash' && command !== task.pendingPermission.command)) {
      return { error: 'el permiso pendiente ya no coincide con la petición', code: 409 };
    }
    // Los permisos aprobados desde una tarjeta son de este repo.
    const approved = loadProjectLayer(projectRoot).preferences.approvedTools;
    if (!approved.includes(rule)) {
      saveProjectSettings(projectRoot, { preferences: { approvedTools: [...approved, rule] } });
    }
    log.info('task.approve', { taskId, rule });
    return runTaskStage(taskId, { stage: task.stage });
  }

  function finishTaskStage(taskId, stage, worktreeDir, session, event) {
    session._stageDone = true;
    if (taskSessions.get(taskId) === session) taskSessions.delete(taskId);
    const text = typeof event.result === 'string' ? event.result : '';

    let hasChanges = false;
    try {
      hasChanges = stageForReview(worktreeDir).hasChanges;
    } catch (err) {
      broadcast({ type: 'task_error', taskId, error: `no se pudo preparar el stage: ${err.message}` });
    }

    const current = loadTasks(projectRoot).find((t) => t.id === taskId);
    session.close();
    if (!current) return; // la tarea se borro mientras corria

    const phaseStatus = (current.phases || []).find((p) => p.key === STAGE_PHASE[stage])?.status;
    const agent = resolveStageAgent(projectRoot, current, stage);
    const { patch, next } = decideAfterStage(current, stage, {
      text,
      hasChanges,
      phaseStatus,
      isError: event.is_error === true,
      skip: skippedStages(projectRoot),
      agent
    });
    const touched = changedFiles(worktreeDir);
    log.info('file.stage_changes', { taskId, stage, files: touched.slice(0, 200), total: touched.length });
    const outputFiles = listFilesModifiedSince(worktreeDir, session._startedAt || 0);
    const knownFiles = new Set(current.outputFiles || []);
    for (const f of outputFiles) knownFiles.add(f);
    if (patch.pendingQuestion)
      log.info('task.question', {
        taskId,
        stage,
        kind: patch.pendingQuestion.kind,
        text: cut(patch.pendingQuestion.text)
      });
    const runs = [...(current.stageRuns || [])];
    if (runs.length && runs[runs.length - 1].stage === stage && !runs[runs.length - 1].finishedAt) {
      runs[runs.length - 1] = {
        ...runs[runs.length - 1],
        finishedAt: new Date().toISOString(),
        status: patch.error ? 'error' : patch.status === 'awaiting_input' ? 'asked' : 'done',
        filesTouched: touched.length,
        costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : null
      };
    }
    const commitDraft =
      patch.status === 'ready_to_test' && !patch.suggestedCommit && !current.suggestedCommit
        ? { suggestedCommit: defaultCommitMessage(current) }
        : {};
    const updated = updateTask(projectRoot, taskId, {
      ...patch,
      ...commitDraft,
      stageRuns: runs,
      outputFiles: [...knownFiles].sort(),
      // Los que git ignora: no entran en el commit salvo que el usuario los marque.
      ignoredOutputs: ignoredAmong(worktreeDir, [...knownFiles])
    });
    log.info('task.stage.finish', {
      taskId,
      stage,
      status: updated?.status,
      hasChanges,
      outputFiles: knownFiles.size,
      error: patch.error || null
    });
    broadcast({ type: 'task_updated', task: updated });

    if (next) {
      const result = runTaskStage(taskId, { stage: next });
      if (result.error) broadcast({ type: 'task_error', taskId, error: result.error });
    }
  }

  function startTaskSession(task) {
    const result = runTaskStage(task.id, { stage: firstStage(task.type) });
    if (result.error) broadcast({ type: 'task_error', taskId: task.id, error: result.error });
  }

  // A chat's ClaudeSession lives here, keyed by chatId, independent of any
  // single WebSocket connection (same pattern as taskSessions above) — this
  // is what makes "refresh the tab" stop killing the conversation: the
  // browser is just a viewer that replays the persisted transcript and,
  // if it's still running, re-attaches to the same live process.
  function startOrGetChatSession(chatId) {
    const existing = chatSessions.get(chatId);
    if (existing) return existing;

    const chat = loadChat(projectRoot, chatId);
    if (!chat) return null;

    const settings = loadSettings(projectRoot);
    const opts = buildSessionOptions(settings, projectRoot);
    opts.resumeSessionId = chat.claudeSessionId || undefined;

    const session = new ClaudeSession(opts);
    chatSessions.set(chatId, session);
    log.info('claude.session.spawn', {
      scope: 'chat',
      chatId,
      sessionId: session.sessionId,
      resumed: Boolean(chat.claudeSessionId)
    });
    if (!chat.claudeSessionId) {
      updateChatMeta(projectRoot, chatId, { claudeSessionId: session.sessionId });
    }

    session.on('event', (event) => {
      for (const block of event.message?.content || []) {
        if (event.type === 'assistant' && block.type === 'text' && block.text?.trim()) {
          log.info('chat.reply', { chatId, text: cut(block.text) });
        }
        if (event.type === 'assistant' && block.type === 'tool_use' && FILE_TOOLS.has(block.name)) {
          log.info('file.edit', {
            scope: 'chat',
            chatId,
            tool: block.name,
            path: relPath(projectRoot, block.input?.file_path)
          });
        }
      }
      appendMessage(projectRoot, chatId, { role: 'claude_event', event, ts: new Date().toISOString() });
      broadcast({ type: 'claude_event', chatId, event });
      watchForPermissionHandoff('chat', chatId, session, chatSessions, event);
    });
    session.on('error', (err) => broadcast({ type: 'bridge_error', chatId, error: err.message }));
    session.on('stderr', (text) => broadcast({ type: 'claude_stderr', chatId, text }));
    session.on('exit', (info) => {
      if (chatSessions.get(chatId) === session) chatSessions.delete(chatId);
      log.info('claude.session.exit', {
        scope: 'chat',
        chatId,
        code: info?.code ?? null,
        signal: info?.signal ?? null,
        stopped: Boolean(session._stopRequested)
      });
      // A handoff-triggered kill is not a real end of the conversation (see
      // watchForPermissionHandoff) — terminal_handoff already told the chat
      // what's happening, so skip the generic "session ended" broadcast. The
      // same goes for a stop the user asked for (stopChatSession).
      if (!session._handoffInProgress && !session._stopRequested) broadcast({ type: 'claude_exit', chatId, info });
    });

    return session;
  }

  // Para la consulta en curso sin borrar la conversacion: el siguiente mensaje
  // reanuda la misma sesion (--resume) con el historial ya guardado.
  function stopChatSession(chatId) {
    const session = chatSessions.get(chatId);
    if (!session) return false;
    session._stopRequested = true;
    log.info('chat.stop', { chatId });
    session.kill();
    chatSessions.delete(chatId);
    return true;
  }

  function killChatSession(chatId) {
    const session = chatSessions.get(chatId);
    if (session) {
      session.kill();
      chatSessions.delete(chatId);
    }
  }

  function killTaskSession(taskId) {
    const session = taskSessions.get(taskId);
    if (session) {
      session.kill();
      taskSessions.delete(taskId);
    }
    broadcast({ type: 'task_deleted', taskId });
  }

  // A real interactive `claude` process in a PTY — separate from chat/task
  // sessions, which stay headless. Lives here, server-side, independent of
  // any WebSocket connection: closing the terminal view doesn't kill it.
  function startOrGetTerminalSession(resumeSessionId, owner) {
    // Already running: never steal it, whatever it's doing — the caller
    // (watchForPermissionHandoff) only notifies in that case, it doesn't call this.
    if (terminalSession) return terminalSession;

    const mcpConfigPath = path.join(projectRoot, '.optimia', 'mcp.json');
    const settingsPath = optimiaClaudeSettingsPath(projectRoot);
    const session = new PtySession({ cwd: projectRoot, mcpConfigPath, settingsPath, resumeSessionId });
    terminalSession = session;
    terminalOwner = owner || null;

    session.on('data', (data) => broadcast({ type: 'terminal_data', data }));
    session.on('exit', (info) => {
      broadcast({ type: 'terminal_exit', info });
      const handedOffChat = terminalOwner && terminalOwner.scope === 'chat' ? terminalOwner.id : null;
      terminalSession = null;
      terminalOwner = null;
      // The terminal resolved whatever needed a human there — bring the
      // chat's headless session back right away (same --resume sessionId,
      // full history intact) instead of leaving it dead until the user
      // happens to type a new message. The terminal process has already
      // exited by this point, so there's no dual-driving risk.
      if (handedOffChat) {
        try {
          startOrGetChatSession(handedOffChat);
          broadcast({ type: 'chat_resumed', chatId: handedOffChat });
        } catch (err) {
          broadcast({ type: 'bridge_error', chatId: handedOffChat, error: err.message });
        }
      }
    });

    return session;
  }

  // Un agente que seguia corriendo al cerrar optimia ya no existe: sus tareas
  // quedan pendientes (reintentables) en vez de en in_progress para siempre.
  for (const task of loadTasks(projectRoot)) {
    if (task.status === 'in_progress') {
      updateTask(projectRoot, task.id, { status: 'pending', error: 'interrumpida al reiniciar optimia' });
    }
  }

  const app = createApp(
    projectRoot,
    {
      onTaskCreated: startTaskSession,
      onTaskRun: runTaskStage,
      onTaskApprove: approveAndRetryTask,
      onTaskUpdated: (task) => broadcast({ type: 'task_updated', task }),
      onTaskDeleted: killTaskSession,
      onChatDeleted: killChatSession
    },
    log
  );

  // Mensajes de WebSocket dirigidos a este proyecto. Devuelve false si el tipo
  // no es de proyecto, para que el servidor responda con un error.
  function handleWsMessage(msg, ws) {
    // Chat sessions are server-side and chatId-tagged on every broadcast;
    // a tab doesn't need to register interest before sending a message.
    if (msg.type === 'subscribe') return;

    if (msg.type === 'terminal_subscribe') {
      const session = startOrGetTerminalSession();
      ws.send(JSON.stringify({ type: 'terminal_scrollback', data: session.scrollback }));
      return;
    }

    if (msg.type === 'terminal_input') {
      if (terminalSession && typeof msg.data === 'string') terminalSession.write(msg.data);
      return;
    }

    if (msg.type === 'terminal_resize') {
      if (terminalSession && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
        terminalSession.resize(msg.cols, msg.rows);
      }
      return;
    }

    if (msg.type === 'stop_chat') {
      if (msg.chatId) {
        stopChatSession(msg.chatId);
        broadcast({ type: 'chat_stopped', chatId: msg.chatId });
      }
      return;
    }

    if (msg.type === 'user_message') {
      if (!msg.chatId) return ws.send(JSON.stringify({ type: 'client_error', error: 'chatId required' }));

      // Never start a second process on a --session-id the terminal already
      // owns (see watchForPermissionHandoff) — same chat, same conversation.
      if (terminalOwner && terminalOwner.scope === 'chat' && terminalOwner.id === msg.chatId) {
        return ws.send(
          JSON.stringify({
            type: 'client_error',
            error:
              'Esta conversación está abierta en la terminal ahora mismo. Cierra esa sesión de terminal para volver a usar el chat.'
          })
        );
      }

      let session;
      try {
        session = startOrGetChatSession(msg.chatId);
      } catch (err) {
        return ws.send(JSON.stringify({ type: 'bridge_error', chatId: msg.chatId, error: err.message }));
      }
      if (!session) return ws.send(JSON.stringify({ type: 'client_error', error: 'chat not found' }));

      appendMessage(projectRoot, msg.chatId, {
        role: 'user',
        text: msg.text,
        images: msg.images || [],
        ts: new Date().toISOString()
      });
      log.info('chat.user', { chatId: msg.chatId, text: cut(msg.text), images: (msg.images || []).length });
      // El primer mensaje da nombre al chat; despues el nombre se queda fijo.
      const chatNow = loadChat(projectRoot, msg.chatId);
      const firstLine =
        (msg.text || '')
          .split('\n')
          .map((l) => l.trim())
          .find(Boolean) || '';
      if (chatNow?.title === 'Nuevo chat' && firstLine) {
        const title = firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
        updateChatMeta(projectRoot, msg.chatId, { title });
        broadcast({ type: 'chat_renamed', chatId: msg.chatId, title });
      }
      try {
        session.send(msg.text, msg.images || []);
      } catch (err) {
        ws.send(JSON.stringify({ type: 'bridge_error', chatId: msg.chatId, error: err.message }));
      }
      return;
    }

    return false;
  }

  function dispose() {
    for (const session of [...taskSessions.values(), ...chatSessions.values()]) session.kill();
    taskSessions.clear();
    chatSessions.clear();
    if (terminalSession) terminalSession.kill();
  }

  return { id: projectId, root: projectRoot, app, log, handleWsMessage, dispose };
}

module.exports = { createProjectRuntime, writeMcpConfig, ensureOptimiaExcluded };
