'use strict';

// Live state of one project: chat and task sessions, the terminal and the project's HTTP API. The
// server creates one runtime per open project (see server/index.js) and passes it sendToClients to
// broadcast over the shared WebSocket.

const fs = require('fs');
const { limitHit, markClaudeBlocked, fallbackEngine, claudeBlockedUntil } = require('../ai/fallback');
const path = require('path');
const crypto = require('crypto');
const { parseDenial, approvedCommands } = require('../bridge/policy');
const { loadSettings, loadProjectLayer, saveProjectSettings } = require('../store/settingsStore');
const { loadTasks, updateTask, updateTaskPhase } = require('../store/taskStore');
const { loadChat, updateChatMeta, appendMessage } = require('../store/chatStore');
const { ClaudeSession } = require('../bridge/claudeProcess');
const { PtySession } = require('../bridge/ptySession');
const { buildSessionOptions, engineFor } = require('../bridge/sessionOptions');
const { resolveStageAgent, skippedStages } = require('../agents/stageMap');
const { loadAgents } = require('../agents/catalog');
const { createTaskWorktree, stageForReview, changedFiles, ignoredAmong } = require('../bridge/worktree');
const logger = require('../bridge/logger');

const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write']);
// Question and answer text stored in the log, truncated.
const cut = (text, n = 500) => (typeof text !== 'string' ? null : text.length > n ? `${text.slice(0, n)}…` : text);
// Path relative to the project or worktree root, so the log does not depend on where the user's
// repo lives.
function relPath(base, p) {
  if (typeof p !== 'string' || !p) return null;
  return path.isAbsolute(p) ? path.relative(base, p) : p;
}
const { ensureGitGuardHooks } = require('../bridge/gitGuard');
const { syncClaudeSettings, optimiaClaudeSettingsPath } = require('../bridge/claudeSettingsSync');
const { sandboxProblem } = require('../bridge/sandbox');
const { enqueueWikiUpdate } = require('../knowledge/wikiUpdater');
const { adoptPendingMemory } = require('../knowledge/bundle');
const { loadAttachments, attachmentsPrompt } = require('../bridge/attachments');
const { listFilesModifiedSince } = require('../bridge/taskFiles');
const {
  STAGE_PHASE,
  firstStage,
  stageTools,
  stageDisallowed,
  stageAccess,
  approvalRule,
  canRun,
  buildStagePrompt,
  answerPrompt,
  decideAfterStage,
  defaultCommitMessage,
  DESCRIBE_TARGETS
} = require('../bridge/taskStages');
const { createApp } = require('./projectApp');

