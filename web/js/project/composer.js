'use strict';

// Composer: chat/task mode, branches and chat tabs.

// Chat mode: "chat" is a normal conversation; every other mode turns each message into a task with
// its agent pipeline (see server/bridge/taskStages.js). "custom:<id>" starts a single-stage task
// with a custom agent.
const CHAT_KIND_LABEL = {
  coding: 'de código',
  bugfix: 'de bug',
  tests: 'de tests',
  documentation: 'de documentación',
  audit: 'de auditoría'
};
const chatKindSelect = document.getElementById('chat-kind-select');
chatKindSelect.value = localStorage.getItem('optimia:chat-kind') || 'chat';

// Fills the mode selector with the task types and the enabled custom agents.
async function loadTaskKinds() {
  const data = await fetch(apiPath('/api/agents')).then((r) => r.json());
  setAgentCatalog(data);
  const saved = localStorage.getItem('optimia:chat-kind') || 'chat';
  chatKindSelect.innerHTML = '';
  const add = (parent, value, label) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    parent.appendChild(opt);
  };
  add(chatKindSelect, 'chat', 'Chat');
  const tasksGroup = document.createElement('optgroup');
  tasksGroup.label = 'Tarea para agentes';
  for (const [type, def] of Object.entries(data.taskTypes)) {
    if (type !== 'custom' && !def.internal) add(tasksGroup, type, def.label);
  }
  chatKindSelect.appendChild(tasksGroup);
  // Agents that run on their own: the user's and the ECC ones turned on (any agent can also be
  // called with @ in the message box).
  const groups = [
    ['Agentes propios', data.agents.filter((a) => (a.source === 'global' || a.source === 'project') && a.enabled)],
    ['Agentes de ECC', data.agents.filter((a) => a.source === 'ecc' && a.enabled)]
  ];
  for (const [label, list] of groups) {
    if (!list.length) continue;
    const group = document.createElement('optgroup');
    group.label = label;
    for (const a of list) {
      add(group, `custom:${a.id}`, a.name);
      CHAT_KIND_LABEL[`custom:${a.id}`] = `de ${a.name}`;
    }
    chatKindSelect.appendChild(group);
  }
  // A builtin agent picked with @ runs alone too.
  for (const a of data.agents.filter((x) => x.source === 'builtin')) CHAT_KIND_LABEL[`custom:${a.id}`] = `de ${a.name}`;
  const values = [...chatKindSelect.querySelectorAll('option')].map((o) => o.value);
  chatKindSelect.value = values.includes(saved) ? saved : 'chat';
  syncTaskControls();
}
const taskBaseSelect = document.getElementById('task-base-select');
const taskBranchInput = document.getElementById('task-branch-input');

async function loadTaskBranches() {
  const { current, branches } = await fetch(apiPath('/api/git/branches')).then((r) => r.json());
  const saved = localStorage.getItem(taskBaseKey());
  taskBaseSelect.innerHTML = '';
  for (const name of branches) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    taskBaseSelect.appendChild(opt);
  }
  taskBaseSelect.value = branches.includes(saved) ? saved : current;
  // Existing branches can be picked as the task's branch: the task adds its commits to it.
  document
    .getElementById('task-branch-options')
    .replaceChildren(...branches.map((name) => Object.assign(document.createElement('option'), { value: name })));
  taskBranches = branches;
  syncBranchHint();
}

// With an existing branch, "Desde" does not apply: the task continues that branch.
let taskBranches = [];
function syncBranchHint() {
  const existing = taskBranches.includes(taskBranchInput.value.trim());
  taskBaseSelect.disabled = existing;
  taskBaseSelect.title = existing
    ? 'La tarea continúa la rama existente elegida en «Rama»'
    : 'Rama base de la que sale la tarea';
}
taskBranchInput.addEventListener('input', syncBranchHint);

