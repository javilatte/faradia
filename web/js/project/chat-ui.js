'use strict';

// Clock, layout, chat messages, attachments and Claude events.

let clockFormat = 'datetime';

function tickClock() {
  const now = new Date();
  const time = now.toLocaleTimeString(window.optimiaLang?.locale || 'es-ES', { hour: '2-digit', minute: '2-digit' });
  if (clockFormat === 'time') {
    clockEl.textContent = time;
    return;
  }
  const weekday = now.toLocaleDateString(window.optimiaLang?.locale || 'es-ES', { weekday: 'long' });
  const day = now.toLocaleDateString(window.optimiaLang?.locale || 'es-ES', { day: '2-digit', month: 'short' });
  clockEl.textContent = `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)} ${day}\u00A0\u00A0${time}`;
}

// Applies the theme and clock format. "system" removes the attribute to follow the system. Text
// that does not fit on one line scrolls side to side on hover.
const marqueeFrames = new Map();

function marqueeStart(el) {
  const max = el.scrollWidth - el.clientWidth;
  if (max <= 0 || marqueeFrames.has(el)) return;
  const duration = Math.max(900, max * 12);
  const started = performance.now();
  el.classList.add('marquee-active');
  const step = (now) => {
    if (!el.isConnected) {
      marqueeFrames.delete(el);
      return;
    }
    const t = ((now - started) / duration) % 2;
    el.scrollLeft = max * (t <= 1 ? t : 2 - t);
    marqueeFrames.set(el, requestAnimationFrame(step));
  };
  marqueeFrames.set(el, requestAnimationFrame(step));
}

function marqueeStop(el) {
  const frame = marqueeFrames.get(el);
  if (frame !== undefined) cancelAnimationFrame(frame);
  marqueeFrames.delete(el);
  el.classList.remove('marquee-active');
  el.scrollLeft = 0;
}

document.addEventListener('mouseover', (e) => {
  const el = e.target.closest?.('.marquee-text');
  if (el) marqueeStart(el);
});
document.addEventListener('mouseout', (e) => {
  const el = e.target.closest?.('.marquee-text');
  if (el && !el.contains(e.relatedTarget)) marqueeStop(el);
});

// Divider between chat and tasks: dragging changes the chat width, remembered in this browser.
const layoutEl = document.querySelector('.layout');
const layoutSplitter = document.getElementById('layout-splitter');
const chatPanelEl = document.getElementById('chat-panel');
const CHAT_MIN = 320;
const TASKS_MIN = 320;

function setChatWidth(px) {
  layoutEl.style.setProperty('--chat-w', `${Math.round(px)}px`);
}

try {
  const saved = Number(localStorage.getItem('optimia:chat-width'));
  if (saved >= CHAT_MIN) setChatWidth(saved);
} catch {
  /* no localStorage: default width */
}

layoutSplitter.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  layoutSplitter.setPointerCapture(e.pointerId);
  layoutSplitter.classList.add('dragging');
  const startX = e.clientX;
  const startWidth = chatPanelEl.getBoundingClientRect().width;
  const maxWidth = layoutEl.clientWidth - layoutSplitter.offsetWidth - TASKS_MIN - 28;
  const onMove = (ev) => setChatWidth(Math.min(maxWidth, Math.max(CHAT_MIN, startWidth + ev.clientX - startX)));
  const onUp = () => {
    layoutSplitter.classList.remove('dragging');
    layoutSplitter.removeEventListener('pointermove', onMove);
    layoutSplitter.removeEventListener('pointerup', onUp);
    try {
      localStorage.setItem('optimia:chat-width', String(Math.round(chatPanelEl.getBoundingClientRect().width)));
    } catch {
      /* no persistence */
    }
  };
  layoutSplitter.addEventListener('pointermove', onMove);
  layoutSplitter.addEventListener('pointerup', onUp);
});

layoutSplitter.addEventListener('dblclick', () => {
  layoutEl.style.removeProperty('--chat-w');
  try {
    localStorage.removeItem('optimia:chat-width');
  } catch {
    /* no persistence */
  }
});

