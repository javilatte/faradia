'use strict';

// HTTP API de un proyecto (todo lo que cuelga de /api/projects/:id/...).
// Recibe el proyecto como parametro: un mismo servidor sirve varios proyectos.
const path = require('path');
const { loadSettings, saveSettings } = require('../store/settingsStore');
const { loadTasks, addTask, updateTask, updateTaskPhase, deleteTask } = require('../store/taskStore');
const { listChats, loadChat, createChat, updateChatMeta, deleteChat } = require('../store/chatStore');
const { checkClaudeCapabilities } = require('../bridge/claudeVersion');
const { syncClaudeSettings } = require('../bridge/claudeSettingsSync');
const { buildMigrationPreview, applyMigration } = require('../migrate/legacyImport');
const {
  removeTaskWorktree,
  listLocalBranches,
  branchNameProblem,
  commitTaskWorktree,
  worktreeIsClean,
  mergeTaskBranch,
  filesChangedBy
} = require('../bridge/worktree');
const { pickFile } = require('../bridge/filePicker');
const logger = require('../bridge/logger');

const { resolveInside, readPreview, openWithSystem } = require('../bridge/taskFiles');
const { loadMemory, saveMemory } = require('../store/memoryStore');
const { listSkills, createSkill } = require('../bridge/skills');
const { getClaudeAuthStatus, openAuthLoginInTerminal } = require('../bridge/claudeAuth');
const { listLocalModels } = require('../bridge/localAi');
const { getAiAssistSuggestion } = require('../bridge/aiAssist');
const { sendJson, readJsonBody } = require('../http/util');
const { handleAgentRoutes } = require('../http/agentRoutes');
const { getAgent } = require('../agents/catalog');
const { isKnownType, TASK_TYPES } = require('../bridge/taskStages');

