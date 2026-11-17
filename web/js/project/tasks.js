'use strict';

// Agents panel: task cards, stages, permissions, commit and merge.

function dismissedAgentsKey(chatId) {
  return `optimia:dismissed-agents:${chatId}`;
}
function loadDismissedAgents(chatId) {
  try {
    return new Set(JSON.parse(localStorage.getItem(dismissedAgentsKey(chatId)) || '[]'));
  } catch {
    return new Set();
  }
}
function isAgentDismissed(chatId, taskId) {
  return loadDismissedAgents(chatId).has(taskId);
}
function markAgentDismissed(chatId, taskId) {
  const ids = loadDismissedAgents(chatId);
  ids.add(taskId);
  try {
    localStorage.setItem(dismissedAgentsKey(chatId), JSON.stringify([...ids]));
  } catch {
    /* best-effort only */
  }
}

function stepLabelFor(event) {
  if (event.type === 'assistant') {
    const block = (event.message?.content || []).find((b) => b.type === 'tool_use');
    if (block) return `usando ${block.name}`;
    return 'escribiendo respuesta...';
  }
  if (event.type === 'result') return event.is_error ? 'error' : 'turno completado';
  return null;
}

// What each task agent does, line by line, since the tab was opened.
const taskLogs = new Map();
const openTaskLogs = new Set();
const TASK_LOG_MAX = 200;

function describeTaskEvent(event) {
  if (event.type === 'assistant') {
    const lines = [];
    for (const block of event.message?.content || []) {
      if (block.type === 'text' && block.text?.trim()) lines.push(block.text.trim().slice(0, 300));
      if (block.type === 'tool_use') {
        const detail =
          block.input?.command || block.input?.description || block.input?.file_path || block.input?.pattern || '';
        lines.push(`→ ${block.name}${detail ? `: ${String(detail).slice(0, 200)}` : ''}`);
      }
    }
    return lines;
  }
  if (event.type === 'result') return [event.is_error ? '— turno con error —' : '— turno completado —'];
  if (event.type === 'system' && event.subtype === 'permission_denied')
    return [`× bloqueado: ${event.tool_name || 'herramienta'}`];
  return [];
}

function logTaskEvent(taskId, event) {
  const lines = describeTaskEvent(event);
  if (!lines.length) return;
  const log = taskLogs.get(taskId) || [];
  log.push(...lines);
  if (log.length > TASK_LOG_MAX) log.splice(0, log.length - TASK_LOG_MAX);
  taskLogs.set(taskId, log);
}

// The project's agent catalog (GET /api/agents): stages, pipelines and which agent runs each stage.
// composer.js loads it; until then the cards only show what has already run.
let agentCatalog = null;

function setAgentCatalog(data) {
  agentCatalog = data;
  renderTasks();
}

function stageLabel(stage) {
  return agentCatalog?.stages?.[stage]?.label || STAGE_LABELS[stage] || stage;
}

function modelText(engine, model) {
  if (engine === 'local') return `local · ${model}`;
  return !model || model === 'default' ? 'modelo por defecto' : model;
}

// Agent that will run a stage that has not started yet (from the stage -> agent map).
function plannedAgent(task, stage) {
  if (!agentCatalog) return null;
  const id = stage === 'custom' ? task.agentId : agentCatalog.stageMap?.[stage];
  return agentCatalog.agents.find((a) => a.id === id) || null;
}

// One row with the task's pipeline: each stage with its state and the agent and model that ran it
// (or will run it). Replaces the self-reported phases and the agent trail, which told the same
// thing separately.
function renderPipeline(task) {
  const runs = task.stageRuns || [];
  const pipeline = agentCatalog?.taskTypes?.[task.type]?.pipeline || [];
  const stages = [...pipeline];
  for (const run of runs) if (!stages.includes(run.stage)) stages.push(run.stage);
  if (!stages.length) return null;
  const row = document.createElement('div');
  row.className = 'pipeline-row';
  for (const stage of stages) {
    const run = [...runs].reverse().find((r) => r.stage === stage);
    const current = task.stage === stage && task.status !== 'ready_to_test';
    let state = 'todo';
    if (run) state = run.status || 'running';
    // A stage that asked and was followed by another one was answered and is done.
    const later = run && runs.indexOf(run) < runs.length - 1;
    if (later && (state === 'asked' || state === 'running')) state = 'done';
    if (current && task.status === 'in_progress') state = 'running';
    if (current && task.status === 'awaiting_input') state = 'asked';
    const agent = run ? { name: run.agentName, engine: run.engine, model: run.model } : plannedAgent(task, stage);
    const disabled = !run && agent && agent.enabled === false;
    if (disabled) state = 'skipped';
    const chip = document.createElement('span');
    chip.className = `pipeline-step ${state}`;
    const name = document.createElement('strong');
    name.textContent = stageLabel(stage);
    chip.appendChild(name);
    if (agent) {
      const who = document.createElement('small');
      who.textContent = disabled ? 'se salta' : `${agent.name} · ${modelText(agent.engine, agent.model)}`;
      chip.appendChild(who);
    }
    const files = Number.isFinite(run?.filesTouched) ? ` · ${run.filesTouched} ficheros` : '';
    const cost = Number.isFinite(run?.costUsd) && run.costUsd > 0 ? ` · ${run.costUsd.toFixed(3)} $` : '';
    chip.title = `${PIPELINE_STATE[state] || state}${files}${cost}`;
    row.appendChild(chip);
  }
  return row;
}