function applyUi(ui) {
  if (ui.theme && ui.theme !== 'system') document.documentElement.dataset.theme = ui.theme;
  else delete document.documentElement.dataset.theme;
  clockFormat = ui.clock === 'time' ? 'time' : 'datetime';
  tickClock();
}
tickClock();
setInterval(tickClock, 1000 * 30);

function appendMessage(role, text, images = [], files = []) {
  chatLog.querySelector('.chat-empty')?.remove();
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  if (images.length) {
    const imgRow = document.createElement('div');
    imgRow.className = 'msg-images';
    for (const src of images) {
      const img = document.createElement('img');
      img.src = src;
      imgRow.appendChild(img);
    }
    el.appendChild(imgRow);
  }
  if (files.length) {
    const row = document.createElement('div');
    row.className = 'msg-files';
    for (const f of files) {
      const chip = document.createElement('span');
      chip.className = 'attachment-file ready';
      chip.textContent = f.name;
      row.appendChild(chip);
    }
    el.appendChild(row);
  }
  if (text) {
    const textEl = document.createElement(role === 'assistant' ? 'div' : 'span');
    textEl.className = 'msg-text';
    if (role === 'assistant') paintMarkdown(textEl, text);
    // optimia's own notices are interface text: they follow the interface's language.
    else if (role === 'system' || role === 'error') textEl.textContent = window.t ? window.t(text) : text;
    else textEl.textContent = text;
    el.appendChild(textEl);
  }
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  return el;
}

function renderAttachments() {
  attachmentsEl.innerHTML = '';
  attachmentsEl.hidden = pendingImages.length === 0 && pendingFiles.length === 0;
  for (const f of pendingFiles) {
    const chip = document.createElement('div');
    chip.className = `attachment-file ${f.status}`;
    chip.title = f.error || f.name;
    const label = document.createElement('span');
    label.textContent = `${f.name}${f.status === 'uploading' ? ' · subiendo…' : f.status === 'error' ? ' · error' : ''}`;
    const removeBtn = document.createElement('button');
    removeBtn.textContent = '✕';
    removeBtn.title = 'Quitar';
    removeBtn.addEventListener('click', () => {
      pendingFiles = pendingFiles.filter((x) => x !== f);
      renderAttachments();
    });
    chip.append(label, removeBtn);
    attachmentsEl.appendChild(chip);
  }
  pendingImages.forEach((img, idx) => {
    const thumb = document.createElement('div');
    thumb.className = 'attachment-thumb';
    const preview = document.createElement('img');
    preview.src = img.dataUrl;
    thumb.appendChild(preview);
    const removeBtn = document.createElement('button');
    removeBtn.textContent = '✕';
    removeBtn.title = 'Quitar';
    removeBtn.addEventListener('click', () => {
      pendingImages.splice(idx, 1);
      renderAttachments();
    });
    thumb.appendChild(removeBtn);
    attachmentsEl.appendChild(thumb);
  });
}

// Any file that is not an image is uploaded now, so sending does not wait (see
// server/bridge/attachments.js for how each kind reaches the context).
async function addPendingFile(file) {
  const entry = { key: Math.random(), name: file.name, status: 'uploading' };
  pendingFiles.push(entry);
  renderAttachments();
  try {
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(',') + 1));
      reader.onerror = () => reject(new Error('no se pudo leer el fichero'));
      reader.readAsDataURL(file);
    });
    const res = await fetch(apiPath('/api/attachments'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: currentChatId, name: file.name, mediaType: file.type, data })
    });
    const meta = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(meta.error || `HTTP ${res.status}`);
    Object.assign(entry, { status: 'ready', id: meta.id, kind: meta.kind });
  } catch (err) {
    Object.assign(entry, { status: 'error', error: err.message });
    appendMessage('system', `No se pudo adjuntar ${file.name}: ${err.message}`);
  }
  renderAttachments();
}

