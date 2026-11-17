'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const { ClaudeSession } = require('../bridge/claudeProcess');
const { listModelsAt } = require('../bridge/localAi');
const wiki = require('./wikiStore');

// Keeps the wikis up to date: after a task is committed (or delivers a report), an agent reads what
// changed and updates the project's wiki (and, rarely, the personal one). It prefers the local model
// to save cost; if there is none, or it fails (too small for the job), a cheap Claude model does it.
// One update at a time for the whole server.

const MAX_DIFF_CHARS = 24_000;
const MAX_TEXT_CHARS = 6_000;
const TIMEOUT_MS = 10 * 60 * 1000;
const WIKI_TOOLS = ['Read', 'Glob', 'Grep', 'LS', 'Edit', 'MultiEdit', 'Write'];
const NO_TOOLS = ['Bash', 'WebFetch', 'WebSearch', 'NotebookEdit', 'Task'];

const cut = (text, max) => {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max)}\n[… recortado]` : s;
};

// What the commit changed, for the prompt (the worktree may be gone by the time the job runs).
function commitSummary(dir, sha) {
  try {
    const stat = execFileSync('git', ['show', '--stat', '--format=%h %s%n%n%b', sha], {
      cwd: dir,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024
    });
    const diff = execFileSync('git', ['show', '--format=', '--unified=2', sha], {
      cwd: dir,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024
    });
    return { stat: stat.trim(), diff: cut(diff, MAX_DIFF_CHARS) };
  } catch {
    return { stat: '', diff: '' };
  }
}

function buildPrompt({ project, projectRel, task, change }) {
  const plan = task.stageOutputs?.plan || task.stageOutputs?.diagnose || task.stageOutputs?.research;
  return [
    'Etapa de MANTENIMIENTO DE LA WIKI. Trabajas en la carpeta de wikis de optimia (tu directorio actual).',
    `- Wiki del proyecto «${project}»: ${projectRel}/ (index.md es la portada; log.md el registro).`,
    '- Wiki personal del usuario: personal/ (lo que le sirve en todos sus proyectos).',
    'Acaba de terminar una tarea de los agentes. Actualiza la wiki del proyecto con lo que aporte conocimiento duradero: cómo funciona algo, decisiones y su porqué, guías de uso, convenciones, problemas resueltos y cómo se resolvieron.',
    [
      'Reglas:',
      '- Lee primero index.md y las páginas relacionadas: actualiza las existentes antes de crear nuevas. No dupliques.',
      '- Páginas cortas y concretas, en markdown, con un título "# ..." y enlaces [[Página]] entre ellas. Organízalas en carpetas si ayuda (conceptos/, decisiones/, guias/...).',
      '- Mantén index.md con la lista de páginas y una línea de resumen de cada una.',
      `- Añade al final de ${projectRel}/log.md una línea: "- <fecha> · ${task.title}: <páginas tocadas>".`,
      '- Cita la fuente (la tarea y el commit). Lo que sea suposición, márcalo como tal.',
      '- La wiki personal solo si la tarea enseña algo general y reutilizable fuera de este proyecto (una técnica, una preferencia del usuario). Casi nunca.',
      '- No copies código entero: explica y enlaza a los ficheros (ruta:línea).',
      '- Si la tarea no aporta nada que merezca quedar, solo añade la línea al log.',
      '- No uses Bash ni salgas de esta carpeta.'
    ].join('\n'),
    `Tarea (${task.type}): ${task.title}\nEncargo:\n${cut(task.instruction, MAX_TEXT_CHARS)}`,
    plan ? `Plan o diagnóstico de la tarea:\n${cut(plan, MAX_TEXT_CHARS)}` : null,
    change.report ? `Informe que entregó la tarea:\n${cut(change.report, MAX_TEXT_CHARS)}` : null,
    change.stat ? `Commit:\n${change.stat}` : null,
    change.diff ? `Diff:\n${change.diff}` : null,
    'Termina con una línea "PÁGINAS: <rutas tocadas separadas por comas>" (o "PÁGINAS: ninguna").'
  ]
    .filter(Boolean)
    .join('\n\n');
}

function parsePages(text) {
  const m = /^\s*P[ÁA]GINAS:\s*(.+)$/im.exec(String(text || ''));
  if (!m || /^ninguna/i.test(m[1].trim())) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^`|`$/g, ''))
    .filter(Boolean);
}

/**
 * Which model does the job: the local one when it is configured and answers (cheaper), otherwise
 * the wiki agent's Claude model. `preferLocal` false always uses Claude.
 */
async function pickEngine(settings, agent, { preferLocal = true, list = listModelsAt } = {}) {
  const local = settings.ai.localAi;
  if (preferLocal && local.url && local.model) {
    try {
      const models = await list(local.url, { timeoutMs: 2000 });
      if (models.some((m) => m.name === local.model)) {
        return { engine: 'local', model: local.model, baseUrl: local.url, authHeader: local.authHeader || undefined };
      }
    } catch {
      /* the local server is not running */
    }
  }
  return {
    engine: 'claude',
    model: agent?.model && agent.model !== 'default' ? agent.model : 'haiku',
    effort: agent?.effort && agent.effort !== 'default' ? agent.effort : 'low'
  };
}

function runSession({ cwd, engine, prompt, systemPrompt, Session = ClaudeSession }) {
  return new Promise((resolve) => {
    const session = new Session({
      projectRoot: cwd,
      model: engine.model,
      effort: engine.engine === 'claude' ? engine.effort : undefined,
      baseUrl: engine.baseUrl,
      authHeader: engine.authHeader,
      systemPrompt,
      strictMcpConfig: true,
      extraAllowedTools: WIKI_TOOLS,
      disallowedTools: NO_TOOLS
    });
    const timer = setTimeout(() => {
      session.kill();
      resolve({ ok: false, error: 'tiempo agotado' });
    }, TIMEOUT_MS);
    timer.unref?.();
    session.on('event', (event) => {
      if (event.type !== 'result') return;
      clearTimeout(timer);
      session.close?.();
      resolve(
        event.is_error ? { ok: false, error: String(event.result || 'error') } : { ok: true, text: event.result || '' }
      );
    });
    session.on('exit', () => {
      clearTimeout(timer);
      resolve({ ok: false, error: 'la sesión terminó sin respuesta' });
    });
    session.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
    session.send(prompt);
  });
}

let chain = Promise.resolve();

/**
 * Queues a wiki update for a task. `change`: {sha, dir} for a commit or {report} for a report-only
 * task. Resolves with {engine, model, pages, error?}.
 */
function enqueueWikiUpdate({ projectRoot, task, change, settings, agent, log, onDone, Session }) {
  const prefs = settings.wiki || {};
  if (prefs.autoUpdate === false) return Promise.resolve(null);
  const target = wiki.ensureWiki(wiki.wikiFor('project', projectRoot), projectRoot);
  wiki.ensureWiki(wiki.wikiFor('personal'));
  const detail = change.sha ? commitSummary(change.dir || projectRoot, change.sha) : {};
  const job = async () => {
    const prompt = buildPrompt({
      project: target.title,
      projectRel: path.relative(wiki.wikisDir(), target.dir).split(path.sep).join('/'),
      task,
      change: { ...change, ...detail }
    });
    const systemPrompt = agent?.prompt ? `## Tu rol: ${agent.name}\n${agent.prompt}` : undefined;
    const first = await pickEngine(settings, agent, { preferLocal: prefs.preferLocal !== false });
    let engine = first;
    let result = await runSession({ cwd: wiki.wikisDir(), engine, prompt, systemPrompt, Session });
    if (!result.ok && first.engine === 'local') {
      // The local model could not do it (too small, or it failed): a cheap Claude model takes over.
      log?.warn('wiki.local_failed', { taskId: task.id, error: result.error });
      engine = await pickEngine(settings, agent, { preferLocal: false });
      result = await runSession({ cwd: wiki.wikisDir(), engine, prompt, systemPrompt, Session });
    }
    const outcome = {
      at: new Date().toISOString(),
      engine: engine.engine,
      model: engine.model,
      pages: result.ok ? parsePages(result.text) : [],
      ...(result.ok ? {} : { error: result.error })
    };
    log?.info('wiki.update', { taskId: task.id, ...outcome });
    onDone?.({ key: target.key, ...outcome });
    return outcome;
  };
  const run = chain.then(job, job);
  chain = run.catch(() => {});
  return run;
}

module.exports = { buildPrompt, parsePages, pickEngine, enqueueWikiUpdate, commitSummary };