const PIPELINE_STATE = {
  todo: 'Pendiente',
  running: 'En curso',
  done: 'Hecha',
  asked: 'Esperando tu respuesta',
  error: 'Falló',
  blocked: 'Detenida por acciones prohibidas',
  skipped: 'Desactivada: se salta'
};

function renderDeleteButton(onClick) {
  const btn = document.createElement('button');
  btn.className = 'card-delete-btn';
  btn.type = 'button';
  btn.textContent = '✕';
  btn.title = 'Eliminar';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return btn;
}

async function deleteRealTask(taskId) {
  const entry = tasks.get(taskId);
  if (!entry) return;
  const branch = entry.task.branch ? `\nRama: ${entry.task.branch}` : '';
  const ok = confirm(`Se borran la tarea, su worktree y sus cambios sin commitear.${branch}\n\n¿Continuar?`);
  if (!ok) return;
  const res = await fetch(apiPath(`/api/tasks/${taskId}`), { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    appendMessage('system', `No se pudo eliminar la tarea: ${data.error || res.status}`);
    return;
  }
  tasks.delete(taskId);
  renderTasks();
}

function dismissChatAgent(taskId) {
  const agent = chatAgents.get(taskId);
  if (!agent) return;
  markAgentDismissed(agent.chatId, taskId);
  chatAgents.delete(taskId);
  renderTasks();
}

// Fallback until the catalog arrives (the proper labels come from the server).
const STAGE_LABELS = {
  plan: 'Planificación',
  research: 'Investigación',
  diagnose: 'Diagnóstico',
  implement: 'Implementación',
  'write-tests': 'Tests',
  write: 'Redacción',
  verify: 'Verificación',
  audit: 'Auditoría',
  review: 'Revisión',
  commit: 'Preparar commit',
  custom: 'Agente propio'
};

// Values of the card forms, by `${taskId}:${field}`. The board re-renders on every agent event;
// without this, what the user was typing would be lost.
const cardDrafts = new Map();

function keepDraft(el, key, initial) {
  el.value = cardDrafts.has(key) ? cardDrafts.get(key) : (initial ?? '');
  const save = () => cardDrafts.set(key, el.value);
  el.addEventListener('input', save);
  el.addEventListener('change', save);
  return el;
}

function actionButton(label, { primary = false, disabled = false, onClick }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = label;
  if (primary) btn.className = 'primary';
  btn.disabled = disabled;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return btn;
}

function renderPermissionRequest(taskId, perm) {
  const box = document.createElement('div');
  box.className = 'task-permission';
  const label = document.createElement('div');
  label.textContent = perm.command
    ? `El agente quiere ejecutar: ${perm.command}`
    : `El agente quiere usar ${perm.tool}.`;
  box.appendChild(label);
  const row = document.createElement('div');
  row.className = 'task-actions';
  row.appendChild(
    actionButton('Permitir y reintentar', { primary: true, onClick: () => approveTaskPermission(taskId, perm) })
  );
  box.appendChild(row);
  return box;
}

async function approveTaskPermission(taskId, perm) {
  const res = await fetch(apiPath(`/api/tasks/${taskId}/approve`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: perm.tool, command: perm.command })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    appendMessage('system', `No se pudo aprobar el permiso: ${data.error || res.status}`);
    return;
  }
  applyTaskFromServer(data);
  renderTasks();
}

