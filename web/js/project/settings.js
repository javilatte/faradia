'use strict';

// Panel de ajustes, registro y cuenta de Claude.

// The effort selector tunes the real `--effort` flag the bridge already
// supports (server/bridge/claudeProcess.js) — not a model-name picker, since
// this app has no verified list of installed/available Claude model ids to
// offer without guessing at strings.
effortSelect.addEventListener('change', async () => {
  const settings = await fetch(apiPath('/api/settings')).then((r) => r.json());
  settings.ai.claude.effort = effortSelect.value;
  await fetch(apiPath('/api/settings'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings)
  });
  appendMessage('system', `Effort actualizado a "${effortSelect.value}" para la proxima sesion.`);
});

async function loadInitialSettings() {
  const settings = await fetch(apiPath('/api/settings')).then((r) => r.json());
  applyUi(settings.ui || {});
  modeLabel.textContent = settings.ai.mode === 'local' ? 'IA local' : 'Claude Code';
  effortSelect.value = settings.ai.claude.effort || 'default';
  await populateChatModelSelect(settings);

  const health = await fetch(apiPath('/api/health')).then((r) => r.json());
  projectLabel.textContent = health.projectRoot.split('/').pop();
}

// ---- settings modal ----

const settingsOverlay = document.getElementById('settings-overlay');
const settingsButton = document.getElementById('settings-button');
const settingsClose = document.getElementById('settings-close');
const settingsSave = document.getElementById('settings-save');
const settingsSaveStatus = document.getElementById('settings-save-status');
const settingsPaneTitle = document.getElementById('settings-pane-title');
const settingsNavItems = document.querySelectorAll('.settings-nav-item');
const settingsPanes = document.querySelectorAll('.settings-pane');

const claudeAccountInfo = document.getElementById('claude-account-info');
const claudeAccountSwitch = document.getElementById('claude-account-switch');
const claudeAccountRefresh = document.getElementById('claude-account-refresh');
const claudeAccountSwitchNote = document.getElementById('claude-account-switch-note');
const claudeModelSelect = document.getElementById('setting-claude-model');
const claudeEffortSelect = document.getElementById('setting-claude-effort');
const uiThemeSelect = document.getElementById('setting-ui-theme');
const uiClockSelect = document.getElementById('setting-ui-clock');
const currentUiDraft = () => ({ theme: uiThemeSelect.value, clock: uiClockSelect.value });
for (const el of [uiThemeSelect, uiClockSelect]) el.addEventListener('change', () => applyUi(currentUiDraft()));
const localUrlInput = document.getElementById('setting-local-url');
const localModelInput = document.getElementById('setting-local-model');
const localAuthInput = document.getElementById('setting-local-auth');
const instructionsTextarea = document.getElementById('setting-instructions');
const instructionsMigrationBanner = document.getElementById('instructions-migration-banner');
const memoryTextarea = document.getElementById('setting-memory');
const nogoList = document.getElementById('nogo-list');
const nogoInput = document.getElementById('nogo-input');
const nogoAddButton = document.getElementById('nogo-add');
const nogoMigrationBanner = document.getElementById('nogo-migration-banner');
const skillsList = document.getElementById('skills-list');
const skillSlugInput = document.getElementById('skill-slug-input');
const skillDescInput = document.getElementById('skill-desc-input');
const skillAddButton = document.getElementById('skill-add');

let currentSettings = null;

// "Ayuda con IA" buttons in Settings: ask the real `claude` CLI for a short
// suggestion and drop it into the field, never auto-saved — the user still
// reviews/edits it and clicks Guardar/Anadir/Crear themselves.
document.querySelectorAll('.ai-assist-button').forEach((button) => {
  const row = button.closest('.ai-assist-row');
  const promptInput = row.querySelector('.ai-assist-prompt');
  button.addEventListener('click', async () => {
    const prompt = promptInput.value.trim();
    if (!prompt) return;
    const target = document.getElementById(button.dataset.target);
    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = '...';
    try {
      const res = await fetch(apiPath('/api/ai-assist'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field: button.dataset.field, prompt, current: target.value })
      });
      const data = await res.json();
      if (!res.ok || !data.suggestion) {
        settingsSaveStatus.textContent = data.error || 'No se pudo obtener una sugerencia.';
        return;
      }
      target.value = data.suggestion;
      promptInput.value = '';
    } catch (err) {
      settingsSaveStatus.textContent = err.message;
    } finally {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  });
});

function renderNogoList() {
  nogoList.innerHTML = '';
  currentSettings.preferences.noGo.forEach((pattern, idx) => {
    const row = document.createElement('div');
    row.className = 'nogo-item';
    const code = document.createElement('code');
    code.textContent = pattern;
    row.appendChild(code);
    const removeBtn = document.createElement('button');
    removeBtn.textContent = '✕';
    removeBtn.title = 'Quitar';
    removeBtn.addEventListener('click', () => {
      currentSettings.preferences.noGo.splice(idx, 1);
      renderNogoList();
    });
    row.appendChild(removeBtn);
    nogoList.appendChild(row);
  });
}

