'use strict';

// HTTP API of one project (everything under /api/projects/:id/...). Takes the project as a
// parameter: one server serves several projects.
const fs = require('fs');
const path = require('path');
const {
  saveSettings,
  loadSettingsLayers,
  saveGlobalSettings,
  saveProjectSettings,
  promoteToGlobal
} = require('../store/settingsStore');
const { loadTasks, addTask, updateTask, updateTaskPhase, deleteTask } = require('../store/taskStore');
const { archiveTask, listArchive, removeArchived, clearArchive } = require('../store/taskArchive');
const { listRuns, mediaPath, removeEvidence } = require('../bridge/evidence');
const { serveRaw } = require('../http/fsRoutes');
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
  filesChangedBy,
  worktreeOfBranch
} = require('../bridge/worktree');
const { pickFile } = require('../bridge/filePicker');
const { saveAttachment } = require('../bridge/attachments');
const logger = require('../bridge/logger');

const { resolveInside, readPreview, openWithSystem } = require('../bridge/taskFiles');
const { loadMemory, saveMemory } = require('../store/memoryStore');
const { listSkills, createSkill } = require('../bridge/skills');
const { getClaudeAuthStatus, openAuthLoginInTerminal } = require('../bridge/claudeAuth');
const { listModelsAt, detectLocalServers } = require('../bridge/localAi');
const { getAiAssistSuggestion } = require('../bridge/aiAssist');
const { suggest } = require('../ai/suggest');
const { engineFor } = require('../bridge/sessionOptions');
const { claudeBlockedUntil } = require('../ai/fallback');
const { sendJson, readJsonBody } = require('../http/util');
const { handleAgentRoutes } = require('../http/agentRoutes');
const { getAgent } = require('../agents/catalog');
const { isKnownType, TASK_TYPES, DESCRIBE_TARGETS } = require('../bridge/taskStages');
const { remoteInfo, ghReady, deliverPullRequest } = require('../bridge/delivery');

// Removing a task never loses work: a shared branch, or commits that are neither merged nor
// pushed, keep their branch.
function keepsBranch(task) {
  if (task.existingBranch) return true;
  return Boolean(task.lastCommit && !task.mergedInto && !task.pr);
}

// gh's login is checked at most once a minute: it takes a while and rarely changes.
let ghCache = { at: 0, ready: false };
async function ghReadyCached(now = Date.now()) {
  if (now - ghCache.at > 60_000) ghCache = { at: now, ready: await ghReady() };
  return ghCache.ready;
}