async function runTaskStage(taskId, body) {
  const res = await fetch(apiPath(`/api/tasks/${taskId}/run`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  const entry = tasks.get(taskId);
  if (!res.ok) {
    if (entry) {
      tasks.set(taskId, { ...entry, task: { ...entry.task, error: data.error || 'no se pudo lanzar la etapa' } });
      renderTasks();
    }
    return;
  }
  applyTaskFromServer(data);
  renderTasks();
}

// The HTTP response of an action and the task_updated WebSocket event can arrive in any order. The
// HTTP response is a snapshot older than the event: it must not overwrite a newer version already
// on the board.
function applyTaskFromServer(task) {
  const entry = tasks.get(task.id);
  if (entry && entry.task.updatedAt >= task.updatedAt) return;
  tasks.set(task.id, { task, lastStep: entry ? entry.lastStep : null });
}

function taskStepText(task, lastStep) {
  const stage = task.stage ? stageLabel(task.stage) : 'Agente';
  switch (task.status) {
    case 'in_progress':
      return `${stage} · ${lastStep || 'iniciando...'}`;
    case 'awaiting_input':
      return task.pendingQuestion?.kind === 'doc-options'
        ? 'investigación lista · elige modo, formato y destino'
        : `${stage} · necesita tu respuesta para continuar`;
    case 'ready_to_test':
      if (task.type === 'onboard')
        return task.memoryApplied ? 'memoria guardada' : 'memoria propuesta · revísala y guárdala';
      if (task.reportOnly) return `${stage} · informe listo (no cambia ficheros)`;
      return `${stage} · lista para revisar (cambios en stage, sin commitear)`;
    default:
      return task.error || 'pendiente';
  }
}

// Questions a stage can ask, and the stage that resumes when answered. A stage's questions arrive
// as "<stage>-details" (see QUESTION_KIND in taskStages.js).
const QUESTION_STAGE = new Proxy(
  {},
  {
    get: (_t, kind) =>
      typeof kind === 'string' && kind.endsWith('-details') ? kind.slice(0, -'-details'.length) : undefined
  }
);

const TASK_TYPE_LABEL = {
  coding: 'Código',
  bugfix: 'Bug',
  tests: 'Tests',
  documentation: 'Docs',
  audit: 'Auditoría',
  custom: 'Agente propio',
  onboard: 'Conocer el repo'
};

// Actions the agent policy denied in the current stage: the agent took another path, but it is
// worth knowing (and seeing if it repeats).
function renderBlockedCommands(task) {
  const list = (task.blockedCommands || []).filter((b) => b.stage === task.stage);
  if (!list.length || task.status !== 'in_progress') return null;
  const box = document.createElement('details');
  box.className = 'blocked-commands';
  const summary = document.createElement('summary');
  summary.textContent = `${list.length} ${list.length === 1 ? 'acción denegada' : 'acciones denegadas'} al agente (sigue por otro camino)`;
  box.appendChild(summary);
  for (const b of list) {
    const row = document.createElement('code');
    row.textContent = b.command || b.tool;
    box.appendChild(row);
  }
  return box;
}

function stripVerdict(text) {
  return text.replace(/^\s*VEREDICTO:.*$/gim, '').trim();
}

// The verifier's verdict: one short line; the reason when expanded.
function renderVerification(task) {
  if (!task.verification) return null;
  const el = document.createElement('div');
  el.className = `verification ${task.verification.ok ? 'ok' : 'fail'}`;
  if (task.verification.ok) {
    el.textContent = '✓ Verificación superada';
    return el;
  }
  const reason = task.verification.line.replace(/^\s*VEREDICTO:\s*FALLA\s*(motivo:)?\s*/i, '').trim();
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = '✗ La verificación encontró problemas';
  details.appendChild(summary);
  const body = document.createElement('div');
  body.className = 'verification-reason';
  paintMarkdown(body, reason || task.verification.line);
  details.appendChild(body);
  el.appendChild(details);
  return el;
}

function renderAnswerForm(taskId, stage) {
  const form = document.createElement('div');
  form.className = 'task-form';
  const key = `${taskId}:answer`;
  const area = keepDraft(document.createElement('textarea'), key);
  area.rows = 3;
  area.placeholder = 'Tu respuesta al agente';
  form.appendChild(area);
  form.appendChild(
    actionButton('Responder y continuar', {
      primary: true,
      onClick: () => {
        const answer = area.value.trim();
        if (!answer) return;
        cardDrafts.delete(key);
        runTaskStage(taskId, { stage, answer });
      }
    })
  );
  return form;
}

function renderPathPicker(input) {
  const row = document.createElement('div');
  row.className = 'path-picker';
  row.appendChild(input);
  row.appendChild(
    actionButton('Elegir…', {
      onClick: async () => {
        const res = await fetch(apiPath('/api/pick-file'), { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          appendMessage('system', `No se pudo abrir el explorador: ${data.error || res.status}`);
          return;
        }
        if (!data.path) return;
        input.value = data.path;
        input.dispatchEvent(new Event('change'));
      }
    })
  );
  return row;
}

// "Documenta la API REST" -> "documenta-la-api-rest"
function slugify(text) {
  return (
    String(text || 'documento')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'documento'
  );
}

function labeledField(text, control) {
  const wrap = document.createElement('label');
  wrap.className = 'form-field';
  const span = document.createElement('span');
  span.textContent = text;
  wrap.append(span, control);
  return wrap;
}

const DOC_FORMATS = [
  ['md', 'Markdown (.md)'],
  ['html', 'HTML (.html)'],
  ['docx', 'Word (.docx)']
];

function renderDocOptions(taskId, task) {
  const form = document.createElement('div');
  form.className = 'task-form';
  // What the research found, at hand to choose the format and target.
  const research = task.stageOutputs?.research;
  if (research) {
    const notes = document.createElement('details');
    notes.className = 'research-notes';
    const summary = document.createElement('summary');
    summary.textContent = 'Notas de la investigación';
    const body = document.createElement('div');
    body.className = 'task-output';
    paintMarkdown(body, research);
    notes.append(summary, body);
    form.appendChild(notes);
  }
  const modeKey = `${taskId}:mode`;
  const modes = [
    ['new', 'Documento nuevo'],
    ['edit', 'Editar un documento existente'],
    ['fragments', 'Trozos para añadir a un documento existente']
  ];
  const selectedMode = cardDrafts.get(modeKey) || task.docOptions?.mode || 'new';
  for (const [value, label] of modes) {
    const row = document.createElement('label');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = `mode-${taskId}`;
    radio.value = value;
    radio.checked = value === selectedMode;
    radio.addEventListener('change', () => cardDrafts.set(modeKey, value));
    row.appendChild(radio);
    row.appendChild(document.createTextNode(label));
    form.appendChild(row);
  }
  const format = keepDraft(document.createElement('select'), `${taskId}:format`, task.docOptions?.format || 'md');
  for (const [value, label] of DOC_FORMATS) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    format.appendChild(opt);
  }
  format.value = cardDrafts.get(`${taskId}:format`) || task.docOptions?.format || 'md';
  form.appendChild(labeledField('Formato', format));

  // New document: suggests docs/<title>.<format>, which follows the format until another path is
  // typed.
  const suggested = () => `docs/${slugify(task.title)}.${format.value}`;
  const targetKey = `${taskId}:target`;
  const target = keepDraft(document.createElement('input'), targetKey, task.docOptions?.targetPath || suggested());
  target.type = 'text';
  target.placeholder = 'Ruta relativa, p. ej. docs/api.md';
  target.setAttribute('aria-label', 'Ruta del documento');
  let lastSuggestion = target.value;
  format.addEventListener('change', () => {
    if (target.value === lastSuggestion) {
      target.value = lastSuggestion = suggested();
      cardDrafts.set(targetKey, target.value);
    }
  });
  form.appendChild(labeledField('Documento', renderPathPicker(target)));

  const template = keepDraft(document.createElement('input'), `${taskId}:template`, task.docOptions?.template || '');
  template.type = 'text';
  template.placeholder = 'Ninguna';
  template.setAttribute('aria-label', 'Plantilla');
  form.appendChild(labeledField('Plantilla (opcional)', renderPathPicker(template)));

  form.appendChild(
    actionButton('Generar', {
      primary: true,
      onClick: () => {
        const mode = (form.querySelector(`input[name="mode-${taskId}"]:checked`) || {}).value || 'new';
        runTaskStage(taskId, {
          stage: 'write',
          docOptions: {
            mode,
            format: format.value,
            targetPath: target.value.trim(),
            template: template.value.trim()
          }
        });
      }
    })
  );
  return form;
}

// How this repo delivers tasks (GET /api/git/remote): with a remote, as pull requests; without one,
// merging locally. Loaded with the project.
let repoDelivery = null;
async function loadRepoDelivery() {
  try {
    repoDelivery = await fetch(apiPath('/api/git/remote')).then((r) => r.json());
  } catch {
    repoDelivery = null;
  }
  renderTasks();
}

// Draft of an editable field that the agent may regenerate: a new generation replaces the draft;
// the user's edits survive re-renders until then.
function generatedDraft(el, key, value, stamp) {
  if (cardDrafts.get(`${key}:from`) !== stamp) {
    cardDrafts.delete(key);
    cardDrafts.set(`${key}:from`, stamp);
  }
  return keepDraft(el, key, value);
}

function renderCommitBox(taskId, task) {
  const box = document.createElement('div');
  const row = document.createElement('div');
  row.className = 'task-file';
  // The "Preparar commit" proposal replaces the draft as long as it has not been edited.
  const suggestion = task.suggestedCommit || `feat: ${task.title}`.slice(0, 72);
  const msg = generatedDraft(document.createElement('input'), `${taskId}:commit`, suggestion, suggestion);
  msg.type = 'text';
  msg.className = 'task-commit-msg';
  msg.setAttribute('aria-label', 'Mensaje de commit');
  row.appendChild(msg);
  const ignored = task.ignoredOutputs || [];
  const picks = [];
  row.appendChild(
    actionButton(task.lastCommit ? 'Commit de los cambios nuevos' : 'Commit', {
      primary: true,
      onClick: () =>
        commitTask(
          taskId,
          msg.value,
          picks.filter((p) => p.checked).map((p) => p.value)
        )
    })
  );
  box.appendChild(row);
  if (ignored.length) {
    // Git ignores them: they stay out of the commit unless ticked.
    const list = document.createElement('div');
    list.className = 'ignored-outputs';
    const note = document.createElement('div');
    note.className = 'task-meta';
    note.textContent = 'Git ignora estos ficheros generados; márcalos solo si deben ir en el commit:';
    list.appendChild(note);
    for (const f of ignored) {
      const label = document.createElement('label');
      const box2 = document.createElement('input');
      box2.type = 'checkbox';
      box2.value = f;
      picks.push(box2);
      label.append(box2, ` ${f}`);
      list.appendChild(label);
    }
    box.appendChild(list);
  }
  return box;
}

function renderCommitAndMerge(taskId, task) {
  const box = document.createElement('div');
  box.className = 'task-workspace';
  if (!task.lastCommit || task.uncommitted) {
    box.appendChild(renderCommitBox(taskId, task));
    if (!task.lastCommit) return box;
  }
  const meta = document.createElement('div');
  meta.className = 'task-meta';
  meta.textContent = `Commit ${task.lastCommit.slice(0, 7)}: ${task.lastCommitMessage || ''}`;
  box.appendChild(meta);
  if (repoDelivery?.remote) {
    box.appendChild(renderDelivery(taskId, task));
  } else if (repoDelivery) {
    // No remote: there is nowhere to open a PR, the task is merged locally.
    const note = document.createElement('div');
    note.className = 'task-meta';
    note.textContent = 'Este repo no tiene remoto: la tarea se fusiona en local.';
    const row = document.createElement('div');
    row.className = 'task-actions';
    row.appendChild(
      actionButton(`Fusionar en ${task.baseBranch || 'la base'}`, {
        primary: true,
        disabled: Boolean(task.uncommitted),
        onClick: () => mergeTask(taskId)
      })
    );
    box.append(note, row);
  }
  return box;
}

const DELIVERY_TABS = [
  ['pr', 'Pull request'],
  ['jira', 'Jira']
];
const deliverySaveTimers = new Map();

function saveDeliveryDraft(taskId, target, fields) {
  clearTimeout(deliverySaveTimers.get(`${taskId}:${target}`));
  deliverySaveTimers.set(
    `${taskId}:${target}`,
    setTimeout(() => {
      fetch(apiPath(`/api/tasks/${taskId}/delivery`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target, ...fields() })
      }).catch(() => {});
    }, 600)
  );
}

