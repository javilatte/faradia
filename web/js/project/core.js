'use strict';

// Active project: the one in ?p=<id> in the URL or, without it, the project Faradia was launched
// from. The whole project view (chat, agents, settings, terminal) talks to that project's API;
// switching projects swaps it in place (see switch.js) and updates ?p=.
let currentProjectId = new URLSearchParams(location.search).get('p') || null;
let defaultProjectId = null;
function apiPath(p) {
  return currentProjectId ? `/api/projects/${currentProjectId}${p.slice('/api'.length)}` : p;
}
function wsPayload(obj) {
  return JSON.stringify(currentProjectId ? { ...obj, projectId: currentProjectId } : obj);
}
// A server message belongs to this project if it has no projectId or if it matches.
function isForThisProject(msg) {
  if (!msg.projectId) return true;
  const mine = currentProjectId || defaultProjectId;
  return !mine || msg.projectId === mine;
}
fetch('/api/projects')
  .then((r) => r.json())
  .then((d) => {
    defaultProjectId = d.defaultProjectId;
  })
  .catch(() => {});

const chatLog = document.getElementById('chat-log');
const input = document.getElementById('chat-input');
const sendButton = document.getElementById('send-button');
const effortSelect = document.getElementById('model-select');
const chatModelSelect = document.getElementById('chat-model-select');
const thinkingOrb = document.getElementById('thinking-orb');

// Same list the Settings "Claude Code" pane offers (web/index.html's
// setting-claude-model) — a verified set of recognized model names, not a
// guess. Local mode instead lists the models of the local server, Ollama or LM Studio (see
// GET /api/local-models), since there's no fixed list to hardcode there.
const CLAUDE_MODEL_OPTIONS = [
  ['default', 'Por defecto'],
  ['fable', 'fable'],
  ['opus', 'opus'],
  ['sonnet', 'sonnet'],
  ['haiku', 'haiku']
];

// One selector for every model the chat can use: Claude's and, below, the ones of the local servers
// running on this machine (Ollama, LM Studio). Picking a local model switches the chat to it.
function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
}

async function populateChatModelSelect(settings) {
  chatModelSelect.innerHTML = '';
  chatModelSelect.disabled = false;
  const claudeGroup = document.createElement('optgroup');
  claudeGroup.label = 'Claude';
  for (const [value, label] of CLAUDE_MODEL_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = `claude:${value}`;
    opt.textContent = label;
    claudeGroup.appendChild(opt);
  }
  chatModelSelect.appendChild(claudeGroup);

  const { servers = [] } = await fetch(apiPath('/api/local-ai/detect'))
    .then((r) => r.json())
    .catch(() => ({}));
  const local = settings.ai.localAi;
  let localSelected = false;
  for (const server of servers) {
    if (!server.models.length) continue;
    const group = document.createElement('optgroup');
    group.label = `Local · ${server.label}`;
    for (const m of server.models) {
      const opt = document.createElement('option');
      opt.value = `local:${m.name}`;
      opt.dataset.url = server.url;
      const size = formatBytes(m.size);
      opt.textContent = size ? `${m.name} (${size})` : m.name;
      if (settings.ai.mode === 'local' && m.name === local.model && !localSelected) {
        opt.selected = true;
        localSelected = true;
      }
      group.appendChild(opt);
    }
    chatModelSelect.appendChild(group);
  }
  if (settings.ai.mode === 'local' && !localSelected) {
    // The configured local model is not available right now: shown anyway so the state is honest.
    const opt = document.createElement('option');
    opt.value = `local:${local.model}`;
    opt.dataset.url = local.url;
    opt.textContent = `${local.model || 'modelo local'} (no disponible)`;
    opt.selected = true;
    chatModelSelect.appendChild(opt);
  }
  if (settings.ai.mode === 'claude') chatModelSelect.value = `claude:${settings.ai.claude.model || 'default'}`;
  modeLabel.textContent = ENGINE_LABEL[settings.ai.mode] || 'Claude Code';
  if (typeof syncTaskControls === 'function') syncTaskControls();
}

// Quick change from the composer: stored where the value lives now (in the repo if it overrides it;
// otherwise for all repos), and the user is told where.
async function setAiField(field, value) {
  const settings = await fetch(apiPath('/api/settings')).then((r) => r.json());
  const own = (settings.layers?.overrides || []).includes(`ai.${field}`);
  const ai = {};
  const keys = field.split('.');
  keys.reduce((o, k, i) => (o[k] = i === keys.length - 1 ? value : {}), ai);
  await fetch(apiPath('/api/settings'), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: own ? 'project' : 'global', ai })
  });
  return own ? 'solo en este repo' : 'en todos los repos';
}

chatModelSelect.addEventListener('change', async () => {
  const option = chatModelSelect.selectedOptions[0];
  const [engine, ...rest] = chatModelSelect.value.split(':');
  const model = rest.join(':');
  const settings = await fetch(apiPath('/api/settings')).then((r) => r.json());
  // Stored where the engine lives now: in this repo if it overrides it, otherwise for all repos.
  const own = (settings.layers?.overrides || []).includes('ai.mode');
  const ai =
    engine === 'local'
      ? { mode: 'local', localAi: { model, url: option?.dataset.url || settings.ai.localAi.url } }
      : { mode: 'claude', claude: { model } };
  await fetch(apiPath('/api/settings'), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: own ? 'project' : 'global', ai })
  });
  modeLabel.textContent = ENGINE_LABEL[engine] || 'Claude Code';
  syncTaskControls();
  const where = own ? 'solo en este repo' : 'en todos los repos';
  const label = engine === 'local' ? `local "${model}"` : `"${model}"`;
  appendMessage('system', `Modelo ${label} ${where}, desde la próxima sesión.`);
});
const connectionStatus = document.getElementById('connection-status');
const modeLabel = document.getElementById('mode-label');
const ENGINE_LABEL = { claude: 'Claude Code', local: 'IA local' };
// The header shows the provider in use, including a temporary switch while Claude is out of usage.
async function refreshProviderLabel() {
  const s = await fetch(apiPath('/api/settings'))
    .then((r) => r.json())
    .catch(() => null);
  if (!s) return;
  const engine = s.activeEngine || s.ai.mode;
  modeLabel.textContent = ENGINE_LABEL[engine] || 'Claude Code';
  modeLabel.title = s.claudeBlockedUntil ? 'Claude sin uso por ahora: se usa el proveedor de respaldo' : '';
}
const projectLabel = document.getElementById('project-label');

// A colored dot with the text in a tooltip: the connection state takes no room in the toolbar and
// only shows as text when the user looks for it.
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
// Other attached files, uploaded as soon as they are added: {key, name, status, id?, kind?, error?}
let pendingFiles = [];
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

// Paints sanitized markdown if the module has loaded (web/js/app/markdown.js); otherwise plain
// text. Keeps the original text so more chunks can be appended later.
const pendingMarkdown = new Set();
function paintMarkdown(el, text) {
  el._raw = text;
  if (window.faradiaMarkdown) return window.faradiaMarkdown(el, text);
  el.textContent = text;
  pendingMarkdown.add(el);
}
window.addEventListener('faradia:markdown-ready', () => {
  for (const el of pendingMarkdown) if (el.isConnected) window.faradiaMarkdown(el, el._raw);
  pendingMarkdown.clear();
});