function addPendingImage(file) {
  if (!IMAGE_MIME_TYPES.has(file.type)) return addPendingFile(file);
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    const base64Data = dataUrl.slice(dataUrl.indexOf(',') + 1);
    pendingImages.push({ mediaType: file.type, base64Data, dataUrl });
    renderAttachments();
  };
  reader.readAsDataURL(file);
}

function addImageFilesFromList(fileList) {
  for (const file of fileList) addPendingImage(file);
}

input.addEventListener('paste', (e) => {
  const items = Array.from(e.clipboardData?.items || []);
  const imageItems = items.filter((item) => item.kind === 'file');
  if (!imageItems.length) return;
  e.preventDefault();
  for (const item of imageItems) {
    const file = item.getAsFile();
    if (file) addPendingImage(file);
  }
});

['dragenter', 'dragover'].forEach((eventName) => {
  chatInputArea.addEventListener(eventName, (e) => {
    e.preventDefault();
    chatInputArea.classList.add('drag-over');
  });
});

['dragleave', 'drop'].forEach((eventName) => {
  chatInputArea.addEventListener(eventName, (e) => {
    e.preventDefault();
    chatInputArea.classList.remove('drag-over');
  });
});

chatInputArea.addEventListener('drop', (e) => {
  addImageFilesFromList(e.dataTransfer?.files || []);
});

const attachInput = document.getElementById('attach-input');
document.getElementById('attach-button').addEventListener('click', () => attachInput.click());
attachInput.addEventListener('change', () => {
  addImageFilesFromList(attachInput.files || []);
  attachInput.value = '';
});

function setWaiting(isWaiting) {
  waitingForResult = isWaiting;
  const canStop = isWaiting && wsOpen && Boolean(currentChatId);
  sendButton.textContent = canStop ? 'Parar' : 'Enviar';
  sendButton.classList.toggle('stop', canStop);
  sendButton.disabled = isWaiting ? !canStop : !currentChatId || !wsOpen;
  thinkingOrb.hidden = !isWaiting;
}

function stopCurrentChat() {
  if (!currentChatId || !wsOpen) return;
  ws.send(wsPayload({ type: 'stop_chat', chatId: currentChatId }));
}

function renderAssistantEvent(event) {
  const blocks = event.message?.content || [];
  for (const block of blocks) {
    if (block.type === 'text' && block.text) {
      if (!currentAssistantBubble) currentAssistantBubble = appendMessage('assistant', block.text);
      else {
        const textEl = currentAssistantBubble.querySelector('.msg-text');
        if (textEl) paintMarkdown(textEl, `${textEl._raw || ''}\n\n${block.text}`);
        else currentAssistantBubble.textContent += block.text;
      }
    } else if (block.type === 'tool_use' && block.name === 'Agent' && !event.parent_tool_use_id) {
      // A top-level Agent call (no parent) is a new subagent the user asked
      // for. Its own tool_result arrives almost immediately as just an
      // acknowledgement that it was backgrounded, NOT its actual result —
      // so the card itself is driven entirely by the system/task_* events
      // below (task_started/task_progress/task_updated/background_tasks_
      // changed), not by this tool_use or its tool_result. This block only
      // announces the launch in the chat log.
      appendMessage('system', `→ lanzando agente: ${block.input?.description || 'Agente'}`);
    } else if (block.type === 'tool_use' && event.parent_tool_use_id) {
      // A tool call made BY a subagent (WebSearch, Bash, ToolSearch...) —
      // its progress already reaches the card via system/task_progress
      // (last_tool_name), so skip the generic chat line to avoid flooding
      // the log with another agent's internal steps.
    } else if (block.type === 'tool_use') {
      appendMessage('system', `→ usando herramienta: ${block.name}`);
    } else if (block.type === 'tool_result') {
      appendMessage('system', '✓ resultado de herramienta recibido');
    }
  }
  chatLog.scrollTop = chatLog.scrollHeight;
}