// Delivery of a committed task: the PR (title and description, generated from the task and editable)
// and, separately, the comment for the Jira ticket, which can tell more (or less) than the PR.
function renderDelivery(taskId, task) {
  const wrap = document.createElement('div');
  wrap.className = 'delivery';
  const tabKey = `${taskId}:delivery-tab`;
  const current = cardDrafts.get(tabKey) || 'pr';

  const tabs = document.createElement('div');
  tabs.className = 'segmented delivery-tabs';
  tabs.setAttribute('role', 'tablist');
  for (const [value, label] of DELIVERY_TABS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(value === current));
    b.className = value === current ? 'active' : '';
    b.textContent = label;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      cardDrafts.set(tabKey, value);
      renderTasks();
    });
    tabs.appendChild(b);
  }
  wrap.appendChild(tabs);

  const entry = task.delivery?.[current] || {};
  const stamp = entry.generatedAt || 'none';
  const generating = task.status === 'in_progress' && task.stage === 'describe';

  // Optional notes for the agent: what to leave out, what to stress, ticket number...
  const notes = keepDraft(document.createElement('input'), `${taskId}:${current}:notes`, '');
  notes.type = 'text';
  notes.className = 'delivery-notes';
  notes.placeholder =
    current === 'pr' ? 'Indicaciones (opcional): «no menciones la migración»…' : 'Indicaciones (opcional): «para QA»…';
  notes.setAttribute('aria-label', 'Indicaciones para la descripción');
  const genRow = document.createElement('div');
  genRow.className = 'task-file';
  genRow.append(
    notes,
    actionButton(generating ? 'Redactando…' : entry.body ? 'Regenerar' : 'Redactar con IA', {
      disabled: generating,
      onClick: () => runTaskStage(taskId, { stage: 'describe', describe: { target: current, notes: notes.value } })
    })
  );
  wrap.appendChild(genRow);

  if (current === 'pr') {
    const title = generatedDraft(
      document.createElement('input'),
      `${taskId}:pr:title`,
      entry.title || task.lastCommitMessage || task.title,
      stamp
    );
    title.type = 'text';
    title.className = 'task-commit-msg';
    title.setAttribute('aria-label', 'Título de la PR');
    title.placeholder = 'Título de la PR';
    const body = generatedDraft(document.createElement('textarea'), `${taskId}:pr:body`, entry.body || '', stamp);
    body.className = 'delivery-body';
    body.rows = 8;
    body.placeholder = 'Descripción de la PR (markdown). Pulsa «Redactar con IA» para generarla a partir de la tarea.';
    body.setAttribute('aria-label', 'Descripción de la PR');
    const persist = () => saveDeliveryDraft(taskId, 'pr', () => ({ title: title.value, body: body.value }));
    title.addEventListener('input', persist);
    body.addEventListener('input', persist);
    wrap.append(title, body);

    const row = document.createElement('div');
    row.className = 'task-actions';
    const { remote, gh } = repoDelivery;
    const viaGh = remote.provider === 'github' && gh;
    const draftKey = `${taskId}:pr:draft`;
    const draftLabel = document.createElement('label');
    draftLabel.className = 'check-inline';
    const draft = document.createElement('input');
    draft.type = 'checkbox';
    draft.checked = cardDrafts.get(draftKey) === true;
    draft.addEventListener('change', () => cardDrafts.set(draftKey, draft.checked));
    draftLabel.append(draft, ' Borrador');
    const pr = task.pr;
    const label = pr && !pr.manual ? 'Subir cambios y actualizar PR' : viaGh ? 'Crear PR' : 'Subir rama y abrir PR';
    row.appendChild(
      actionButton(label, {
        primary: true,
        disabled: Boolean(task.uncommitted) || generating,
        onClick: () => createPullRequest(taskId, { title: title.value, body: body.value, draft: draft.checked })
      })
    );
    if (viaGh && !pr) row.appendChild(draftLabel);
    if (pr) {
      row.appendChild(actionButton('Ver PR', { onClick: () => window.open(pr.url, '_blank', 'noopener') }));
      // The branch is already on the remote: the local worktree and branch can go.
      row.appendChild(actionButton('Archivar', { onClick: () => archiveTask(taskId) }));
    }
    wrap.appendChild(row);
    const hint = document.createElement('div');
    hint.className = 'task-meta';
    if (pr) {
      hint.textContent = pr.manual
        ? `Rama subida a ${pr.remote}. Termina de abrir la PR en el navegador.`
        : `PR ${pr.draft ? 'en borrador ' : ''}abierta en ${task.baseBranch}.`;
    } else if (remote.provider === 'github' && !gh) {
      hint.textContent =
        'Sin gh (o sin sesión): se sube la rama y se abre GitHub para crear la PR. Con «gh auth login» se crea desde aquí.';
    } else if (!viaGh) {
      hint.textContent = `Se sube la rama a ${remote.name} y se abre la página para crear la PR.`;
    } else {
      hint.textContent = `Se sube la rama ${task.branch} a ${remote.name} y se abre la PR contra ${task.baseBranch}.`;
    }
    wrap.appendChild(hint);
  } else {
    const body = generatedDraft(document.createElement('textarea'), `${taskId}:jira:body`, entry.body || '', stamp);
    body.className = 'delivery-body';
    body.rows = 8;
    body.placeholder =
      'Comentario para el ticket de Jira: qué se hizo, cómo probarlo y lo pendiente. Pulsa «Redactar con IA» para generarlo.';
    body.setAttribute('aria-label', 'Comentario para Jira');
    body.addEventListener('input', () => saveDeliveryDraft(taskId, 'jira', () => ({ body: body.value })));
    wrap.appendChild(body);
    const row = document.createElement('div');
    row.className = 'task-actions';
    row.appendChild(
      actionButton('Copiar', {
        primary: true,
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(body.value);
            appendMessage('system', 'Comentario de Jira copiado: pégalo en el ticket.');
          } catch {
            body.select();
            appendMessage('system', 'No se pudo copiar automáticamente: el texto queda seleccionado (Ctrl/⌘+C).');
          }
        }
      })
    );
    wrap.appendChild(row);
  }
  return wrap;
}

