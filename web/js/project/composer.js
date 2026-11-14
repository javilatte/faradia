'use strict';

// Compositor: modo chat/tarea, ramas y pestanas de chats.

// Modo del chat: "chat" es una conversacion normal; "coding" y "documentation"
// convierten cada mensaje en una tarea con su flujo fijo (ver taskStages.js).
const CHAT_KIND_LABEL = { coding: 'de código', documentation: 'de documentación' };
const chatKindSelect = document.getElementById('chat-kind-select');
chatKindSelect.value = localStorage.getItem('optimia:chat-kind') || 'chat';
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

function syncTaskControls() {
  const isTask = chatKindSelect.value !== 'chat';
  for (const el of document.querySelectorAll('.task-only')) el.hidden = !isTask;
  if (isTask) loadTaskBranches().catch(() => {});
}

taskBaseSelect.addEventListener('change', () => localStorage.setItem('optimia:task-base', taskBaseSelect.value));
chatKindSelect.addEventListener('change', () => {
  localStorage.setItem('optimia:chat-kind', chatKindSelect.value);
  syncTaskControls();
});
syncTaskControls();

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
      type: kind,
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
  appendMessage('system', `Tarea ${CHAT_KIND_LABEL[kind]} lanzada: "${title}". Te avisaré aquí si necesita algo.`);
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