// Before sending: which stages the task will have and which agent and model will run each one.
const taskPlanRow = document.getElementById('task-plan-row');
function renderTaskPlan() {
  taskPlanRow.replaceChildren();
  const kind = chatKindSelect.value;
  if (kind === 'chat' || !agentCatalog) return;
  const type = kind.startsWith('custom:') ? 'custom' : kind;
  const fake = { type, agentId: kind.startsWith('custom:') ? kind.slice('custom:'.length) : null };
  const pipeline = agentCatalog.taskTypes?.[type]?.pipeline || [];
  pipeline.forEach((stage, i) => {
    if (i) {
      const arrow = document.createElement('span');
      arrow.className = 'plan-arrow';
      arrow.textContent = '→';
      taskPlanRow.appendChild(arrow);
    }
    const agent = plannedAgent(fake, stage);
    const step = document.createElement('span');
    step.className = 'plan-step' + (agent && agent.enabled === false ? ' skipped' : '');
    const b = document.createElement('b');
    b.textContent = stageLabel(stage);
    step.appendChild(b);
    if (agent) step.append(` ${agent.name} · ${modelText(agent.engine, agent.model)}`);
    step.title = agent?.enabled === false ? 'Agente desactivado: la etapa se salta' : agent?.description || '';
    taskPlanRow.appendChild(step);
  });
  const change = document.createElement('button');
  change.type = 'button';
  change.className = 'link';
  change.textContent = 'Cambiar agentes';
  change.addEventListener('click', () => openSettingsPane('agents'));
  taskPlanRow.appendChild(change);
}

function syncTaskControls() {
  const isTask = chatKindSelect.value !== 'chat';
  for (const el of document.querySelectorAll('.task-only')) el.hidden = !isTask;
  for (const el of document.querySelectorAll('.chat-only')) el.hidden = isTask;
  // Effort is a Claude setting: local models ignore it.
  document.getElementById('chat-effort-field').hidden = isTask || chatModelSelect.value.startsWith('local:');
  input.placeholder = isTask
    ? 'Describe la tarea: qué quieres, criterios de aceptación, ficheros relevantes…'
    : 'Envía un mensaje o arrastra una imagen';
  renderTaskPlan();
  if (isTask) loadTaskBranches().catch(() => {});
}

// The base branch chosen last, per repo: "develop" in one repo says nothing about another.
function taskBaseKey() {
  return `optimia:task-base:${currentProjectId || defaultProjectId || 'default'}`;
}
taskBaseSelect.addEventListener('change', () => localStorage.setItem(taskBaseKey(), taskBaseSelect.value));
chatKindSelect.addEventListener('change', () => {
  localStorage.setItem('optimia:chat-kind', chatKindSelect.value);
  syncTaskControls();
});
syncTaskControls();
loadTaskKinds().catch(() => {});