async function createPullRequest(taskId, { title, body, draft }) {
  const res = await fetch(apiPath(`/api/tasks/${taskId}/pull-request`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body, draft })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    appendMessage('system', `PR no creada: ${data.error || res.status}`);
    return;
  }
  applyTaskFromServer(data);
  renderTasks();
  if (data.pr?.url) {
    appendMessage('system', `${data.pr.manual ? 'Rama subida. Abre la PR' : 'PR lista'}: ${data.pr.url}`);
    if (data.pr.manual) window.open(data.pr.url, '_blank', 'noopener');
  }
}

async function commitTask(taskId, message, includeIgnored = []) {
  const res = await fetch(apiPath(`/api/tasks/${taskId}/commit`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, includeIgnored })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    appendMessage('system', `Commit no realizado: ${data.error || res.status}`);
    return;
  }
  applyTaskFromServer(data);
  renderTasks();
}

async function mergeTask(taskId) {
  const res = await fetch(apiPath(`/api/tasks/${taskId}/merge`), { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    appendMessage('system', `Fusión no realizada: ${data.error || res.status}`);
    return;
  }
  applyTaskFromServer(data);
  renderTasks();
}

function renderReadyActions(taskId, task) {
  const row = document.createElement('div');
  row.className = 'task-actions';
  if (task && ['coding', 'bugfix', 'tests'].includes(task.type)) {
    row.appendChild(actionButton('Verificar otra vez', { onClick: () => runTaskStage(taskId, { stage: 'verify' }) }));
  }
  row.appendChild(actionButton('Revisión final', { onClick: () => runTaskStage(taskId, { stage: 'review' }) }));
  if (!task?.lastCommit || task.uncommitted) {
    row.appendChild(
      actionButton('Proponer mensaje de commit', { onClick: () => runTaskStage(taskId, { stage: 'commit' }) })
    );
  }
  return row;
}

const ORB_LABELS = { planning: 'Planificando…', working: 'Trabajando…', thinking: 'Pensando…' };

function renderOrb(state) {
  const row = document.createElement('div');
  row.className = `agent-orb ${state}`;
  const orb = document.createElement('span');
  orb.className = 'orb';
  const label = document.createElement('span');
  label.textContent = ORB_LABELS[state];
  row.append(orb, label);
  return row;
}

function renderTaskWorkspace(taskId, task) {
  const box = document.createElement('div');
  box.className = 'task-workspace';
  if (task.branch) {
    const meta = document.createElement('div');
    meta.className = 'task-meta';
    meta.textContent = `Rama: ${task.branch}${task.baseBranch ? ` · base: ${task.baseBranch}` : ''}`;
    box.appendChild(meta);
  }
  const files = task.outputFiles || [];
  if (files.length) {
    const title = document.createElement('div');
    title.className = 'task-meta';
    title.textContent = 'Ficheros generados (incluidos los ignorados por git):';
    box.appendChild(title);
    for (const rel of files) {
      const row = document.createElement('div');
      row.className = 'task-file';
      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'task-file-name marquee-text';
      name.textContent = rel;
      name.title = 'Abrir con la aplicacion del sistema';
      name.addEventListener('click', (e) => {
        e.stopPropagation();
        openTaskFile(taskId, rel, false);
      });
      row.appendChild(name);
      row.appendChild(actionButton('Ver', { onClick: () => openFilePreview(taskId, rel) }));
      row.appendChild(actionButton('Carpeta', { onClick: () => openTaskFile(taskId, rel, true) }));
      box.appendChild(row);
    }
  }
  const logRow = document.createElement('div');
  logRow.className = 'task-actions';
  const open = openTaskLogs.has(taskId);
  logRow.appendChild(
    actionButton(open ? 'Ocultar registro' : 'Ver registro del agente', {
      onClick: () => {
        if (open) openTaskLogs.delete(taskId);
        else openTaskLogs.add(taskId);
        renderTasks();
      }
    })
  );
  box.appendChild(logRow);
  if (open) {
    const log = document.createElement('pre');
    log.className = 'task-log';
    const lines = taskLogs.get(taskId) || [];
    log.textContent = lines.length ? lines.join('\n') : 'Sin actividad registrada desde que abriste esta pestaña.';
    box.appendChild(log);
  }
  return box;
}

async function openTaskFile(taskId, rel, reveal) {
  const res = await fetch(apiPath(`/api/tasks/${taskId}/files/open`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: rel, reveal })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) appendMessage('system', `No se pudo abrir ${rel}: ${data.error || res.status}`);
}

