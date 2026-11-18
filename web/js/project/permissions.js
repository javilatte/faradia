'use strict';

// Permission cards in the chat: when the agent needs to run a command or touch something that asks
// for permission, the conversation shows what it wants to do and waits for the answer here
// (Permitir / Permitir siempre en este repo / Denegar). Nothing jumps to the terminal.

const permissionCards = new Map(); // requestId -> element

const TOOL_VERB = {
  Bash: 'ejecutar un comando',
  Edit: 'editar un fichero',
  MultiEdit: 'editar un fichero',
  Write: 'crear o reescribir un fichero',
  NotebookEdit: 'editar un notebook',
  WebFetch: 'abrir una página web',
  WebSearch: 'buscar en la web'
};

function permissionText(request) {
  const verb = TOOL_VERB[request.toolName] || `usar ${request.toolName}`;
  return `El agente quiere ${verb}`;
}

function sendPermission(requestId, decision) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(wsPayload({ type: 'permission_response', chatId: currentChatId, requestId, decision }));
}

function showPermissionRequest(request) {
  if (permissionCards.has(request.requestId)) return;
  chatLog.querySelector('.chat-empty')?.remove();
  const card = document.createElement('div');
  card.className = 'permission-card';
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', 'Permiso pendiente');
  const title = document.createElement('div');
  title.className = 'permission-title';
  title.textContent = permissionText(request);
  card.appendChild(title);
  const detail = request.command || request.path || request.url;
  if (detail) {
    const pre = document.createElement('pre');
    pre.className = 'permission-detail';
    pre.textContent = detail;
    card.appendChild(pre);
  }
  if (request.description && request.description !== detail) {
    const why = document.createElement('div');
    why.className = 'permission-why';
    why.textContent = request.description;
    card.appendChild(why);
  }
  const actions = document.createElement('div');
  actions.className = 'permission-actions';
  const button = (label, decision, cls = '') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (cls) b.className = cls;
    b.addEventListener('click', () => {
      for (const x of actions.querySelectorAll('button')) x.disabled = true;
      sendPermission(request.requestId, decision);
    });
    return b;
  };
  actions.append(button('Denegar', 'deny'));
  if (request.canAlways) actions.append(button('Permitir siempre en este repo', 'always'));
  actions.append(button('Permitir', 'allow', 'send-button'));
  card.appendChild(actions);
  chatLog.appendChild(card);
  chatLog.scrollTop = chatLog.scrollHeight;
  permissionCards.set(request.requestId, card);
  actions.querySelector('.send-button').focus({ preventScroll: true });
  if (window.TerminalView) window.TerminalView.flagAttention?.();
}

const DECISION_TEXT = { allow: 'Permitido', always: 'Permitido siempre en este repo', deny: 'Denegado' };

function resolvePermission(requestId, decision) {
  const card = permissionCards.get(requestId);
  if (!card) return;
  permissionCards.delete(requestId);
  card.classList.add('resolved');
  card.querySelector('.permission-actions')?.remove();
  card.querySelector('.permission-why')?.remove();
  const state = document.createElement('div');
  state.className = `permission-state ${decision || 'gone'}`;
  state.textContent = DECISION_TEXT[decision] || 'Ya no está pendiente';
  card.appendChild(state);
}

function clearPermissionCards() {
  permissionCards.clear();
}