nogoAddButton.addEventListener('click', () => {
  const pattern = nogoInput.value.trim();
  if (!pattern) return;
  currentSettings.preferences.noGo.push(pattern);
  nogoInput.value = '';
  renderNogoList();
});
nogoInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') nogoAddButton.click();
});

function renderMigrationBanner(el, field, preview, label) {
  if (!preview[field].changed) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML = '';
  const text = document.createElement('div');
  text.textContent = `Se encontro una configuracion antigua para "${label}" distinta de la actual. ¿Importarla?`;
  el.appendChild(text);
  const applyBtn = document.createElement('button');
  applyBtn.className = 'send-button';
  applyBtn.textContent = 'Importar';
  applyBtn.addEventListener('click', async () => {
    const next = await fetch(apiPath('/api/settings/migrate'), { method: 'POST' }).then((r) => r.json());
    currentSettings = next;
    populateSettingsForm();
    el.hidden = true;
    settingsSaveStatus.textContent = 'Configuracion antigua importada.';
  });
  el.appendChild(applyBtn);
}

async function renderSkillsList() {
  const skills = await fetch(apiPath('/api/skills')).then((r) => r.json());
  skillsList.innerHTML = '';
  for (const skill of skills) {
    const row = document.createElement('div');
    row.className = 'skill-item';
    const name = document.createElement('span');
    name.className = 'skill-name';
    name.textContent = skill.name;
    row.appendChild(name);
    const desc = document.createElement('span');
    desc.className = 'skill-desc';
    desc.textContent = skill.description || '(sin SKILL.md)';
    row.appendChild(desc);
    skillsList.appendChild(row);
  }
  if (skills.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = 'No hay skills todavia.';
    skillsList.appendChild(empty);
  }
}

skillAddButton.addEventListener('click', async () => {
  const slug = skillSlugInput.value.trim();
  if (!slug) return;
  const description = skillDescInput.value.trim();
  const res = await fetch(apiPath('/api/skills'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, description })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    settingsSaveStatus.textContent = err.error || 'No se pudo crear la skill.';
    return;
  }
  skillSlugInput.value = '';
  skillDescInput.value = '';
  renderSkillsList();
});
[skillSlugInput, skillDescInput].forEach((el) => {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') skillAddButton.click();
  });
});

function populateSettingsForm() {
  uiThemeSelect.value = currentSettings.ui?.theme || 'system';
  uiClockSelect.value = currentSettings.ui?.clock || 'datetime';
  claudeModelSelect.value = currentSettings.ai.claude.model || 'default';
  claudeEffortSelect.value = currentSettings.ai.claude.effort || 'default';
  localUrlInput.value = currentSettings.ai.localAi.url || '';
  localModelInput.value = currentSettings.ai.localAi.model || '';
  localAuthInput.value = currentSettings.ai.localAi.authHeader || '';
  instructionsTextarea.value = currentSettings.preferences.instructions || '';
  renderNogoList();
}

function renderAccountInfo(auth) {
  if (auth.loggedIn === false) {
    claudeAccountInfo.textContent = auth.error
      ? `No se pudo leer la cuenta: ${auth.error}`
      : 'No hay sesion de Claude Code iniciada.';
  } else {
    claudeAccountInfo.textContent =
      [
        auth.email ? `Cuenta: ${auth.email}` : null,
        auth.orgName ? `Organizacion: ${auth.orgName}` : null,
        auth.subscriptionType ? `Plan: ${auth.subscriptionType}` : null,
        auth.authMethod ? `Metodo: ${auth.authMethod}` : null
      ]
        .filter(Boolean)
        .join(' · ') || 'Sesion activa.';
  }
}

async function refreshAccountInfo() {
  claudeAccountInfo.textContent = 'Comprobando...';
  const auth = await fetch(apiPath('/api/claude-auth')).then((r) => r.json());
  renderAccountInfo(auth);
}

async function openSettings() {
  settingsOverlay.hidden = false;
  settingsSaveStatus.textContent = '';
  claudeAccountInfo.textContent = 'Comprobando...';
  claudeAccountSwitchNote.hidden = true;

  const [settings, memory, auth, migrationPreview] = await Promise.all([
    fetch(apiPath('/api/settings')).then((r) => r.json()),
    fetch(apiPath('/api/memory')).then((r) => r.json()),
    fetch(apiPath('/api/claude-auth')).then((r) => r.json()),
    fetch(apiPath('/api/settings/migration-preview')).then((r) => r.json())
  ]);

  currentSettings = settings;
  populateSettingsForm();
  memoryTextarea.value = memory.content || '';
  renderSkillsList();
  renderAccountInfo(auth);

  renderMigrationBanner(instructionsMigrationBanner, 'instructions', migrationPreview, 'Instructions');
  renderMigrationBanner(nogoMigrationBanner, 'noGo', migrationPreview, 'No-go');
}