function openFilePreview(taskId, rel) {
  const overlay = document.createElement('div');
  overlay.className = 'file-preview-overlay';
  const panel = document.createElement('div');
  panel.className = 'file-preview';
  const head = document.createElement('div');
  head.className = 'file-preview-head';
  const title = document.createElement('span');
  title.textContent = rel;
  head.appendChild(title);
  head.appendChild(actionButton('Abrir con el sistema', { onClick: () => openTaskFile(taskId, rel, false) }));
  head.appendChild(actionButton('Cerrar', { onClick: () => overlay.remove() }));
  const body = document.createElement('div');
  body.className = 'file-preview-body';
  body.textContent = 'Cargando...';
  panel.append(head, body);
  overlay.appendChild(panel);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  document.body.appendChild(overlay);

  fetch(apiPath(`/api/tasks/${taskId}/files/preview?path=${encodeURIComponent(rel)}`))
    .then((r) => r.json())
    .then((data) => {
      body.textContent = '';
      if (data.error) {
        body.textContent = data.error;
        return;
      }
      if (data.kind === 'text') {
        const pre = document.createElement('pre');
        pre.textContent = data.content;
        body.appendChild(pre);
      } else if (data.kind === 'html') {
        // No scripts and no access to the origin: the generated HTML cannot run anything.
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', '');
        frame.srcdoc = data.content;
        body.appendChild(frame);
      } else {
        body.textContent = data.reason || 'Sin previsualización. Usa "Abrir con el sistema".';
      }
    })
    .catch(() => {
      body.textContent = 'No se pudo cargar la previsualización.';
    });
}