function handleClaudeEvent(event) {
  if (event.type === 'assistant') {
    renderAssistantEvent(event);
  } else if (event.type === 'system') {
    // Claude Code's own background-task bookkeeping for the Agent tool —
    // the authoritative source for whether a subagent is still running,
    // confirmed against real stream-json output (task_started carries
    // description/subagent_type, task_progress carries last_tool_name,
    // task_updated's patch.status flips to 'completed'/'failed',
    // task_notification carries the agent's actual final text answer in
    // `summary`, and background_tasks_changed gives the full live snapshot).
    let agentsChanged = false;
    if (event.subtype === 'task_started' && event.task_id) {
      if (!isAgentDismissed(currentChatId, event.task_id)) {
        chatAgents.set(event.task_id, {
          chatId: currentChatId,
          description: event.description || 'Agente',
          lastStep: 'iniciando...'
        });
        agentsChanged = true;
      }
    } else if (event.subtype === 'task_progress' && chatAgents.has(event.task_id)) {
      if (event.last_tool_name) chatAgents.get(event.task_id).lastStep = `usando ${event.last_tool_name}`;
      agentsChanged = true;
    } else if (event.subtype === 'task_updated' && event.patch?.status && event.patch.status !== 'running') {
      // Terminal status, but the agent's own task_notification (with its
      // actual output) can still be in flight — move the card to "ready to
      // review" instead of deleting it, so the user sees what it produced.
      const agent = chatAgents.get(event.task_id);
      if (agent) {
        agent.finished = true;
        agent.status = event.patch.status;
        agentsChanged = true;
      }
    } else if (event.subtype === 'task_notification' && event.task_id) {
      const agent = chatAgents.get(event.task_id);
      if (agent) {
        agent.finished = true;
        agent.status = agent.status || event.status;
        agent.summary = event.summary;
        agentsChanged = true;
      } else if (!isAgentDismissed(currentChatId, event.task_id)) {
        chatAgents.set(event.task_id, {
          chatId: currentChatId,
          description: 'Agente',
          finished: true,
          status: event.status,
          summary: event.summary
        });
        agentsChanged = true;
      }
    } else if (event.subtype === 'background_tasks_changed') {
      const liveIds = new Set((event.tasks || []).map((t) => t.task_id));
      for (const [id, agent] of chatAgents) {
        // Only reap entries nothing else is tracking — once an agent is
        // finished it stays for review until the user dismisses it, even
        // after it drops out of Claude Code's own live-task snapshot.
        if (agent.chatId === currentChatId && !agent.finished && !liveIds.has(id)) {
          chatAgents.delete(id);
          agentsChanged = true;
        }
      }
      for (const t of event.tasks || []) {
        if (!chatAgents.has(t.task_id) && !isAgentDismissed(currentChatId, t.task_id)) {
          chatAgents.set(t.task_id, {
            chatId: currentChatId,
            description: t.description || 'Agente',
            lastStep: 'iniciando...'
          });
          agentsChanged = true;
        }
      }
    }
    if (agentsChanged) renderTasks();
  } else if (event.type === 'result') {
    currentAssistantBubble = null;
    setWaiting(false);
    if (event.is_error)
      appendMessage('error', typeof event.result === 'string' ? event.result : 'Error en la sesión de Claude.');
    // NOTE: deliberately no chatAgents cleanup here. A `result` only closes
    // this turn's synchronous text reply — background agents (the whole
    // point of the Agent tool's backgrounding) keep running and report their
    // own task_progress/task_updated afterwards, sometimes across a `result`
    // boundary (confirmed against a real two-agent run: the text reply's
    // `result` arrived before one agent's `task_updated`). Wiping chatAgents
    // here used to delete cards for agents that were still genuinely
    // running. Lifecycle is owned entirely by the system/task_* handlers and
    // background_tasks_changed above, plus the terminal_handoff guard below.
  }
  // 'user' (tool_result echoes) and the remaining 'system' subtypes (init,
  // hook_started, thinking_tokens...) are diagnostic only — kept out of the
  // chat log to avoid clutter, visible in devtools.
  else {
    console.debug('[optimia] claude_event', event.type, event);
  }
}
