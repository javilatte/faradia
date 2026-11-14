'use strict';

const chatLog = document.getElementById('chat-log');
const input = document.getElementById('chat-input');
const sendButton = document.getElementById('send-button');
const effortSelect = document.getElementById('model-select');
const chatModelSelect = document.getElementById('chat-model-select');
const thinkingOrb = document.getElementById('thinking-orb');

// Same list the Settings "Claude Code" pane offers (web/index.html's
// setting-claude-model) — a verified set of recognized model names, not a
// guess. Local mode instead lists whatever Ollama actually has pulled (see
// GET /api/local-models), since there's no fixed list to hardcode there.
const CLAUDE_MODEL_OPTIONS = [
  ['default', 'Default'],
  ['fable', 'fable'],
  ['opus', 'opus'],
  ['sonnet', 'sonnet']
];

async function populateChatModelSelect(settings) {
  chatModelSelect.innerHTML = '';
  if (settings.ai.mode === 'local') {
    const models = await fetch('/api/local-models')
      .then((r) => r.json())
      .catch(() => []);
    if (models.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Sin modelos locales (ollama pull ...)';
      chatModelSelect.appendChild(opt);
      chatModelSelect.disabled = true;
      return;
    }
    chatModelSelect.disabled = false;
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m.name;
      opt.textContent = `${m.name} (${m.size})`;
      chatModelSelect.appendChild(opt);
    }
    chatModelSelect.value = settings.ai.localAi.model || models[0].name;
  } else {
    chatModelSelect.disabled = false;
    for (const [value, label] of CLAUDE_MODEL_OPTIONS) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      chatModelSelect.appendChild(opt);
    }
    chatModelSelect.value = settings.ai.claude.model || 'default';
  }
}

chatModelSelect.addEventListener('change', async () => {
  const settings = await fetch('/api/settings').then((r) => r.json());
  if (settings.ai.mode === 'local') settings.ai.localAi.model = chatModelSelect.value;
  else settings.ai.claude.model = chatModelSelect.value;
  await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings)
  });
  appendMessage('system', `Modelo actualizado a "${chatModelSelect.value}" para la proxima sesion.`);
});
const connectionStatus = document.getElementById('connection-status');
const modeLabel = document.getElementById('mode-label');
const projectLabel = document.getElementById('project-label');

// Un punto de color con el texto en tooltip: el estado de conexion no ocupa
// espacio en la barra superior, solo aparece como texto si el usuario lo busca.
function setConnectionState(connected, label) {
  connectionStatus.classList.toggle('offline', !connected);
  connectionStatus.title = label;
  connectionStatus.setAttribute('aria-label', label);
}
const clockEl = document.getElementById('clock');
const chatTabs = document.getElementById('chat-tabs');
const chatNewButton = document.getElementById('chat-new-button');

let ws = null;
let wsOpen = false;
let currentChatId = null;
const chatsMeta = new Map(); // chatId -> {id, title, updatedAt, ...} (no messages)
let waitingForResult = false;
let currentAssistantBubble = null;

// Pending image attachments for the next chat message: {mediaType, base64Data, dataUrl}.
// Sent as inline base64 content blocks (see server/bridge/claudeProcess.js
// ClaudeSession.send) — confirmed in the Fase 0 spike that `claude -p
// --input-format stream-json` accepts Messages-API-style image blocks
// directly, so no file-on-disk fallback is needed.
let pendingImages = [];
const chatInputArea = document.querySelector('.chat-input-area');
const attachmentsEl = document.getElementById('chat-attachments');
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const colInProgress = document.getElementById('col-in_progress');
const colReadyToTest = document.getElementById('col-ready_to_test');

// taskId -> { task, lastStep }. lastStep is a human-readable label derived
// from the most recent claude_event for that task's dedicated session
// (there is no separate plan/implement/test sub-agent pipeline — one
// worktree, one claude session per task, doing whatever it judges needed).
const tasks = new Map();

// task_id -> { chatId, description, lastStep, finished, status, summary,
// interrupted }. Subagents launched with Claude's own `Agent` tool from
// inside a chat turn (e.g. "crea un agente para buscar X") never go through
// /api/tasks — there's no worktree, no dedicated ClaudeSession, just a
// backgrounded task inside the same headless session. Their lifecycle is
// driven entirely by Claude Code's own `system/task_*` events (see the
// `event.type === 'system'` branch in handleClaudeEvent): task_started
// creates the entry, task_progress updates lastStep, task_updated/
// task_notification mark it finished and attach its final summary so it can
// move to "Ready to review" instead of just vanishing. Entries persist there
// until the user dismisses them with the card's ✕ (tracked in localStorage
// per chat so a reload doesn't resurrect a dismissed card via replay).
const chatAgents = new Map();