function buildTaskCard(taskId, task, lastStep) {
  const ready = task.status === 'ready_to_test';
  const card = document.createElement('div');
  card.className = 'task-card' + (ready ? ' ready' : '') + (task.status === 'awaiting_input' ? ' awaiting' : '');
  // Also while running: deleting the task kills its Claude session (see DELETE in server/index.js).
  card.appendChild(renderDeleteButton(() => deleteRealTask(taskId)));

  const title = document.createElement('div');
  title.className = 'task-title marquee-text';
  title.textContent = task.title;
  card.appendChild(title);
  if (task.type && TASK_TYPE_LABEL[task.type]) {
    const badge = document.createElement('span');
    badge.className = `task-type-badge type-${task.type}`;
    badge.textContent = TASK_TYPE_LABEL[task.type];
    card.appendChild(badge);
  }
  const pipeline = renderPipeline(task);
  if (pipeline) card.appendChild(pipeline);
  const blocked = renderBlockedCommands(task);
  if (blocked) card.appendChild(blocked);
  const verification = renderVerification(task);
  if (verification) card.appendChild(verification);

  const step = document.createElement('div');
  step.className = 'task-step marquee-text';
  step.textContent = taskStepText(task, lastStep);
  card.appendChild(step);
  if (task.status === 'in_progress') {
    const planning = ['plan', 'research', 'diagnose', 'audit'].includes(task.stage);
    card.appendChild(renderOrb(!lastStep ? 'thinking' : planning ? 'planning' : 'working'));
  }

  const answerStage = task.status === 'awaiting_input' ? QUESTION_STAGE[task.pendingQuestion?.kind] : null;
  const question = answerStage ? task.pendingQuestion.text : null;
  const text = question || (ready || task.status === 'pending' ? task.output : null);
  if (text) {
    const output = document.createElement('div');
    output.className = 'task-output';
    // The verdict is already shown above (renderVerification): not repeated in the report.
    paintMarkdown(output, task.verification ? stripVerdict(text) : text);
    card.appendChild(output);
  }
  if (task.error) {
    const err = document.createElement('div');
    err.className = 'task-error';
    err.textContent = task.error;
    card.appendChild(err);
  }

  card.appendChild(renderTaskWorkspace(taskId, task));

  if (answerStage) {
    card.appendChild(renderAnswerForm(taskId, answerStage));
  } else if (task.status === 'awaiting_input' && task.pendingQuestion?.kind === 'doc-options') {
    card.appendChild(renderDocOptions(taskId, task));
  } else if (ready && task.type === 'onboard') {
    card.appendChild(renderMemoryProposal(taskId, task));
  } else if (ready && task.reportOnly) {
    // Audits and read-only agents: they deliver a report, there is nothing to commit.
    const note = document.createElement('div');
    note.className = 'task-meta';
    note.textContent = 'Informe entregado: esta tarea no cambia ficheros.';
    card.appendChild(note);
  } else if (ready) {
    card.appendChild(renderCommitAndMerge(taskId, task));
    card.appendChild(renderReadyActions(taskId, task));
  } else if (task.status === 'pending' && task.pendingPermission) {
    card.appendChild(renderPermissionRequest(taskId, task.pendingPermission));
  } else if (task.status === 'pending' && task.stage) {
    const row = document.createElement('div');
    row.className = 'task-actions';
    row.appendChild(actionButton('Reintentar etapa', { onClick: () => runTaskStage(taskId, { stage: task.stage }) }));
    card.appendChild(row);
  }
  return card;
}

// Task already merged: nothing left to review. Compact card with the result, the commit and how to
// see it; the worktree and the branch are already gone.
function buildDoneCard(taskId, task) {
  const card = document.createElement('div');
  card.className = 'task-card done-card';
  const title = document.createElement('div');
  title.className = 'task-title marquee-text';
  title.textContent = task.title;
  card.appendChild(title);
  const pipeline = renderPipeline(task);
  if (pipeline) card.appendChild(pipeline);
  const meta = document.createElement('div');
  meta.className = 'task-meta';
  const how = task.fastForward === false ? 'con commit de merge' : 'en línea (fast-forward)';
  meta.textContent = `✓ Fusionada en ${task.mergedInto} ${how} · ${task.lastCommitMessage || ''}`;
  card.appendChild(meta);
  if (task.mergedFiles?.length) {
    const files = document.createElement('div');
    files.className = 'task-meta';
    const n = task.mergedFiles.length;
    files.textContent = `${n} ${n === 1 ? 'fichero' : 'ficheros'}: ${task.mergedFiles.slice(0, 6).join(', ')}${n > 6 ? '…' : ''}`;
    card.appendChild(files);
  }
  const row = document.createElement('div');
  row.className = 'task-actions';
  if (task.lastCommit && window.optimiaOpenCommit) {
    row.appendChild(
      actionButton('Ver cambios', {
        onClick: () => window.optimiaOpenCommit(currentProjectId || defaultProjectId, task.lastCommit)
      })
    );
  }
  row.appendChild(actionButton('Archivar', { onClick: () => archiveTask(taskId) }));
  card.appendChild(row);
  return card;
}