function createApp(
  projectRoot,
  { onTaskCreated, onTaskUpdated, onTaskDeleted, onTaskRun, onTaskApprove, onChatDeleted } = {},
  log = logger
) {
  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/api/health' && req.method === 'GET') {
      const claudeCheck = checkClaudeCapabilities();
      return sendJson(res, 200, { ok: true, projectRoot, claude: claudeCheck });
    }

    if (url.pathname === '/api/settings' && req.method === 'GET') {
      return sendJson(res, 200, loadSettings(projectRoot));
    }

    if (url.pathname === '/api/settings' && req.method === 'PUT') {
      const body = await readJsonBody(req).catch(() => null);
      if (!body) return sendJson(res, 400, { error: 'invalid JSON body' });
      saveSettings(projectRoot, body);
      const saved = loadSettings(projectRoot);
      // .claude/settings.json is the actual enforcement layer — keep it in
      // lockstep with preferences.noGo on every save, never only in the UI.
      syncClaudeSettings(projectRoot, saved.preferences.noGo);
      return sendJson(res, 200, saved);
    }

    if (url.pathname === '/api/settings/migration-preview' && req.method === 'GET') {
      return sendJson(res, 200, buildMigrationPreview(projectRoot));
    }

    if (url.pathname === '/api/settings/migrate' && req.method === 'POST') {
      return sendJson(res, 200, applyMigration(projectRoot));
    }

    if (url.pathname === '/api/claude-auth' && req.method === 'GET') {
      return sendJson(res, 200, getClaudeAuthStatus());
    }

    if (url.pathname === '/api/claude-auth/login' && req.method === 'POST') {
      return sendJson(res, 200, await openAuthLoginInTerminal());
    }

    if (url.pathname === '/api/local-models' && req.method === 'GET') {
      return sendJson(res, 200, listLocalModels());
    }

    if (url.pathname === '/api/ai-assist' && req.method === 'POST') {
      const body = await readJsonBody(req).catch(() => null);
      if (!body || !body.field || !body.prompt) return sendJson(res, 400, { error: 'field and prompt required' });
      const result = getAiAssistSuggestion(body, { projectRoot });
      if (result.error) return sendJson(res, 502, result);
      return sendJson(res, 200, result);
    }

    if (url.pathname === '/api/memory' && req.method === 'GET') {
      return sendJson(res, 200, { content: loadMemory(projectRoot) });
    }

    if (url.pathname === '/api/memory' && req.method === 'PUT') {
      const body = await readJsonBody(req).catch(() => null);
      if (!body || typeof body.content !== 'string')
        return sendJson(res, 400, { error: 'content (string) is required' });
      saveMemory(projectRoot, body.content);
      return sendJson(res, 200, { content: body.content });
    }

    if (url.pathname === '/api/skills' && req.method === 'GET') {
      return sendJson(res, 200, listSkills(projectRoot));
    }

    if (url.pathname === '/api/skills' && req.method === 'POST') {
      const body = await readJsonBody(req).catch(() => null);
      if (!body || !body.slug) return sendJson(res, 400, { error: 'slug is required' });
      try {
        const skill = createSkill(projectRoot, body.slug, body.description);
        return sendJson(res, 201, skill);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    if (url.pathname === '/api/tasks' && req.method === 'GET') {
      return sendJson(res, 200, loadTasks(projectRoot));
    }

    if (url.pathname === '/api/tasks' && req.method === 'POST') {
      const body = await readJsonBody(req).catch(() => null);
      if (!body || !body.title) return sendJson(res, 400, { error: 'title is required' });
      if (!isKnownType(body.type)) {
        return sendJson(res, 400, { error: `tipo de tarea no válido; usa: ${Object.keys(TASK_TYPES).join(', ')}` });
      }
      if (body.type === 'custom') {
        const agent = typeof body.agentId === 'string' ? getAgent(projectRoot, body.agentId) : null;
        if (!agent) return sendJson(res, 400, { error: 'elige un agente existente para la tarea' });
        if (!agent.enabled) return sendJson(res, 409, { error: `el agente "${agent.name}" está desactivado` });
      }
      const git = listLocalBranches(projectRoot);
      if (body.baseBranch && !git.branches.includes(body.baseBranch)) {
        return sendJson(res, 400, { error: `la rama base "${body.baseBranch}" no existe` });
      }
      if (body.branchName) {
        const problem = branchNameProblem(body.branchName);
        if (problem) return sendJson(res, 400, { error: problem });
        if (git.branches.includes(body.branchName))
          return sendJson(res, 409, { error: `ya existe la rama ${body.branchName}` });
      }
      const task = addTask(projectRoot, body);
      onTaskCreated?.(task);
      return sendJson(res, 201, task);
    }

    // POST /api/tasks/:id/run { stage, answer?, docOptions? } lanza una etapa
    // (revision final, preparar commit, responder una pregunta, redactar...).
    if (url.pathname.startsWith('/api/tasks/') && url.pathname.endsWith('/run') && req.method === 'POST') {
      const taskId = url.pathname.split('/')[3];
      const body = await readJsonBody(req).catch(() => null);
      if (!body || typeof body.stage !== 'string') return sendJson(res, 400, { error: 'stage is required' });
      const result = onTaskRun ? onTaskRun(taskId, body) : { error: 'not supported', code: 501 };
      if (result.error) return sendJson(res, result.code || 409, { error: result.error });
      return sendJson(res, 202, result.task);
    }

    if (url.pathname.startsWith('/api/tasks/') && url.pathname.endsWith('/approve') && req.method === 'POST') {
      const taskId = url.pathname.split('/')[3];
      const body = await readJsonBody(req).catch(() => null);
      if (!body) return sendJson(res, 400, { error: 'invalid JSON body' });
      const result = onTaskApprove ? onTaskApprove(taskId, body) : { error: 'not supported', code: 501 };
      if (result.error) return sendJson(res, result.code || 409, { error: result.error });
      return sendJson(res, 202, result.task);
    }

    if (url.pathname.startsWith('/api/tasks/') && url.pathname.endsWith('/phase') && req.method === 'PATCH') {
      const taskId = url.pathname.split('/')[3];
      const body = await readJsonBody(req).catch(() => null);
      if (!body || !body.phase || !body.status) return sendJson(res, 400, { error: 'phase and status are required' });
      const updated = updateTaskPhase(projectRoot, taskId, body.phase, body.status);
      if (!updated) return sendJson(res, 404, { error: 'task or phase not found' });
      onTaskUpdated?.(updated);
      return sendJson(res, 200, updated);
    }

    if (url.pathname.startsWith('/api/tasks/') && req.method === 'PATCH') {
      const taskId = url.pathname.split('/')[3];
      const body = await readJsonBody(req).catch(() => null);
      if (!body) return sendJson(res, 400, { error: 'invalid JSON body' });
      const updated = updateTask(projectRoot, taskId, body);
      if (!updated) return sendJson(res, 404, { error: 'task not found' });
      return sendJson(res, 200, updated);
    }

    if (url.pathname.startsWith('/api/tasks/') && req.method === 'DELETE') {
      const taskId = url.pathname.split('/')[3];
      const task = loadTasks(projectRoot).find((t) => t.id === taskId);
      if (!task) return sendJson(res, 404, { error: 'task not found' });
      onTaskDeleted?.(taskId); // kills any live session before its worktree goes away
      try {
        removeTaskWorktree(projectRoot, task);
      } catch (err) {
        log.error('task.delete_failed', { taskId, error: err.message });
        return sendJson(res, 500, { error: `no se pudo limpiar el worktree: ${err.message}` });
      }
      deleteTask(projectRoot, taskId);
      log.info('task.delete', { taskId, branch: task.branch });
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname.startsWith('/api/tasks/') && url.pathname.endsWith('/files/preview') && req.method === 'GET') {
      const taskId = url.pathname.split('/')[3];
      const task = loadTasks(projectRoot).find((t) => t.id === taskId);
      if (!task?.worktreePath) return sendJson(res, 404, { error: 'la tarea no tiene worktree' });
      const abs = resolveInside(task.worktreePath, url.searchParams.get('path'));
      if (!abs) return sendJson(res, 404, { error: 'fichero no encontrado en el worktree de la tarea' });
      try {
        return sendJson(res, 200, readPreview(abs));
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    if (url.pathname.startsWith('/api/tasks/') && url.pathname.endsWith('/files/open') && req.method === 'POST') {
      const taskId = url.pathname.split('/')[3];
      const body = await readJsonBody(req).catch(() => null);
      const task = loadTasks(projectRoot).find((t) => t.id === taskId);
      if (!task?.worktreePath) return sendJson(res, 404, { error: 'la tarea no tiene worktree' });
      const abs = resolveInside(task.worktreePath, body?.path);
      if (!abs) return sendJson(res, 404, { error: 'fichero no encontrado en el worktree de la tarea' });
      try {
        await openWithSystem(abs, { reveal: body?.reveal === true });
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return sendJson(res, 501, { error: err.message });
      }
    }

    if (url.pathname === '/api/git/branches' && req.method === 'GET') {
      return sendJson(res, 200, listLocalBranches(projectRoot));
    }

    // Commit y fusion son acciones del usuario (desde su tarjeta), nunca de un agente.
    if (url.pathname.startsWith('/api/tasks/') && url.pathname.endsWith('/commit') && req.method === 'POST') {
      const taskId = url.pathname.split('/')[3];
      const body = await readJsonBody(req).catch(() => null);
      const task = loadTasks(projectRoot).find((t) => t.id === taskId);
      if (!task) return sendJson(res, 404, { error: 'task not found' });
      if (task.status !== 'ready_to_test' || !task.worktreePath)
        return sendJson(res, 409, { error: 'la tarea no está lista para revisar' });
      const message = typeof body?.message === 'string' ? body.message.trim() : '';
      if (!message) return sendJson(res, 400, { error: 'el mensaje de commit no puede estar vacío' });
      let sha;
      try {
        // Solo los ficheros ignorados que el usuario marco, y solo si son de la tarea.
        const outputs = new Set(task.outputFiles || []);
        const includeIgnored = (Array.isArray(body?.includeIgnored) ? body.includeIgnored : []).filter((f) =>
          outputs.has(f)
        );
        sha = commitTaskWorktree(task.worktreePath, message, includeIgnored);
      } catch (err) {
        log.warn('task.commit_failed', { taskId, error: err.message });
        return sendJson(res, 409, { error: `no se pudo hacer commit: ${err.message}` });
      }
      log.info('task.commit', { taskId, sha, files: filesChangedBy(task.worktreePath, sha) });
      return sendJson(res, 200, updateTask(projectRoot, taskId, { lastCommit: sha, lastCommitMessage: message }));
    }

    if (url.pathname.startsWith('/api/tasks/') && url.pathname.endsWith('/merge') && req.method === 'POST') {
      const taskId = url.pathname.split('/')[3];
      const task = loadTasks(projectRoot).find((t) => t.id === taskId);
      if (!task) return sendJson(res, 404, { error: 'task not found' });
      if (!task.lastCommit) return sendJson(res, 409, { error: 'haz commit de la tarea antes de fusionarla' });
      if (!task.baseBranch || !task.branch) return sendJson(res, 409, { error: 'la tarea no tiene rama base' });
      if (!worktreeIsClean(task.worktreePath))
        return sendJson(res, 409, { error: 'quedan cambios sin commitear en la tarea' });
      let merge;
      try {
        merge = mergeTaskBranch(projectRoot, task.branch, task.baseBranch);
      } catch (err) {
        log.warn('task.merge_failed', { taskId, error: err.message });
        return sendJson(res, 409, { error: err.message });
      }
      const files = filesChangedBy(projectRoot, merge.sha, merge.before);
      log.info('task.merge', { taskId, into: task.baseBranch, sha: merge.sha, fastForward: merge.fastForward, files });
      // Ya integrada: fuera el worktree y la rama, como "Delete branch" tras un PR.
      onTaskDeleted?.(taskId);
      let cleaned = true;
      try {
        removeTaskWorktree(projectRoot, task);
      } catch (err) {
        cleaned = false;
        log.warn('task.cleanup_failed', { taskId, error: err.message });
      }
      return sendJson(
        res,
        200,
        updateTask(projectRoot, taskId, {
          mergedInto: task.baseBranch,
          mergeCommit: merge.sha,
          fastForward: merge.fastForward,
          mergedFiles: files,
          mergedAt: new Date().toISOString(),
          ...(cleaned ? { worktreePath: null, branchDeleted: true } : {})
        })
      );
    }

    if (url.pathname === '/api/logs' && req.method === 'GET') {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
      return sendJson(res, 200, log.readRecent(limit));
    }

    if (url.pathname === '/api/pick-file' && req.method === 'POST') {
      let chosen;
      try {
        chosen = await pickFile({ prompt: 'Elige un documento del proyecto' });
      } catch (err) {
        return sendJson(res, 501, { error: err.message });
      }
      if (!chosen) return sendJson(res, 200, { path: null });
      const rel = path.relative(projectRoot, chosen);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
        return sendJson(res, 400, { error: 'el fichero tiene que estar dentro del proyecto' });
      }
      return sendJson(res, 200, { path: rel.split(path.sep).join('/') });
    }

    if (url.pathname === '/api/chats' && req.method === 'GET') {
      return sendJson(res, 200, listChats(projectRoot));
    }

    if (url.pathname === '/api/chats' && req.method === 'POST') {
      const body = await readJsonBody(req).catch(() => ({}));
      return sendJson(res, 201, createChat(projectRoot, body?.title));
    }

    if (url.pathname.startsWith('/api/chats/') && req.method === 'GET') {
      const chatId = url.pathname.split('/')[3];
      const chat = loadChat(projectRoot, chatId);
      if (!chat) return sendJson(res, 404, { error: 'chat not found' });
      return sendJson(res, 200, chat);
    }

    if (url.pathname.startsWith('/api/chats/') && req.method === 'PATCH') {
      const chatId = url.pathname.split('/')[3];
      const body = await readJsonBody(req).catch(() => null);
      if (!body) return sendJson(res, 400, { error: 'invalid JSON body' });
      const updated = updateChatMeta(projectRoot, chatId, body);
      if (!updated) return sendJson(res, 404, { error: 'chat not found' });
      return sendJson(res, 200, updated);
    }

    if (url.pathname.startsWith('/api/chats/') && req.method === 'DELETE') {
      const chatId = url.pathname.split('/')[3];
      onChatDeleted?.(chatId);
      const removed = deleteChat(projectRoot, chatId);
      if (!removed) return sendJson(res, 404, { error: 'chat not found' });
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname.startsWith('/api/agents')) {
      const handled = await handleAgentRoutes(req, res, url, projectRoot);
      if (handled !== null) return handled;
    }

    if (url.pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'not found' });
    }

    return sendJson(res, 404, { error: 'not found' });
  };
}

module.exports = { createApp };
