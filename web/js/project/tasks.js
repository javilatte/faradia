'use strict';

// Panel de agentes: tarjetas de tareas, etapas, permisos, commit y fusion.

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

// Lo que hace cada agente de tarea, linea a linea, desde que la pestaña esta abierta.
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

// Catalogo de agentes del proyecto (GET /api/agents): etapas, pipelines y que
// agente hace cada etapa. Lo carga composer.js; hasta entonces las tarjetas
// muestran solo lo que ya se ha ejecutado.
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

// Agente que hara una etapa que aun no ha empezado (segun el mapa etapa -> agente).
function plannedAgent(task, stage) {
  if (!agentCatalog) return null;
  const id = stage === 'custom' ? task.agentId : agentCatalog.stageMap?.[stage];
  return agentCatalog.agents.find((a) => a.id === id) || null;
}

// Una fila con el pipeline de la tarea: cada etapa con su estado y el agente y
// modelo que la hizo (o que la hara). Sustituye a las fases autoinformadas y al
// rastro de agentes, que contaban lo mismo por separado.
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
    // Una etapa que preguntó y tras la que ya corrió otra quedó respondida y hecha.
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

// Respaldo hasta que llega el catalogo (las etiquetas buenas vienen del servidor).
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

// Valores de los formularios de las tarjetas, por `${taskId}:${campo}`. El
// tablero se re-renderiza en cada evento del agente; sin esto se perderia lo
// que el usuario estaba escribiendo.
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

// La respuesta HTTP de una accion y el task_updated por WebSocket pueden llegar
// en cualquier orden. La respuesta HTTP es un snapshot anterior al evento: no
// debe pisar una version mas nueva que ya estuviera en el tablero.
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

// Preguntas que puede hacer una etapa, y la etapa que se reanuda al responder.
// Las preguntas de una etapa llegan como "<etapa>-details" (ver QUESTION_KIND en taskStages.js).
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

// Acciones que la politica de agentes denego en la etapa actual: el agente siguio
// por otro camino, pero conviene saberlo (y verlo si se repite).
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

// Veredicto del verificador: una linea corta; el motivo, al desplegar.
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
  // Lo que encontro la investigacion, a mano para decidir formato y destino.
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

  // Documento nuevo: se propone docs/<titulo>.<formato>, que sigue al formato
  // mientras no escribas otra ruta.
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

function renderCommitAndMerge(taskId, task) {
  const box = document.createElement('div');
  box.className = 'task-workspace';
  if (!task.lastCommit) {
    const row = document.createElement('div');
    row.className = 'task-file';
    // La propuesta de "Preparar commit" sustituye al borrador mientras no lo edites.
    const suggestion = task.suggestedCommit || `feat: ${task.title}`.slice(0, 72);
    const draftKey = `${taskId}:commit`;
    if (cardDrafts.get(`${draftKey}:from`) !== suggestion) {
      cardDrafts.delete(draftKey);
      cardDrafts.set(`${draftKey}:from`, suggestion);
    }
    const msg = keepDraft(document.createElement('input'), draftKey, suggestion);
    msg.type = 'text';
    msg.className = 'task-commit-msg';
    msg.setAttribute('aria-label', 'Mensaje de commit');
    row.appendChild(msg);
    const ignored = task.ignoredOutputs || [];
    const picks = [];
    row.appendChild(
      actionButton('Commit', {
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
      // Git los ignora: no entran en el commit salvo que los marques.
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
  const meta = document.createElement('div');
  meta.className = 'task-meta';
  meta.textContent = `Commit ${task.lastCommit.slice(0, 7)}: ${task.lastCommitMessage || ''}`;
  box.appendChild(meta);
  if (task.mergedInto) {
    const done = document.createElement('div');
    done.className = 'task-meta';
    done.textContent = `Fusionada en ${task.mergedInto}`;
    box.appendChild(done);
  } else {
    const row = document.createElement('div');
    row.className = 'task-actions';
    row.appendChild(
      actionButton(`Fusionar en ${task.baseBranch || 'la base'}`, { primary: true, onClick: () => mergeTask(taskId) })
    );
    box.appendChild(row);
  }
  return box;
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
  if (!task?.lastCommit) {
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
        // Sin scripts ni acceso al origen: el HTML generado no puede ejecutar nada.
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
  // Tambien en curso: borrar la tarea mata su sesion de Claude (ver DELETE en server/index.js).
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
    // El veredicto ya sale arriba (renderVerification): no se repite en el informe.
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
    // Auditorias y agentes de solo lectura: entregan un informe, no hay nada que commitear.
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

// Tarea ya fusionada: no queda nada que revisar. Tarjeta compacta con el
// resultado, el commit y como verlo; el worktree y la rama ya se borraron.
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

// Quita del tablero una tarea ya fusionada (su worktree y su rama ya no existen).
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

// "Conocer el repo": la memoria propuesta se guarda con un clic (y se puede
// revisar o editar después en Ajustes > Memoria).
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

// Tablero vacío: qué hacer primero. Si el repo aún no tiene memoria, conocerlo.
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
}