// Strips what is not the memory: a ```markdown wrapper and any preamble before the first section.
function memoryFromOutput(text) {
  let out = String(text || '').trim();
  const fenced = /^```(?:markdown|md)?\n([\s\S]*?)\n```$/.exec(out);
  if (fenced) out = fenced[1].trim();
  const firstHeading = out.search(/^#{1,3} /m);
  if (firstHeading > 0) out = out.slice(firstHeading);
  return `${out.trim()}\n`;
}

function createApp(
  projectRoot,
  {
    onTaskCreated,
    onTaskUpdated,
    onTaskDeleted,
    onTaskRun,
    onTaskApprove,
    onTaskAllow,
    onTaskCommitted,
    onChatDeleted
  } = {},
  log = logger
) {
  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/api/health' && req.method === 'GET') {
      const claudeCheck = checkClaudeCapabilities();
      return sendJson(res, 200, { ok: true, projectRoot, claude: claudeCheck });
    }

    // The repo's effective settings (global + repo) and, in `layers`, each layer and the fields the
    // repo overrides.
    const settingsView = () => {
      const { global, project, effective, overrides } = loadSettingsLayers(projectRoot);
      // The effective "Prohibido" list is the one optimia's sessions receive.
      syncClaudeSettings(projectRoot, effective.preferences.noGo);
      return {
        ...effective,
        activeEngine: engineFor(effective),
        claudeBlockedUntil: claudeBlockedUntil(),
        layers: { global, project, overrides }
      };
    };

    if (url.pathname === '/api/settings' && req.method === 'GET') {
      return sendJson(res, 200, settingsView());
    }

    // Compatibility: full settings (see saveSettings in settingsStore.js).
    if (url.pathname === '/api/settings' && req.method === 'PUT') {
      const body = await readJsonBody(req).catch(() => null);
      if (!body) return sendJson(res, 400, { error: 'invalid JSON body' });
      saveSettings(projectRoot, body);
      return sendJson(res, 200, settingsView());
    }

    // PATCH /api/settings {scope: 'global'|'project', ui?, ai?, preferences?, reset?: [field],
    // promote?: [field]}
    //   global: changes what all repos share
    //   project: changes only this repo (reset inherits again; promote applies it to all)
    if (url.pathname === '/api/settings' && req.method === 'PATCH') {
      const body = await readJsonBody(req).catch(() => null);
      if (!body || !['global', 'project'].includes(body.scope)) {
        return sendJson(res, 400, { error: 'indica scope: "global" o "project"' });
      }
      const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
      if (body.scope === 'global') {
        saveGlobalSettings({
          ui: body.ui,
          ai: body.ai,
          preferences: body.preferences,
          updates: body.updates,
          security: body.security,
          wiki: body.wiki,
          suggestions: body.suggestions,
          principles: body.principles,
          chat: body.chat,
          tasks: body.tasks
        });
      } else {
        if (list(body.promote).length) promoteToGlobal(projectRoot, list(body.promote));
        if (body.ui) return sendJson(res, 400, { error: 'la apariencia es la misma para todos los repos' });
        saveProjectSettings(projectRoot, { ai: body.ai, preferences: body.preferences }, { reset: list(body.reset) });
      }
      log.info('settings.change', { scope: body.scope, fields: Object.keys(body).filter((k) => k !== 'scope') });
      return sendJson(res, 200, settingsView());
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

    // Models of the configured local server (Settings > Local AI) or, without a URL, of the first
    // server found on this machine.
    if (url.pathname === '/api/local-models' && req.method === 'GET') {
      const configured = loadSettingsLayers(projectRoot).effective.ai.localAi.url;
      try {
        if (configured) return sendJson(res, 200, await listModelsAt(configured));
        const [first] = await detectLocalServers();
        return sendJson(res, 200, first ? first.models : []);
      } catch {
        return sendJson(res, 200, []);
      }
    }

    // Ollama / LM Studio running on this machine, to fill in Settings > Local AI with one click.
    if (url.pathname === '/api/local-ai/detect' && req.method === 'GET') {
      const configuredUrl = loadSettingsLayers(projectRoot).effective.ai.localAi.url;
      return sendJson(res, 200, { servers: await detectLocalServers({ configuredUrl }) });
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

    // What could help with the message being typed: {suggestions: [{kind, id, reason}], engine}.
    if (url.pathname === '/api/suggest' && req.method === 'POST') {
      const body = await readJsonBody(req).catch(() => ({}));
      const result = await suggest({
        text: body.text,
        projectRoot,
        settings: loadSettingsLayers(projectRoot).effective
      });
      if (result.errors?.length) log.warn('suggest.failed', { errors: result.errors });
      return sendJson(res, 200, { suggestions: result.suggestions, engine: result.engine, off: Boolean(result.off) });
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
      // Without a base, the branch checked out now (what the worktree would branch off anyway).
      if (!body.baseBranch && git.current && git.current !== 'HEAD') body.baseBranch = git.current;
      if (body.baseBranch && !git.branches.includes(body.baseBranch)) {
        return sendJson(res, 400, { error: `la rama base "${body.baseBranch}" no existe` });
      }
      let existingBranch = false;
      if (body.branchName) {
        const problem = branchNameProblem(body.branchName);
        if (problem) return sendJson(res, 400, { error: problem });
        // An existing branch: the task adds its work to it (a branch with several tasks).
        if (git.branches.includes(body.branchName)) {
          const busy = loadTasks(projectRoot).find(
            (t) => t.branch === body.branchName && t.worktreePath && !t.mergedInto && !t.deliveredAs
          );
          if (busy) {
            return sendJson(res, 409, {
              error: `la tarea «${busy.title}» ya trabaja en la rama ${body.branchName}: haz su commit antes de lanzar otra en la misma rama`
            });
          }
          const openAt = worktreeOfBranch(projectRoot, body.branchName);
          if (openAt) {
            return sendJson(res, 409, {
              error: `la rama ${body.branchName} está abierta en ${openAt}: cambia allí de rama o elige otra`
            });
          }
          existingBranch = true;
        }
      }
      const task = addTask(projectRoot, { ...body, existingBranch });
      onTaskCreated?.(task);
      return sendJson(res, 201, task);
    }

    // POST /api/tasks/:id/run { stage, answer?, docOptions? } starts a stage (final review, commit
    // message, answering a question, writing...).
    if (url.pathname.startsWith('/api/tasks/') && url.pathname.endsWith('/run') && req.method === 'POST') {
      const taskId = url.pathname.split('/')[3];
      const body = await readJsonBody(req).catch(() => null);
      if (!body || typeof body.stage !== 'string') return sendJson(res, 400, { error: 'stage is required' });
      const result = onTaskRun ? onTaskRun(taskId, body) : { error: 'not supported', code: 501 };
      if (result.error) return sendJson(res, result.code || 409, { error: result.error });
      return sendJson(res, 202, result.task);
    }

    // POST /api/tasks/:id/allow {blockedId, retry?}: approves an action the safety policy blocked.
    if (url.pathname.startsWith('/api/tasks/') && url.pathname.endsWith('/allow') && req.method === 'POST') {
      const taskId = url.pathname.split('/')[3];
      const body = await readJsonBody(req).catch(() => null);
      if (!body || typeof body.blockedId !== 'string') return sendJson(res, 400, { error: 'blockedId is required' });
      const result = onTaskAllow ? onTaskAllow(taskId, body) : { error: 'not supported', code: 501 };
      if (result.error) return sendJson(res, result.code || 409, { error: result.error });
      return sendJson(res, 200, result.task);
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

    // Archive of finished tasks (store/taskArchive.js).
    //   GET    /api/tasks-archive       {retentionDays, tasks}
    //   DELETE /api/tasks-archive/:id   one
    //   DELETE /api/tasks-archive       all
    if (url.pathname === '/api/tasks-archive' && req.method === 'GET') {
      const days = loadSettingsLayers(projectRoot).effective.tasks.archiveDays;
      return sendJson(res, 200, { retentionDays: days, tasks: listArchive(projectRoot, days) });
    }
    if (url.pathname === '/api/tasks-archive' && req.method === 'DELETE') {
      clearArchive(projectRoot);
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname.startsWith('/api/tasks-archive/') && req.method === 'DELETE') {
      const ok = removeArchived(projectRoot, url.pathname.split('/')[3]);
      return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'no está en el archivo' });
    }

    if (url.pathname.startsWith('/api/tasks/') && req.method === 'DELETE') {
      const taskId = url.pathname.split('/')[3];
      const task = loadTasks(projectRoot).find((t) => t.id === taskId);
      if (!task) return sendJson(res, 404, { error: 'task not found' });
      onTaskDeleted?.(taskId); // kills any live session before its worktree goes away
      try {
        removeTaskWorktree(projectRoot, task, { keepBranch: keepsBranch(task) });
      } catch (err) {
        log.error('task.delete_failed', { taskId, error: err.message });
        return sendJson(res, 500, { error: `no se pudo limpiar el worktree: ${err.message}` });
      }
      // Kept in the archive (with its outcome) before it leaves the board.
      try {
        archiveTask(projectRoot, task);
        listArchive(projectRoot, loadSettingsLayers(projectRoot).effective.tasks.archiveDays);
      } catch (err) {
        log.warn('task.archive_failed', { taskId, error: err.message });
      }
      deleteTask(projectRoot, taskId);
      removeEvidence(projectRoot, taskId);
      log.info('task.delete', { taskId, branch: task.branch });
      return sendJson(res, 200, { ok: true });
    }

    // Evidence of the task's verifications (bridge/evidence.js).
    //   GET /api/tasks/:id/evidence                {runs: [{run, checks, images, ...}]}
    //   GET /api/tasks/:id/evidence/media?name=    one image or video
    if (/^\/api\/tasks\/[^/]+\/evidence$/.test(url.pathname) && req.method === 'GET') {
      const taskId = url.pathname.split('/')[3];
      if (!loadTasks(projectRoot).some((t) => t.id === taskId)) return sendJson(res, 404, { error: 'task not found' });
      return sendJson(res, 200, { runs: listRuns(projectRoot, taskId) });
    }
    if (/^\/api\/tasks\/[^/]+\/evidence\/media$/.test(url.pathname) && req.method === 'GET') {
      const taskId = url.pathname.split('/')[3];
      if (!loadTasks(projectRoot).some((t) => t.id === taskId)) return sendJson(res, 404, { error: 'task not found' });
      const file = mediaPath(projectRoot, taskId, url.searchParams.get('name'));
      if (!file) return sendJson(res, 404, { error: 'no existe esa evidencia' });
      return serveRaw(req, res, file);
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

    // "Conocer este repo": the memory the agent proposed becomes the repo's memory (the previous
    // one stays in .optimia/memory.prev.md in case it is needed).
    if (url.pathname.startsWith('/api/tasks/') && url.pathname.endsWith('/apply-memory') && req.method === 'POST') {
      const taskId = url.pathname.split('/')[3];
      const task = loadTasks(projectRoot).find((t) => t.id === taskId);
      if (!task) return sendJson(res, 404, { error: 'task not found' });
      if (task.type !== 'onboard' || task.status !== 'ready_to_test' || !task.output) {
        return sendJson(res, 409, { error: 'esta tarea no tiene una memoria propuesta' });
      }
      const content = memoryFromOutput(task.output);
      const previous = loadMemory(projectRoot);
      if (previous.trim()) fs.writeFileSync(path.join(projectRoot, '.optimia', 'memory.prev.md'), previous);
      saveMemory(projectRoot, content);
      log.info('memory.apply', { taskId, chars: content.length });
      // The study only read the repo: its worktree and branch are no longer needed.
      let cleaned = {};
      if (task.worktreePath || task.branch) {
        try {
          removeTaskWorktree(projectRoot, task);
          cleaned = { worktreePath: null, branchDeleted: true };
        } catch (err) {
          log.warn('task.cleanup_failed', { taskId, error: err.message });
        }
      }
      return sendJson(
        res,
        200,
        updateTask(projectRoot, taskId, { memoryApplied: new Date().toISOString(), ...cleaned })
      );
    }

    // Commit and merge are user actions (from the task card), never an agent's.
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
        // Only the ignored files the user ticked, and only if they belong to the task.
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
      // The wikis learn from every accepted change (in the background).
      onTaskCommitted?.(task, { sha, dir: task.worktreePath });
      return sendJson(
        res,
        200,
        updateTask(projectRoot, taskId, { lastCommit: sha, lastCommitMessage: message, uncommitted: false })
      );
    }

    // How tasks are delivered in this repo: with a remote, as pull requests (opened with gh when the
    // remote is GitHub and gh is logged in); without one, merging locally.
    if (url.pathname === '/api/git/remote' && req.method === 'GET') {
      const remote = await remoteInfo(projectRoot);
      const gh = remote?.provider === 'github' ? await ghReadyCached() : false;
      return sendJson(res, 200, {
        remote: remote && { name: remote.name, webUrl: remote.webUrl, provider: remote.provider },
        gh
      });
    }

    // Edits of the PR description or the Jira comment, kept with the task.
    if (url.pathname.startsWith('/api/tasks/') && url.pathname.endsWith('/delivery') && req.method === 'PUT') {
      const taskId = url.pathname.split('/')[3];
      const body = await readJsonBody(req).catch(() => null);
      const task = loadTasks(projectRoot).find((t) => t.id === taskId);
      if (!task) return sendJson(res, 404, { error: 'task not found' });
      if (!body || !DESCRIBE_TARGETS.includes(body.target) || typeof body.body !== 'string') {
        return sendJson(res, 400, { error: 'indica target ("pr" o "jira") y body' });
      }
      const entry = { ...(task.delivery?.[body.target] || {}), body: body.body.slice(0, 60_000) };
      if (body.target === 'pr' && typeof body.title === 'string') entry.title = body.title.trim().slice(0, 200);
      return sendJson(
        res,
        200,
        updateTask(projectRoot, taskId, { delivery: { ...task.delivery, [body.target]: entry } })
      );
    }

    // Pushes the task branch and opens (or updates) its pull request.
    if (url.pathname.startsWith('/api/tasks/') && url.pathname.endsWith('/pull-request') && req.method === 'POST') {
      const taskId = url.pathname.split('/')[3];
      const body = await readJsonBody(req).catch(() => null);
      const task = loadTasks(projectRoot).find((t) => t.id === taskId);
      if (!task) return sendJson(res, 404, { error: 'task not found' });
      if (!task.lastCommit) return sendJson(res, 409, { error: 'haz commit de la tarea antes de abrir la PR' });
      if (!task.worktreePath || !task.branch || !task.baseBranch)
        return sendJson(res, 409, { error: 'la tarea no tiene rama o rama base' });
      if (!worktreeIsClean(task.worktreePath))
        return sendJson(res, 409, { error: 'quedan cambios sin commitear en la tarea' });
      const title = typeof body?.title === 'string' ? body.title.trim() : '';
      const text = typeof body?.body === 'string' ? body.body : '';
      if (!title) return sendJson(res, 400, { error: 'la PR necesita un título' });
      let result;
      try {
        result = await deliverPullRequest({
          dir: task.worktreePath,
          branch: task.branch,
          base: task.baseBranch,
          title,
          body: text,
          draft: body?.draft === true,
          existingUrl: task.pr?.manual ? null : task.pr?.url
        });
      } catch (err) {
        log.warn('task.pr_failed', { taskId, error: err.message });
        return sendJson(res, 409, { error: err.message });
      }
      log.info('task.pr', {
        taskId,
        url: result.url,
        created: Boolean(result.created),
        manual: Boolean(result.manual)
      });
      const now = new Date().toISOString();
      return sendJson(
        res,
        200,
        updateTask(projectRoot, taskId, {
          delivery: { ...task.delivery, pr: { ...(task.delivery?.pr || {}), title, body: text } },
          pr: {
            url: result.url,
            manual: Boolean(result.manual),
            draft: body?.draft === true,
            remote: result.remote,
            pushedCommit: task.lastCommit,
            createdAt: task.pr?.createdAt || now,
            updatedAt: now
          }
        })
      );
    }

    // "Solo commit": the task ends with its commit on its branch, without a PR or a merge (e.g. one
    // of several tasks of the same branch). The worktree goes; the branch stays.
    if (url.pathname.startsWith('/api/tasks/') && url.pathname.endsWith('/finish') && req.method === 'POST') {
      const taskId = url.pathname.split('/')[3];
      const task = loadTasks(projectRoot).find((t) => t.id === taskId);
      if (!task) return sendJson(res, 404, { error: 'task not found' });
      if (!task.lastCommit) return sendJson(res, 409, { error: 'haz commit de la tarea antes de terminarla' });
      if (task.worktreePath && !worktreeIsClean(task.worktreePath))
        return sendJson(res, 409, { error: 'quedan cambios sin commitear en la tarea' });
      onTaskDeleted?.(taskId);
      let cleaned = true;
      try {
        removeTaskWorktree(projectRoot, task, { keepBranch: true });
      } catch (err) {
        cleaned = false;
        log.warn('task.cleanup_failed', { taskId, error: err.message });
      }
      log.info('task.finish', { taskId, branch: task.branch, commit: task.lastCommit });
      return sendJson(
        res,
        200,
        updateTask(projectRoot, taskId, {
          deliveredAs: 'commit',
          doneAt: new Date().toISOString(),
          ...(cleaned ? { worktreePath: null } : {})
        })
      );
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
      // Already merged: remove the worktree and the branch, like "Delete branch" after a PR.
      onTaskDeleted?.(taskId);
      let cleaned = true;
      try {
        removeTaskWorktree(projectRoot, task, { keepBranch: Boolean(task.existingBranch) });
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

    // POST /api/attachments {chatId, name, mediaType, data (base64)}: a file for the next message.
    if (url.pathname === '/api/attachments' && req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req, { maxBytes: 45 * 1024 * 1024 });
      } catch (err) {
        return sendJson(res, 413, { error: err.message });
      }
      if (!body?.chatId || !loadChat(projectRoot, body.chatId)) return sendJson(res, 404, { error: 'chat not found' });
      try {
        const a = saveAttachment(projectRoot, body.chatId, body);
        log.info('chat.attachment', { chatId: body.chatId, kind: a.kind, size: a.size });
        const { inline, ...meta } = a;
        return sendJson(res, 201, { ...meta, inline: inline !== undefined });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
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

module.exports = {
  memoryFromOutput,
  createApp
};