claudeAccountSwitch.addEventListener('click', async () => {
  claudeAccountSwitch.disabled = true;
  try {
    const result = await fetch(apiPath('/api/claude-auth/login'), { method: 'POST' }).then((r) => r.json());
    claudeAccountSwitchNote.hidden = false;
    if (result.ok === false) claudeAccountSwitchNote.textContent = result.error;
  } finally {
    claudeAccountSwitch.disabled = false;
  }
});

claudeAccountRefresh.addEventListener('click', refreshAccountInfo);

function closeSettings() {
  settingsOverlay.hidden = true;
}

settingsButton.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) closeSettings();
});

settingsNavItems.forEach((item) => {
  item.addEventListener('click', () => {
    settingsNavItems.forEach((i) => i.classList.remove('active'));
    item.classList.add('active');
    const pane = item.dataset.pane;
    settingsPanes.forEach((p) => {
      p.hidden = p.dataset.pane !== pane;
    });
    settingsPaneTitle.textContent = item.textContent;
    if (pane === 'registro') loadLogPane();
  });
});

const logList = document.getElementById('log-list');
const logFilter = document.getElementById('log-filter');
const logRefresh = document.getElementById('log-refresh');
let logEntries = [];

function logDetail(entry) {
  return Object.entries(entry)
    .filter(([k]) => !['ts', 'level', 'event'].includes(k))
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('  ');
}

const LOG_CATEGORIES = {
  todo: () => true,
  archivos: (e) => e.event.startsWith('file.') || e.event === 'task.commit' || e.event === 'task.merge',
  preguntas: (e) => e.event === 'chat.user' || e.event === 'task.question',
  respuestas: (e) => e.event === 'chat.reply' || e.event === 'task.answer'
};
let logCategory = 'todo';

function renderLogPane() {
  const needle = logFilter.value.trim().toLowerCase();
  logList.innerHTML = '';
  const rows = logEntries.filter(
    (e) => LOG_CATEGORIES[logCategory](e) && (!needle || `${e.event} ${logDetail(e)}`.toLowerCase().includes(needle))
  );
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = logEntries.length
      ? 'Ningún evento coincide con el filtro.'
      : 'Todavía no hay eventos registrados en este proyecto.';
    logList.appendChild(empty);
    return;
  }
  for (const e of rows) {
    const row = document.createElement('div');
    row.className = `log-row ${e.level || 'info'}`;
    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = new Date(e.ts).toLocaleTimeString('es-ES');
    const event = document.createElement('span');
    event.className = 'log-event';
    event.textContent = e.event;
    const detail = document.createElement('span');
    detail.className = 'log-detail';
    detail.textContent = logDetail(e);
    row.append(time, event, detail);
    logList.appendChild(row);
  }
}

async function loadLogPane() {
  logEntries = await fetch(apiPath('/api/logs?limit=300'))
    .then((r) => r.json())
    .catch(() => []);
  renderLogPane();
}

logFilter.addEventListener('input', renderLogPane);
document.querySelectorAll('#log-chips .log-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    logCategory = chip.dataset.cat;
    document.querySelectorAll('#log-chips .log-chip').forEach((c) => c.classList.toggle('on', c === chip));
    renderLogPane();
  });
});
logRefresh.addEventListener('click', loadLogPane);

settingsSave.addEventListener('click', async () => {
  currentSettings.ai.claude.model = claudeModelSelect.value;
  currentSettings.ai.claude.effort = claudeEffortSelect.value;
  currentSettings.ai.localAi.url = localUrlInput.value.trim();
  currentSettings.ai.localAi.model = localModelInput.value.trim();
  currentSettings.ai.localAi.authHeader = localAuthInput.value.trim();
  currentSettings.preferences.instructions = instructionsTextarea.value;
  currentSettings.ui = currentUiDraft();

  const saved = await fetch(apiPath('/api/settings'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(currentSettings)
  }).then((r) => r.json());
  await fetch(apiPath('/api/memory'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: memoryTextarea.value })
  });

  currentSettings = saved;
  applyUi(saved.ui);
  effortSelect.value = saved.ai.claude.effort || 'default';
  modeLabel.textContent = saved.ai.mode === 'local' ? 'IA local' : 'Claude Code';
  await populateChatModelSelect(saved);
  settingsSaveStatus.textContent = 'Guardado. Se aplicara en la proxima sesion de Claude.';
});