async function createTaskFromChat(kind, text) {
  if (!currentChatId) return;
  if (!text) return;
  if (pendingImages.length > 0) {
    appendMessage('system', 'Las tareas todavía no admiten imágenes. Quítalas o cambia el modo a Chat.');
    return;
  }
  const title = text.split('\n')[0].slice(0, 80);
  input.value = '';
  input.style.height = 'auto';
  const res = await fetch(apiPath('/api/tasks'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title,
      type: kind.startsWith('custom:') ? 'custom' : kind,
      agentId: kind.startsWith('custom:') ? kind.slice('custom:'.length) : undefined,
      instruction: text,
      chatId: currentChatId,
      baseBranch: taskBaseSelect.value || undefined,
      branchName: taskBranchInput.value.trim() || undefined
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    appendMessage('system', `No se pudo lanzar la tarea: ${data.error || res.status}`);
    return;
  }
  applyTaskFromServer(data);
  taskBranchInput.value = '';
  syncBranchHint();
  renderTasks();
  appendMessage(
    'system',
    `Tarea ${CHAT_KIND_LABEL[kind] || ''} lanzada: "${title}". Te avisaré aquí si necesita algo.`
  );
}

// Tells the conversation when a task started from it needs the user.
function notifyTaskInChat(task, prevStatus) {
  if (!task.chatId || task.chatId !== currentChatId || prevStatus === task.status) return;
  if (task.status === 'awaiting_input') {
    const q = task.pendingQuestion;
    if (q?.kind === 'doc-options') {
      appendMessage(
        'system',
        `"${task.title}": la investigación está lista. Elige modo, formato y destino en el panel de agentes.`
      );
    } else {
      appendMessage('system', `"${task.title}" necesita tu respuesta. Contéstala en su tarjeta del panel de agentes.`);
    }
  } else if (task.status === 'ready_to_test') {
    appendMessage('system', `"${task.title}" está lista para revisar y ship en el panel de agentes.`);
  } else if (task.status === 'pending' && task.error) {
    appendMessage('system', `"${task.title}" se detuvo: ${task.error}`);
  }
}

function sendCurrentInput() {
  const text = input.value.trim();
  if (chatKindSelect.value !== 'chat') return createTaskFromChat(chatKindSelect.value, text);
  if ((!text && pendingImages.length === 0) || !currentChatId || !wsOpen || waitingForResult) return;
  const images = pendingImages.map(({ mediaType, base64Data }) => ({ mediaType, base64Data }));
  const previewUrls = pendingImages.map((img) => img.dataUrl);
  appendMessage('user', text, previewUrls);
  ws.send(wsPayload({ type: 'user_message', chatId: currentChatId, text, images }));
  input.value = '';
  input.style.height = 'auto';
  pendingImages = [];
  renderAttachments();
  setWaiting(true);
}

function renderChatTabs() {
  chatTabs.querySelectorAll('.chat-tab').forEach((el) => el.remove());
  const metas = Array.from(chatsMeta.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const meta of metas) {
    const btn = document.createElement('button');
    btn.className = 'chat-tab' + (meta.id === currentChatId ? ' active' : '');
    btn.title = meta.title || 'Chat';
    btn.addEventListener('click', () => selectChat(meta.id));

    const label = document.createElement('span');
    label.className = 'chat-tab-label';
    label.textContent = meta.title || 'Chat';
    btn.appendChild(label);

    const closeBtn = document.createElement('span');
    closeBtn.className = 'chat-tab-close';
    closeBtn.textContent = '×';
    closeBtn.title = 'Eliminar chat';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteChat(meta.id);
    });
    btn.appendChild(closeBtn);

    chatTabs.insertBefore(btn, chatNewButton);
  }
}

async function deleteChat(chatId) {
  await fetch(apiPath(`/api/chats/${chatId}`), { method: 'DELETE' });
  chatsMeta.delete(chatId);
  if (chatId === currentChatId) {
    const next = Array.from(chatsMeta.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (next) {
      await selectChat(next.id);
    } else {
      await createAndSelectChat();
    }
  } else {
    renderChatTabs();
  }
}

// Replays a chat's persisted transcript through the exact same renderer used
// for live events, so there is only one code path for "what a message looks
// like" — recovering from a refresh is just feeding history through it.
function replayChat(chat) {
  chatLog.innerHTML = '';
  currentAssistantBubble = null;
  for (const m of chat.messages) {
    if (m.role === 'user') {
      const previews = (m.images || []).map((img) => `data:${img.mediaType};base64,${img.base64Data}`);
      appendMessage('user', m.text, previews);
    } else if (m.role === 'claude_event') {
      handleClaudeEvent(m.event);
    }
  }
}

async function selectChat(chatId) {
  const pid = currentProjectId;
  currentChatId = chatId;
  renderChatTabs();
  const chat = await fetch(apiPath(`/api/chats/${chatId}`)).then((r) => r.json());
  if (pid !== currentProjectId || chatId !== currentChatId) return;
  replayChat(chat);
  setWaiting(false);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(wsPayload({ type: 'subscribe', chatId }));
  }
}

async function createAndSelectChat() {
  const chat = await fetch(apiPath('/api/chats'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  }).then((r) => r.json());
  chatsMeta.set(chat.id, chat);
  await selectChat(chat.id);
}

async function loadInitialChats() {
  const pid = currentProjectId;
  const list = await fetch(apiPath('/api/chats')).then((r) => r.json());
  if (pid !== currentProjectId) return;
  chatsMeta.clear();
  for (const meta of list) chatsMeta.set(meta.id, meta);
  const mostRecent = list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (mostRecent) {
    await selectChat(mostRecent.id);
  } else {
    await createAndSelectChat();
  }
}

chatNewButton.addEventListener('click', () => {
  createAndSelectChat();
});

sendButton.addEventListener('click', () => (waitingForResult ? stopCurrentChat() : sendCurrentInput()));
