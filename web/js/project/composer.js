'use strict';

// Compositor: modo chat/tarea, ramas y pestanas de chats.

// Modo del chat: "chat" es una conversacion normal; el resto convierte cada
// mensaje en una tarea con su pipeline de agentes (ver server/bridge/taskStages.js).
// "custom:<id>" lanza una tarea de una sola etapa con un agente propio.
const CHAT_KIND_LABEL = {
  coding: 'de código',
  bugfix: 'de bug',
  tests: 'de tests',
  documentation: 'de documentación',
  audit: 'de auditoría'
};
const chatKindSelect = document.getElementById('chat-kind-select');
chatKindSelect.value = localStorage.getItem('optimia:chat-kind') || 'chat';

// Rellena el selector de modo con los tipos de tarea y los agentes propios activos.
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
    if (type !== 'custom') add(tasksGroup, type, def.label);
  }
  chatKindSelect.appendChild(tasksGroup);
  const custom = data.agents.filter((a) => !a.builtin && a.enabled);
  if (custom.length) {
    const group = document.createElement('optgroup');
    group.label = 'Agentes propios';
    for (const a of custom) {
      add(group, `custom:${a.id}`, a.name);
      CHAT_KIND_LABEL[`custom:${a.id}`] = `de ${a.name}`;
    }
    chatKindSelect.appendChild(group);
  }
  const values = [...chatKindSelect.querySelectorAll('option')].map((o) => o.value);
  chatKindSelect.value = values.includes(saved) ? saved : 'chat';
  syncTaskControls();
}
const taskBaseSelect = document.getElementById('task-base-select');
const taskBranchInput = document.getElementById('task-branch-input');

async function loadTaskBranches() {
  const { current, branches } = await fetch(apiPath('/api/git/branches')).then((r) => r.json());
  const saved = localStorage.getItem('optimia:task-base');
  taskBaseSelect.innerHTML = '';
  for (const name of branches) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    taskBaseSelect.appendChild(opt);
  }
  taskBaseSelect.value = branches.includes(saved) ? saved : current;
}

// Antes de enviar: que etapas tendra la tarea y que agente y modelo hara cada una.
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
  input.placeholder = isTask
    ? 'Describe la tarea: qué quieres, criterios de aceptación, ficheros relevantes…'
    : 'Envía un mensaje o arrastra una imagen';
  renderTaskPlan();
  if (isTask) loadTaskBranches().catch(() => {});
}

taskBaseSelect.addEventListener('change', () => localStorage.setItem('optimia:task-base', taskBaseSelect.value));
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
  renderTasks();
  appendMessage(
    'system',
    `Tarea ${CHAT_KIND_LABEL[kind] || ''} lanzada: "${title}". Te avisaré aquí si necesita algo.`
  );
}

// Avisa en la conversacion cuando una tarea lanzada desde ella necesita al usuario.
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
  currentChatId = chatId;
  renderChatTabs();
  const chat = await fetch(apiPath(`/api/chats/${chatId}`)).then((r) => r.json());
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
  const list = await fetch(apiPath('/api/chats')).then((r) => r.json());
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
