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

const PHASE_LABELS = { plan: 'Plan', implement: 'Implementacion', test: 'Tests & review' };

function renderPhaseChips(task) {
  const wrap = document.createElement('div');
  wrap.className = 'task-phases';
  for (const phase of task.phases || []) {
    const chip = document.createElement('span');
    chip.className = `phase-chip phase-${phase.status}`;
    chip.textContent = PHASE_LABELS[phase.key] || phase.key;
    wrap.appendChild(chip);
  }
  return wrap;
}

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
  const res = await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
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

const STAGE_LABELS = {
  plan: 'Plan',
  research: 'Investigacion',
  implement: 'Implementacion',
  write: 'Redaccion',
  review: 'Revision final',
  commit: 'Preparar commit'
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
  const res = await fetch(`/api/tasks/${taskId}/approve`, {
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
  const res = await fetch(`/api/tasks/${taskId}/run`, {
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
  const stage = STAGE_LABELS[task.stage] || 'Agente';
  switch (task.status) {
    case 'in_progress':
      return `${stage} · ${lastStep || 'iniciando...'}`;
    case 'awaiting_input':
      return task.pendingQuestion?.kind === 'doc-options'
        ? 'investigacion lista · elige modo, formato y destino'
        : `${stage} · necesita tu respuesta para continuar`;
    case 'ready_to_test':
      return `${stage} · lista para revisar (cambios en stage, sin commitear)`;
    default:
      return task.error || 'pendiente';
  }
}

// Preguntas que puede hacer una etapa, y la etapa que se reanuda al responder.
const QUESTION_STAGE = { 'plan-details': 'plan', 'research-details': 'research', 'implement-details': 'implement' };

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
        const res = await fetch('/api/pick-file', { method: 'POST' });
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

function renderDocOptions(taskId, task) {
  const form = document.createElement('div');
  form.className = 'task-form';
  const modeKey = `${taskId}:mode`;
  const modes = [
    ['new', 'Documento nuevo'],
    ['edit', 'Editar un documento existente'],
    ['fragments', 'Trozos para anadir a un documento existente']
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
  const target = keepDraft(document.createElement('input'), `${taskId}:target`, task.docOptions?.targetPath || '');
  target.type = 'text';
  target.placeholder = 'Ruta relativa del documento (obligatoria para editar o anadir trozos)';
  form.appendChild(renderPathPicker(target));

  const format = keepDraft(document.createElement('select'), `${taskId}:format`, task.docOptions?.format || 'md');
  for (const f of ['md', 'html', 'docx']) {
    const opt = document.createElement('option');
    opt.value = f;
    opt.textContent = f;
    format.appendChild(opt);
  }
  format.value = cardDrafts.get(`${taskId}:format`) || task.docOptions?.format || 'md';
  form.appendChild(format);

  const template = keepDraft(document.createElement('input'), `${taskId}:template`, task.docOptions?.template || '');
  template.type = 'text';
  template.placeholder = 'Plantilla opcional (ruta relativa)';
  form.appendChild(renderPathPicker(template));

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
    const msg = keepDraft(document.createElement('input'), `${taskId}:commit`, `feat: ${task.title}`.slice(0, 72));
    msg.type = 'text';
    msg.className = 'task-commit-msg';
    row.appendChild(msg);
    row.appendChild(actionButton('Commit', { primary: true, onClick: () => commitTask(taskId, msg.value) }));
    box.appendChild(row);
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

async function commitTask(taskId, message) {
  const res = await fetch(`/api/tasks/${taskId}/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message })
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
  const res = await fetch(`/api/tasks/${taskId}/merge`, { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    appendMessage('system', `Fusion no realizada: ${data.error || res.status}`);
    return;
  }
  applyTaskFromServer(data);
  renderTasks();
}

function renderReadyActions(taskId) {
  const row = document.createElement('div');
  row.className = 'task-actions';
  row.appendChild(actionButton('Revision final', { onClick: () => runTaskStage(taskId, { stage: 'review' }) }));
  row.appendChild(
    actionButton('Preparar git add y commit', { onClick: () => runTaskStage(taskId, { stage: 'commit' }) })
  );
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
  const res = await fetch(`/api/tasks/${taskId}/files/open`, {
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

  fetch(`/api/tasks/${taskId}/files/preview?path=${encodeURIComponent(rel)}`)
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
        body.textContent = data.reason || 'Sin previsualizacion. Usa "Abrir con el sistema".';
      }
    })
    .catch(() => {
      body.textContent = 'No se pudo cargar la previsualizacion.';
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
  if (task.phases?.length) card.appendChild(renderPhaseChips(task));

  const step = document.createElement('div');
  step.className = 'task-step marquee-text';
  step.textContent = taskStepText(task, lastStep);
  card.appendChild(step);
  if (task.status === 'in_progress') {
    const planning = task.stage === 'plan' || task.stage === 'research';
    card.appendChild(renderOrb(!lastStep ? 'thinking' : planning ? 'planning' : 'working'));
  }

  const answerStage = task.status === 'awaiting_input' ? QUESTION_STAGE[task.pendingQuestion?.kind] : null;
  const question = answerStage ? task.pendingQuestion.text : null;
  const text = question || (ready || task.status === 'pending' ? task.output : null);
  if (text) {
    const output = document.createElement('div');
    output.className = 'task-output';
    output.textContent = text;
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
  } else if (ready) {
    card.appendChild(renderCommitAndMerge(taskId, task));
    card.appendChild(renderReadyActions(taskId));
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

function renderTasks() {
  colInProgress.innerHTML = '';
  colReadyToTest.innerHTML = '';
  for (const [taskId, { task, lastStep }] of tasks) {
    const card = buildTaskCard(taskId, task, lastStep);
    if (task.status === 'ready_to_test') colReadyToTest.appendChild(card);
    else colInProgress.appendChild(card);
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
}

async function loadInitialTasks() {
  const list = await fetch('/api/tasks').then((r) => r.json());
  for (const task of list) tasks.set(task.id, { task, lastStep: null });
  renderTasks();
}