// Removes a merged task from the board (its worktree and branch no longer exist).
async function archiveTask(taskId) {
  const res = await fetch(apiPath(`/api/tasks/${taskId}`), { method: 'DELETE' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    appendMessage('system', `No se pudo archivar la tarea: ${data.error || res.status}`);
    return;
  }
  tasks.delete(taskId);
  renderTasks();
}

// "Conocer el repo": the proposed memory is saved with one click (and can be reviewed or edited
// later in Settings > Memory).
function renderMemoryProposal(taskId, task) {
  const row = document.createElement('div');
  row.className = 'task-actions';
  if (task.memoryApplied) {
    const done = document.createElement('div');
    done.className = 'task-meta memory-applied';
    done.textContent = '✓ Guardada como memoria de este repo';
    row.appendChild(done);
    row.appendChild(actionButton('Editar memoria…', { onClick: () => openSettingsPane('memory') }));
    row.appendChild(actionButton('Archivar', { onClick: () => archiveTask(taskId) }));
    return row;
  }
  row.appendChild(
    actionButton('Guardar como memoria del repo', {
      primary: true,
      onClick: async () => {
        const res = await fetch(apiPath(`/api/tasks/${taskId}/apply-memory`), { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          appendMessage('system', `No se pudo guardar la memoria: ${data.error || res.status}`);
          return;
        }
        memoryKnown = true;
        applyTaskFromServer(data);
        renderTasks();
        appendMessage('system', 'Memoria del repo guardada: el chat y los agentes la reciben desde la próxima sesión.');
      }
    })
  );
  row.appendChild(actionButton('Descartar', { onClick: () => archiveTask(taskId) }));
  return row;
}

// Empty board: what to do first. If the repo has no memory yet, learn it.
let memoryKnown = null;
function renderEmptyBoard() {
  const box = document.createElement('div');
  box.className = 'board-empty';
  const title = document.createElement('div');
  title.className = 'board-empty-title';
  const text = document.createElement('div');
  text.className = 'muted';
  if (memoryKnown === false) {
    title.textContent = 'Este repo aún no tiene memoria';
    text.textContent =
      'Deja que un agente lo estudie (comandos, estructura, convenciones) para que el chat y los agentes trabajen aquí sin redescubrirlo.';
    box.append(title, text, actionButton('Conocer este repo…', { primary: true, onClick: () => startOnboarding() }));
  } else {
    title.textContent = 'Sin tareas';
    text.textContent =
      'Elige un modo en el chat (Código, Bug, Tests, Documentación…) y describe lo que quieres: verás qué agente y modelo hará cada etapa antes de enviarlo.';
    box.append(title, text);
  }
  return box;
}

async function refreshMemoryKnown() {
  try {
    const { content } = await fetch(apiPath('/api/memory')).then((r) => r.json());
    memoryKnown = Boolean(content && content.trim());
  } catch {
    memoryKnown = null;
  }
  renderTasks();
}

function renderTasks() {
  colInProgress.innerHTML = '';
  colReadyToTest.innerHTML = '';
  const done = [];
  for (const [taskId, { task, lastStep }] of tasks) {
    if (task.mergedInto) {
      done.push(buildDoneCard(taskId, task));
      continue;
    }
    const card = buildTaskCard(taskId, task, lastStep);
    if (task.status === 'ready_to_test') colReadyToTest.appendChild(card);
    else colInProgress.appendChild(card);
  }
  if (done.length) {
    const group = document.createElement('details');
    group.className = 'done-group';
    group.open = localStorage.getItem('optimia:done-open') === '1';
    group.addEventListener('toggle', () => localStorage.setItem('optimia:done-open', group.open ? '1' : '0'));
    const summary = document.createElement('summary');
    summary.textContent = `Hechas (${done.length})`;
    group.appendChild(summary);
    for (const card of done.reverse()) group.appendChild(card);
    colReadyToTest.appendChild(group);
  }
  for (const [taskId, agent] of chatAgents) {
    if (agent.chatId !== currentChatId) continue;
    const card = document.createElement('div');
    card.className =
      'task-card chat-agent-card' + (agent.interrupted ? ' interrupted' : '') + (agent.finished ? ' ready' : '');
    if (agent.finished) card.appendChild(renderDeleteButton(() => dismissChatAgent(taskId)));
    const title = document.createElement('div');
    title.className = 'task-title marquee-text';
    title.textContent = agent.description;
    card.appendChild(title);
    const step = document.createElement('div');
    step.className = 'task-step marquee-text';
    step.textContent = agent.finished
      ? agent.status === 'failed'
        ? 'agente de chat · fallido'
        : 'agente de chat · completado'
      : agent.interrupted
        ? 'interrumpido · necesita permiso en la terminal'
        : `agente de chat · ${agent.lastStep || 'iniciando...'}`;
    card.appendChild(step);
    if (!agent.finished && !agent.interrupted) card.appendChild(renderOrb(agent.lastStep ? 'working' : 'thinking'));
    if (agent.finished) {
      const output = document.createElement('div');
      output.className = 'task-output';
      output.textContent = agent.summary || 'El agente no devolvio un resumen de texto.';
      card.appendChild(output);
    }
    if (agent.finished) colReadyToTest.appendChild(card);
    else colInProgress.appendChild(card);
  }
  const hasChatAgents = [...chatAgents.values()].some((a) => a.chatId === currentChatId);
  if (!tasks.size && !hasChatAgents) colInProgress.appendChild(renderEmptyBoard());
}

async function loadInitialTasks() {
  const list = await fetch(apiPath('/api/tasks')).then((r) => r.json());
  for (const task of list) tasks.set(task.id, { task, lastStep: null });
  renderTasks();
  refreshMemoryKnown();
  loadRepoDelivery();
}