// Written when the project opens: --mcp-config needs this file before any session starts, so
// create_task and update_task_progress reach the server over HTTP (the MCP server is a child of
// `claude`, not of optimia; see server/mcp/tasksServer.js).
function writeMcpConfig(projectRoot, { port, projectId, token }) {
  const dir = path.join(projectRoot, '.optimia');
  fs.mkdirSync(dir, { recursive: true });
  const env = { OPTIMIA_PORT: String(port), OPTIMIA_PROJECT: projectId };
  if (token) env.OPTIMIA_TOKEN = token;
  const config = {
    mcpServers: {
      'optimia-tasks': {
        // The same node that runs optimia: with nvm or other version managers, "node" may not be on
        // the claude process's PATH and the MCP server would not start.
        command: process.execPath,
        args: [path.join(__dirname, '..', 'mcp', 'tasksServer.js')],
        env
      }
    }
  };
  fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

// The .optimia folder of a repo opened from a workbench must not show up as a git change. It is
// excluded in .git/info/exclude (local, not versioned) instead of touching the user's .gitignore.
// If it is already ignored, nothing is done.
function ensureOptimiaExcluded(projectRoot) {
  const gitDir = path.join(projectRoot, '.git');
  try {
    if (!fs.statSync(gitDir).isDirectory()) return; // worktree or submodule: .git is a file
    const gitignore = path.join(projectRoot, '.gitignore');
    const ignored = fs.existsSync(gitignore) && /^\/?\.optimia\/?$/m.test(fs.readFileSync(gitignore, 'utf8'));
    if (ignored) return;
    const exclude = path.join(gitDir, 'info', 'exclude');
    const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    if (/^\/?\.optimia\/?$/m.test(current)) return;
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}/.optimia\n`);
  } catch {
    /* not a git repo or not writable: nothing to exclude */
  }
}

// Closes the last run of `stage` in stageRuns with a status.
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
  // Permissions of optimia's sessions, passed with --settings (nothing in the repo).
  syncClaudeSettings(projectRoot, loadSettings(projectRoot).preferences.noGo);
  // A memory imported from another machine before this repo existed here.
  try {
    adoptPendingMemory(projectRoot);
  } catch {
    /* not critical */
  }
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

  // Everything broadcast carries the project id: one browser shows several projects.
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
    // Sessions that ask in the chat only get here for rules ("Prohibido"): those stay denied.
    if (session.approvals) return;
    broadcast({ type: 'permission_needed', scope, id, toolName: event.tool_name, message: event.message });
    // Flagged so the session's own 'exit' handler (below) knows this kill is
    // an intentional handoff, not a real/unexpected end — without this, the
    // generic claude_exit broadcast races with terminal_handoff and the chat
    // shows a confusing "session ended" message right on top of the handoff.
    session._handoffInProgress = true;
    log.warn('handoff.terminal', { scope, id, tool: event.tool_name });
    session.kill();
    sessionsMap.delete(id);
    if (startOrGetTerminalSession(session.sessionId, { scope, id })) {
      broadcast({ type: 'terminal_handoff', scope, id, toolName: event.tool_name });
    }
  }

  function recordBlocked(taskId, entry) {
    const current = loadTasks(projectRoot).find((t) => t.id === taskId);
    if (!current) return;
    const list = current.blockedCommands || [];
    // The same command blocked again in the same stage is one entry.
    if (list.some((b) => b.stage === entry.stage && b.tool === entry.tool && b.fullCommand === entry.fullCommand))
      return;
    const updated = updateTask(projectRoot, taskId, {
      blockedCommands: [...list, { ...entry, id: crypto.randomUUID(), at: new Date().toISOString() }].slice(-20)
    });
    if (updated) broadcast({ type: 'task_updated', task: updated });
  }

  // "Permitir" on a blocked action: the exact command (or tool) is approved for this repo, from the
  // next stage on ("Permitir y repetir etapa" runs it again now).
  function allowBlocked(taskId, { blockedId, retry = false } = {}) {
    const task = loadTasks(projectRoot).find((t) => t.id === taskId);
    if (!task) return { error: 'task not found', code: 404 };
    const entry = (task.blockedCommands || []).find((b) => b.id === blockedId);
    if (!entry) return { error: 'no se encontró esa acción bloqueada', code: 404 };
    if (!entry.approvable) return { error: 'esta acción no se puede permitir a los agentes', code: 400 };
    const rule = approvalRule(entry.tool, entry.fullCommand);
    if (!rule) return { error: 'esta acción no se puede permitir desde la tarjeta', code: 400 };
    const approvedNow = loadProjectLayer(projectRoot).preferences.approvedTools;
    if (!approvedNow.includes(rule)) {
      saveProjectSettings(projectRoot, { preferences: { approvedTools: [...approvedNow, rule] } });
    }
    log.info('task.allow', { taskId, rule });
    const updated = updateTask(projectRoot, taskId, {
      blockedCommands: task.blockedCommands.map((b) => (b.id === blockedId ? { ...b, allowed: true } : b))
    });
    broadcast({ type: 'task_updated', task: updated });
    const canRetry = retry && !taskSessions.has(taskId) && task.stage && task.status !== 'in_progress';
    if (canRetry) return runTaskStage(taskId, { stage: task.stage });
    return { task: updated };
  }

  // The wiki agent (wikiUpdater.js) turns a committed task, or a delivered report, into wiki pages.
  function updateWiki(task, change) {
    const settings = loadSettings(projectRoot);
    const agent = loadAgents(projectRoot).find((a) => a.id === 'wiki-keeper');
    if (agent && agent.enabled === false) return;
    enqueueWikiUpdate({
      projectRoot,
      task,
      change,
      settings,
      agent,
      log,
      onDone: (outcome) => {
        const updated = updateTask(projectRoot, task.id, { wikiUpdate: outcome });
        if (updated) broadcast({ type: 'task_updated', task: updated });
        broadcast({ type: 'wiki_changed', scope: 'project', key: outcome.key, pages: outcome.pages });
      }
    }).catch((err) => log.error('wiki.update_failed', { taskId: task.id, error: err.message }));
  }

  // Starts a stage of the task's pipeline (see bridge/taskStages.js) in its worktree. One Claude
  // session per stage; when it ends, the stage decides the next state and, if needed, starts the
  // next stage automatically. Returns { task } or { error, code } for the HTTP route to answer.
  function runTaskStage(taskId, { stage, answer, docOptions, describe, afterSwitch } = {}) {
    const task = loadTasks(projectRoot).find((t) => t.id === taskId);
    if (!task) return { error: 'task not found', code: 404 };
    if (taskSessions.has(taskId)) return { error: 'la tarea ya tiene un agente en marcha', code: 409 };

    const blockedBySandbox = sandboxProblem(loadSettings(projectRoot).security.sandbox);
    if (blockedBySandbox) {
      const updated = updateTask(projectRoot, taskId, { status: 'pending', stage, error: blockedBySandbox });
      if (updated) broadcast({ type: 'task_updated', task: updated });
      return { error: blockedBySandbox, code: 412 };
    }

    const effectiveDocOptions = stage === 'write' ? docOptions || task.docOptions : undefined;
    // afterSwitch: the same stage goes on with another provider (Claude ran out of usage).
    const problem = afterSwitch ? null : canRun(task, stage, { answer, docOptions: effectiveDocOptions });
    if (problem) return { error: problem, code: 409 };
    // describe: PR description or Jira comment, with optional notes from the user.
    let describeOptions;
    if (stage === 'describe') {
      const target = DESCRIBE_TARGETS.includes(describe?.target) ? describe.target : 'pr';
      const notes = typeof describe?.notes === 'string' ? describe.notes.trim().slice(0, 2000) : '';
      describeOptions = { target, notes };
    }

    let worktreeDir = task.worktreePath;
    let branch = task.branch;
    if (!worktreeDir) {
      try {
        const worktree = createTaskWorktree(projectRoot, task.id, {
          baseRef: task.baseBranch,
          branchName: task.branchName,
          existingBranch: task.existingBranch
        });
        worktreeDir = worktree.dir;
        branch = worktree.branch;
      } catch (err) {
        log.error('task.worktree_error', { taskId: task.id, error: err.message });
        updateTask(projectRoot, task.id, { status: 'pending', error: `no se pudo crear el worktree: ${err.message}` });
        return { error: `no se pudo crear el worktree: ${err.message}`, code: 500 };
      }
    }

    // Each stage is run by an agent from the catalog, with its engine, model and role prompt.
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

    // Answering an implementation question resumes the same conversation (the previous stage's
    // session) so the agent keeps its context.
    const resuming = (answer !== undefined || Boolean(afterSwitch)) && Boolean(task.sessionId);
    if (resuming) opts.resumeSessionId = task.sessionId;
    let prompt = buildStagePrompt(task, stage, { docOptions: effectiveDocOptions, agent, describeOptions });
    if (afterSwitch && resuming)
      prompt =
        'Sigue exactamente donde lo dejaste en esta etapa: el modelo anterior se quedó sin uso y ahora continúas tú con todo el historial de arriba. No repitas lo que ya está hecho.';
    else if (answer !== undefined)
      prompt = resuming
        ? answerPrompt(answer, stage)
        : `${prompt}\n\nRespuesta del usuario a tus preguntas:\n${answer.trim()}`;

    const approved = Array.isArray(settings.preferences.approvedTools) ? settings.preferences.approvedTools : [];
    opts.extraAllowedTools = [...stageTools(stage, agent), ...approved];
    opts.disallowedTools = stageDisallowed(stage, agent);
    opts.gitHooksPath = ensureGitGuardHooks(projectRoot);
    // Exceptions to the safety policy approved from the cards, fixed for the whole stage.
    opts.extraEnv = { OPTIMIA_APPROVED_COMMANDS: JSON.stringify(approvedCommands(approved)) };
    const session = new ClaudeSession(opts);
    session.engine = opts.engine;
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
      // Stage history: which agent and model ran each stage (shown on the card).
      stageRuns: [
        ...(task.stageRuns || []),
        {
          stage,
          agentId: agent.id,
          agentName: agent.name,
          engine: opts.engine || agent.engine,
          model: opts.model || agent.model || 'default',
          startedAt: new Date().toISOString()
        }
      ],
      docOptions: effectiveDocOptions || task.docOptions,
      ...(describeOptions ? { describeTarget: describeOptions.target } : {})
    });
    broadcast({ type: 'task_updated', task: started });

    // The denial event only carries the tool name; the actual command is in the earlier tool_use
    // block with the same id.
    const toolUses = new Map();
    session.on('event', (event) => {
      if (session._switching) return;
      if (switchOnLimit('task', taskId, session, event)) return;
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
      // Commands the safety policy blocked (policyHook.js): the agent got the reason and goes on;
      // the card shows them with "Permitir" when they can be approved.
      if (event.type === 'user') {
        for (const block of event.message?.content || []) {
          if (block.type !== 'tool_result' || !block.is_error) continue;
          const text = Array.isArray(block.content)
            ? block.content.map((c) => c.text || '').join('\n')
            : String(block.content || '');
          const rule = parseDenial(text);
          if (!rule) continue;
          const use = toolUses.get(block.tool_use_id);
          recordBlocked(taskId, {
            stage,
            tool: 'Bash',
            command: use?.input?.command ? cut(use.input.command) : undefined,
            fullCommand: use?.input?.command,
            reason: rule.reason,
            policy: rule.id,
            approvable: rule.approvable
          });
        }
      }
      if (event.type === 'result') finishTaskStage(taskId, stage, worktreeDir, session, event);
      // A tool the stage is not allowed to use (an MCP tool of the repo, a read-only stage trying
      // to edit...): the agent gets the denial and goes on, as in Claude Code. Nothing stops the
      // stage; the card lists it and, when it can be approved, offers "Permitir".
      if (event.type === 'system' && event.subtype === 'permission_denied' && !session._stageDone) {
        const tool = event.tool_name || 'una herramienta';
        const use = toolUses.get(event.tool_use_id);
        const command = use?.name === 'Bash' ? use.input?.command : undefined;
        const rule = approvalRule(tool, command);
        const readOnlyEdit =
          ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(tool) && stageAccess(stage, agent) !== 'edit';
        log.warn('task.stage.denied', { taskId, stage, tool, command: cut(command) });
        recordBlocked(taskId, {
          stage,
          tool,
          command: command ? cut(command) : undefined,
          fullCommand: command,
          reason: readOnlyEdit
            ? 'editar ficheros en una etapa de solo lectura'
            : `usar ${tool}, que esta etapa no tiene permitido`,
          approvable: Boolean(rule) && !readOnlyEdit
        });
      }
    });
    session.on('error', (err) => {
      log.error('task.session_error', { taskId, stage, error: err.message });
      broadcast({ type: 'task_error', taskId, error: err.message });
    });
    session.on('exit', () => {
      if (taskSessions.get(taskId) === session) taskSessions.delete(taskId);
      if (session._switching) {
        const result = runTaskStage(taskId, { stage, afterSwitch: true });
        if (result.error) broadcast({ type: 'task_error', taskId, error: result.error });
        return;
      }
      if (session._stageDone) return;
      // Exit without a `result` (failure, kill or handoff to the terminal): the task cannot stay
      // in_progress forever.
      const before = loadTasks(projectRoot).find((t) => t.id === taskId);
      const current = updateTask(projectRoot, taskId, {
        status: 'pending',
        stageRuns: closeLastRun(before, stage, 'error'),
        error: `la etapa "${stage}" terminó sin completarse`
      });
      if (current) broadcast({ type: 'task_updated', task: current });
      if (current && !session._killedByUser) retryOnce(taskId, stage);
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
    // Permissions approved from a card belong to this repo.
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
    if (!current) return; // the task was deleted while it was running

    const phaseStatus = (current.phases || []).find((p) => p.key === STAGE_PHASE[stage])?.status;
    const agent = resolveStageAgent(projectRoot, current, stage);
    const { patch, next } = decideAfterStage(current, stage, {
      text,
      hasChanges,
      phaseStatus,
      isError: event.is_error === true,
      skip: skippedStages(projectRoot),
      agent,
      describeTarget: current.describeTarget
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
      // Changes not committed yet (e.g. a new verification after the first commit).
      uncommitted: hasChanges,
      outputFiles: [...knownFiles].sort(),
      // The ones git ignores: they stay out of the commit unless the user ticks them.
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
    // A report (audit, repo study, read-only agent) is knowledge too: it goes to the wiki.
    if (updated && patch.status === 'ready_to_test' && patch.reportOnly && !patch.error && text.trim()) {
      updateWiki(updated, { report: text });
    }

    if (next) {
      const result = runTaskStage(taskId, { stage: next });
      if (result.error) broadcast({ type: 'task_error', taskId, error: result.error });
    } else if (event.is_error === true) {
      retryOnce(taskId, stage);
    }
  }

  // A stage that fails (API error, a crash) is repeated once by itself before asking the user.
  function retryOnce(taskId, stage) {
    const task = loadTasks(projectRoot).find((t) => t.id === taskId);
    const tries = task?.autoRetries?.[stage] || 0;
    if (!task || tries >= 1) return;
    updateTask(projectRoot, taskId, { autoRetries: { ...(task.autoRetries || {}), [stage]: tries + 1 } });
    log.info('task.stage.auto_retry', { taskId, stage });
    setTimeout(() => {
      if (taskSessions.has(taskId)) return;
      const result = runTaskStage(taskId, { stage });
      if (result.error) broadcast({ type: 'task_error', taskId, error: result.error });
    }, 3000).unref?.();
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
  /**
   * Claude ran out of usage in this session: Claude is marked unavailable until the reset, the
   * session is stopped and the same conversation goes on with Gemini or the local model (same
   * session id, so the new provider gets the whole history). Returns true when it took over.
   */
  function switchOnLimit(scope, id, session, event) {
    if (session.engine !== 'claude') return false;
    const until = limitHit(event);
    if (!until) return false;
    markClaudeBlocked(until, event.rate_limit_info?.rateLimitType || '');
    const to = fallbackEngine(loadSettings(projectRoot));
    log.warn('provider.limit', { scope, id, until: new Date(until).toISOString(), to });
    broadcast({ type: 'provider_switch', scope, id, from: 'claude', to, until });
    if (!to) return false; // nothing to switch to: the error reaches the user as it is
    session._switching = true;
    if (scope === 'chat') {
      chatSessions.delete(id);
      session.kill();
      setTimeout(() => {
        try {
          const next = startOrGetChatSession(id);
          if (next && session._lastSend) {
            next._busy = true;
            next.send(
              `(Mensaje reenviado: el modelo anterior se quedó sin uso antes de responder. Si ya aparece arriba, respóndelo una sola vez.)\n\n${session._lastSend.text}`,
              session._lastSend.images
            );
          }
        } catch (err) {
          broadcast({ type: 'bridge_error', chatId: id, error: err.message });
        }
      }, 300).unref?.();
    } else {
      session._stageDone = true;
      session.kill();
    }
    return true;
  }

  /**
   * Before a new message: a chat left on the fallback provider goes back to its own engine once
   * Claude is available again (and the other way round), between turns, keeping the session.
   */
  function realignChatEngine(chatId) {
    const existing = chatSessions.get(chatId);
    if (!existing || existing._busy) return;
    const settings = loadSettings(projectRoot);
    const wanted = engineFor(settings);
    // A change of the chat permissions setting also starts a new process (same conversation).
    if (existing.engine === wanted && existing.chatPermissions === (settings.chat?.permissions || 'auto')) return;
    if (existing.engine === wanted) {
      existing._switching = true;
      chatSessions.delete(chatId);
      existing.kill();
      return;
    }
    existing._switching = true;
    chatSessions.delete(chatId);
    existing.kill();
    log.info('provider.realign', { chatId, from: existing.engine, to: wanted });
    broadcast({
      type: 'provider_switch',
      scope: 'chat',
      id: chatId,
      from: existing.engine,
      to: wanted,
      until: claudeBlockedUntil()
    });
  }

  // Commands that only read: allowed in the chat without asking (each part of a pipeline must match).
  const READ_ONLY_COMMANDS = [
    'git status',
    'git log',
    'git diff',
    'git show',
    'git ls-files',
    'git branch',
    'git blame',
    'ls',
    'cat',
    'head',
    'tail',
    'wc',
    'grep',
    'rg',
    'pwd',
    'tree',
    'sort',
    'uniq',
    'cut'
  ].map((c) => `Bash(${c}:*)`);

  // What the page needs to show a permission request (the full input can be large).
  function permissionView(request) {
    const input = request.input || {};
    return {
      requestId: request.requestId,
      toolName: request.toolName,
      description: request.description,
      command: typeof input.command === 'string' ? input.command.slice(0, 2000) : undefined,
      path: input.file_path || input.notebook_path || input.path || undefined,
      url: input.url || undefined,
      canAlways: Boolean(approvalRule(request.toolName, input.command))
    };
  }

  /** The user answered a permission card: allow once, always (stored for this repo) or deny. */
  function answerPermission(chatId, requestId, decision) {
    const session = chatSessions.get(chatId);
    const request = session?.pendingPermissions.get(requestId);
    if (!request) return false;
    if (decision === 'always') {
      const rule = approvalRule(request.toolName, request.input?.command);
      if (rule) {
        const approved = loadProjectLayer(projectRoot).preferences.approvedTools;
        if (!approved.includes(rule))
          saveProjectSettings(projectRoot, { preferences: { approvedTools: [...approved, rule] } });
      }
    }
    log.info('chat.permission_answer', { chatId, tool: request.toolName, decision });
    session.respondPermission(requestId, decision);
    broadcast({ type: 'permission_resolved', chatId, requestId, decision });
    return true;
  }

  function startOrGetChatSession(chatId) {
    const existing = chatSessions.get(chatId);
    if (existing) return existing;

    const chat = loadChat(projectRoot, chatId);
    if (!chat) return null;

    const settings = loadSettings(projectRoot);
    const opts = buildSessionOptions(settings, projectRoot);
    opts.resumeSessionId = chat.claudeSessionId || undefined;
    // The chat asks the user (a card in the conversation) instead of denying and jumping to the
    // terminal; what was allowed "always" for this repo is allowed from the start.
    opts.approvals = true;
    const approved = Array.isArray(settings.preferences.approvedTools) ? settings.preferences.approvedTools : [];
    // Auto: Claude Code's classifier approves what is safe (only with Claude: it is Anthropic's).
    // Ask: read-only commands go through without a card.
    const auto = settings.chat?.permissions !== 'ask' && opts.engine === 'claude';
    if (auto) opts.permissionMode = 'auto';
    opts.extraAllowedTools = [...(opts.extraAllowedTools || []), ...approved, ...(auto ? [] : READ_ONLY_COMMANDS)];

    const session = new ClaudeSession(opts);
    session.engine = opts.engine;
    session.chatPermissions = settings.chat?.permissions || 'auto';
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
      if (session._switching) return;
      if (switchOnLimit('chat', chatId, session, event)) return;
      if (event.type === 'result') session._busy = false;
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
    session.on('permission_request', (request) => {
      log.info('chat.permission_request', { chatId, tool: request.toolName, command: cut(request.input?.command) });
      broadcast({ type: 'permission_request', chatId, request: permissionView(request) });
    });
    session.on('permission_cancelled', (requestId) => broadcast({ type: 'permission_resolved', chatId, requestId }));
    session.on('error', (err) => broadcast({ type: 'bridge_error', chatId, error: err.message }));
    session.on('stderr', (text) => broadcast({ type: 'claude_stderr', chatId, text }));
    session.on('exit', (info) => {
      if (chatSessions.get(chatId) === session) chatSessions.delete(chatId);
      for (const requestId of session.pendingPermissions?.keys() || []) {
        broadcast({ type: 'permission_resolved', chatId, requestId });
      }
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
      if (!session._handoffInProgress && !session._stopRequested && !session._switching)
        broadcast({ type: 'claude_exit', chatId, info });
    });

    return session;
  }

  // Stops the running query without deleting the conversation: the next message resumes the same
  // session (--resume) with the history already stored.
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

  function terminalErrorMessage(err) {
    if (/posix_spawnp|ENOENT|not found/i.test(err.message)) {
      return `No se pudo abrir la terminal de Claude: ${err.message}. Comprueba que el comando "claude" está instalado y en el PATH.`;
    }
    return `No se pudo abrir la terminal de Claude: ${err.message}`;
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
    let session;
    try {
      session = new PtySession({ cwd: projectRoot, mcpConfigPath, settingsPath, resumeSessionId });
    } catch (err) {
      // A terminal that cannot start (claude missing, node-pty broken...) must never
      // bring the server down: the error is logged and shown in the interface.
      log.error('terminal.spawn_failed', { error: err.message });
      broadcast({ type: 'terminal_error', error: terminalErrorMessage(err) });
      return null;
    }
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

  // An agent still running when optimia closed no longer exists: its tasks become pending
  // (retryable) instead of staying in_progress forever.
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
      onTaskAllow: allowBlocked,
      onTaskCommitted: (task, change) => updateWiki(task, change),
      onTaskUpdated: (task) => broadcast({ type: 'task_updated', task }),
      onTaskDeleted: killTaskSession,
      onChatDeleted: killChatSession
    },
    log
  );

  // WebSocket messages for this project. Returns false if the type is not a project message, so the
  // server answers with an error.
  function handleWsMessage(msg, ws) {
    // Chat sessions are server-side and chatId-tagged on every broadcast;
    // a tab doesn't need to register interest before sending a message.
    if (msg.type === 'subscribe') {
      // A page that opens (or reloads) while the chat waits for a permission sees the card again.
      const session = msg.chatId && chatSessions.get(msg.chatId);
      for (const request of session?.pendingPermissions?.values() || []) {
        ws.send(
          JSON.stringify({
            type: 'permission_request',
            chatId: msg.chatId,
            projectId,
            request: permissionView(request)
          })
        );
      }
      return;
    }

    if (msg.type === 'permission_response') {
      if (!['allow', 'always', 'deny'].includes(msg.decision)) return;
      if (!answerPermission(msg.chatId, msg.requestId, msg.decision)) {
        ws.send(
          JSON.stringify({ type: 'permission_resolved', chatId: msg.chatId, projectId, requestId: msg.requestId })
        );
      }
      return;
    }

    if (msg.type === 'terminal_subscribe') {
      const session = startOrGetTerminalSession();
      if (session) ws.send(JSON.stringify({ type: 'terminal_scrollback', data: session.scrollback }));
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
        realignChatEngine(msg.chatId);
        session = startOrGetChatSession(msg.chatId);
      } catch (err) {
        return ws.send(JSON.stringify({ type: 'bridge_error', chatId: msg.chatId, error: err.message }));
      }
      if (!session) return ws.send(JSON.stringify({ type: 'client_error', error: 'chat not found' }));

      const attachments = loadAttachments(projectRoot, msg.chatId, msg.attachments || []);
      appendMessage(projectRoot, msg.chatId, {
        role: 'user',
        text: msg.text,
        images: msg.images || [],
        ...(attachments.length
          ? { attachments: attachments.map((a) => ({ id: a.id, name: a.name, kind: a.kind, size: a.size })) }
          : {}),
        ts: new Date().toISOString()
      });
      log.info('chat.user', { chatId: msg.chatId, text: cut(msg.text), images: (msg.images || []).length });
      // The first message names the chat; after that the name stays.
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
        session._lastSend = { text: `${msg.text || ''}${attachmentsPrompt(attachments)}`, images: msg.images || [] };
        session._busy = true;
        session.send(session._lastSend.text, session._lastSend.images);
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
