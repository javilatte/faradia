'use strict';

// Settings panel, log and Claude account.

// The effort selector tunes the real `--effort` flag the bridge already
// supports (server/bridge/claudeProcess.js) — not a model-name picker, since
// this app has no verified list of installed/available Claude model ids to
// offer without guessing at strings.
effortSelect.addEventListener('change', async () => {
  const where = await setAiField('claude.effort', effortSelect.value);
  appendMessage('system', `Effort "${effortSelect.value}" ${where}, desde la próxima sesión.`);
});

async function loadInitialSettings() {
  const pid = currentProjectId;
  const settings = await fetch(apiPath('/api/settings')).then((r) => r.json());
  if (pid !== currentProjectId) return;
  applyUi(settings.ui || {});
  modeLabel.textContent = ENGINE_LABEL[settings.ai.mode] || 'Claude Code';
  effortSelect.value = settings.ai.claude.effort || 'default';
  await populateChatModelSelect(settings);

  const health = await fetch(apiPath('/api/health')).then((r) => r.json());
  projectLabel.textContent = health.projectRoot.split('/').pop();
}

// ---- settings modal ----

const settingsOverlay = document.getElementById('settings-overlay');
const settingsButton = document.getElementById('settings-button');
const settingsClose = document.getElementById('settings-close');
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

// "Ayuda con IA" buttons in Settings: ask the real `claude` CLI for a short suggestion and drop it
// into the field; the field then saves itself like any other edit, so the user can still review or
// change it.
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
      target.dispatchEvent(new Event('input', { bubbles: true }));
      promptInput.value = '';
    } catch (err) {
      settingsSaveStatus.textContent = err.message;
    } finally {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  });
});

// "Prohibido": the list of the chosen scope; in "Solo este repo" the lists for all repos are shown
// too, read-only (they add up).
function nogoLayer() {
  return settingsScope === 'global'
    ? currentSettings.layers.global.preferences.noGo
    : currentSettings.layers.project.preferences.noGo;
}

function nogoRow(pattern, onRemove) {
  const row = document.createElement('div');
  row.className = 'nogo-item';
  const code = document.createElement('code');
  code.textContent = pattern;
  row.appendChild(code);
  if (onRemove) {
    const removeBtn = document.createElement('button');
    removeBtn.textContent = '✕';
    removeBtn.title = 'Quitar';
    removeBtn.setAttribute('aria-label', `Quitar ${pattern}`);
    removeBtn.addEventListener('click', onRemove);
    row.appendChild(removeBtn);
  }
  return row;
}

function renderNogoList() {
  nogoList.innerHTML = '';
  const list = nogoLayer();
  list.forEach((pattern, idx) => {
    nogoList.appendChild(
      nogoRow(pattern, () => {
        list.splice(idx, 1);
        renderNogoList();
        patchLayer({ preferences: { noGo: [...list] } });
      })
    );
  });
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent =
      settingsScope === 'global' ? 'Nada prohibido para todos los repos.' : 'Nada propio de este repo.';
    nogoList.appendChild(empty);
  }
  const inherited = document.getElementById('nogo-inherited');
  const globalList = currentSettings.layers.global.preferences.noGo;
  inherited.hidden = settingsScope !== 'project' || !globalList.length;
  const box = inherited.querySelector('.inherited-list');
  box.replaceChildren(...globalList.map((p) => nogoRow(p)));
}

nogoAddButton.addEventListener('click', () => {
  const pattern = nogoInput.value.trim();
  if (!pattern || !currentSettings) return;
  const list = nogoLayer();
  if (!list.includes(pattern)) list.push(pattern);
  nogoInput.value = '';
  renderNogoList();
  patchLayer({ preferences: { noGo: [...list] } });
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
  text.textContent = `Se encontró una configuración antigua para "${label}" distinta de la actual. ¿Importarla?`;
  el.appendChild(text);
  const applyBtn = document.createElement('button');
  applyBtn.className = 'send-button';
  applyBtn.textContent = 'Importar';
  applyBtn.addEventListener('click', async () => {
    await fetch(apiPath('/api/settings/migrate'), { method: 'POST' });
    currentSettings = await fetch(apiPath('/api/settings')).then((r) => r.json());
    populateSettingsForm();
    el.hidden = true;
    settingsSaveStatus.textContent = 'Configuración antigua importada.';
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
    empty.textContent = 'Este repo no tiene skills propias. Las de optimia y las de ECC están arriba.';
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

// AI fields a repo can override: element -> path in the settings.
const AI_INPUTS = [
  [claudeModelSelect, 'claude.model'],
  [claudeEffortSelect, 'claude.effort'],
  [localUrlInput, 'localAi.url'],
  [localModelInput, 'localAi.model'],
  [localAuthInput, 'localAi.authHeader']
];
const getIn = (obj, dotted) => dotted.split('.').reduce((o, k) => (o ? o[k] : undefined), obj);
const aiPatch = (dotted, value) => {
  const out = {};
  const keys = dotted.split('.');
  keys.reduce((o, k, i) => (o[k] = i === keys.length - 1 ? value : {}), out);
  return out;
};

// Under each field: where the value comes from and, if this repo overrides it, how to inherit it
// again or apply it to all repos.
function renderFieldOrigin(el, dotted) {
  const field = el.closest('.settings-field');
  let note = field.querySelector('.field-origin');
  if (!note) {
    note = document.createElement('div');
    note.className = 'field-origin';
    field.appendChild(note);
  }
  note.replaceChildren();
  const own = currentSettings.layers.overrides.includes(`ai.${dotted}`);
  // The value with the label the user sees in the menu ("Alto", not "high").
  const show = (v) => {
    if (v === '' || v === undefined) return '(vacío)';
    const opt = el.tagName === 'SELECT' ? [...el.options].find((o) => o.value === v) : null;
    return opt ? opt.textContent : v;
  };
  if (settingsScope === 'global') {
    if (own) {
      note.classList.add('differs');
      note.append(`Este repo usa otro valor: ${show(getIn(currentSettings.layers.project.ai, dotted))}`);
    } else note.classList.remove('differs');
    return;
  }
  note.classList.toggle('differs', own);
  if (!own) {
    note.append('Igual que en todos los repos');
    return;
  }
  note.append(`Propio de este repo (en todos: ${show(getIn(currentSettings.layers.global.ai, dotted))}) `);
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'link';
  reset.textContent = 'Restablecer';
  reset.title = 'Volver a usar el valor de todos los repos';
  reset.addEventListener('click', () => patchSettings({ scope: 'project', reset: [`ai.${dotted}`] }, true));
  const promote = document.createElement('button');
  promote.type = 'button';
  promote.className = 'link';
  promote.textContent = 'Usar en todos los repos';
  promote.addEventListener('click', () => patchSettings({ scope: 'project', promote: [`ai.${dotted}`] }, true));
  note.append(reset, promote);
}

function populateSettingsForm() {
  const { layers } = currentSettings;
  uiThemeSelect.value = layers.global.ui?.theme || 'system';
  uiClockSelect.value = layers.global.ui?.clock || 'datetime';
  // In "Todos los repos" the global layer is shown and edited; in "Solo este repo", the effective
  // value (inherited or own).
  const source = settingsScope === 'global' ? layers.global.ai : currentSettings.ai;
  for (const [el, dotted] of AI_INPUTS) {
    el.value = getIn(source, dotted) ?? '';
    if (el.tagName === 'SELECT' && !el.value) el.value = 'default';
    renderFieldOrigin(el, dotted);
  }
  const instructions = settingsScope === 'global' ? layers.global : layers.project;
  instructionsTextarea.value = instructions.preferences.instructions || '';
  document.getElementById('instructions-label').textContent =
    settingsScope === 'global'
      ? 'Instrucciones para todos los repos: el flujo de trabajo común (convenciones, commits, cómo verificar, idioma…)'
      : 'Instrucciones solo para este repo: se suman a las de todos los repos y mandan si las contradicen';
  instructionsTextarea.placeholder =
    settingsScope === 'global'
      ? 'Ej.: Conventional Commits con ámbito. Ejecuta los tests antes de terminar. Responde en español.'
      : 'Ej.: Los tests van con vitest. No toques src/legacy/.';
  const inherited = document.getElementById('instructions-inherited');
  inherited.hidden = settingsScope !== 'project' || !layers.global.preferences.instructions;
  inherited.querySelector('.inherited-text').textContent = layers.global.preferences.instructions;
  renderNogoList();
}

function renderAccountInfo(auth) {
  if (auth.loggedIn === false) {
    claudeAccountInfo.textContent = auth.error
      ? `No se pudo leer la cuenta: ${auth.error}`
      : 'No hay sesión de Claude Code iniciada.';
  } else {
    claudeAccountInfo.textContent =
      [
        auth.email ? `Cuenta: ${auth.email}` : null,
        auth.orgName ? `Organización: ${auth.orgName}` : null,
        auth.subscriptionType ? `Plan: ${auth.subscriptionType}` : null,
        auth.authMethod ? `Método: ${auth.authMethod}` : null
      ]
        .filter(Boolean)
        .join(' · ') || 'Sesión activa.';
  }
}

async function refreshAccountInfo() {
  claudeAccountInfo.textContent = 'Comprobando...';
  const auth = await fetch(apiPath('/api/claude-auth')).then((r) => r.json());
  renderAccountInfo(auth);
}

async function openSettings() {
  // Opens on the last visited pane (HIG: "Restore the most recently viewed pane").
  if (!settingsOverlay.dataset.opened) {
    settingsOverlay.dataset.opened = '1';
    let last = null;
    try {
      last = localStorage.getItem('optimia:settings-pane');
    } catch {
      /* no persistence */
    }
    if (last) showSettingsPane(last);
  }
  settingsOverlay.hidden = false;
  renderScope();
  settingsSaveStatus.textContent = '';
  claudeAccountInfo.textContent = 'Comprobando...';
  claudeAccountSwitchNote.hidden = true;

  // The account check (claude auth status) is slow: it runs separately so it does not delay the
  // form. While loading, the fields cannot be edited, so loading never overwrites what is being
  // typed.
  fetch(apiPath('/api/claude-auth'))
    .then((r) => r.json())
    .then(renderAccountInfo)
    .catch(() => {});
  const editable = [instructionsTextarea, memoryTextarea];
  settingsLoading = true;
  for (const el of editable) el.disabled = true;
  let settings, memory, migrationPreview;
  try {
    [settings, memory, migrationPreview] = await Promise.all([
      fetch(apiPath('/api/settings')).then((r) => r.json()),
      fetch(apiPath('/api/memory')).then((r) => r.json()),
      fetch(apiPath('/api/settings/migration-preview')).then((r) => r.json())
    ]);
  } finally {
    for (const el of editable) el.disabled = false;
  }
  settingsLoading = false;

  currentSettings = settings;
  populateSettingsForm();
  memoryTextarea.value = memory.content || '';
  renderSkillsList();

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
  flushSettingsSave();
  settingsOverlay.hidden = true;
  // Agents are edited in Settings: the composer and the cards catch up.
  loadTaskKinds().catch(() => {});
}

function showSettingsPane(pane) {
  const item = [...settingsNavItems].find((i) => i.dataset.pane === pane);
  item?.click();
}

// Opens Settings directly on a pane (for example "agents" from the composer).
function openSettingsPane(pane) {
  settingsOverlay.dataset.opened = '1';
  showSettingsPane(pane);
  openSettings();
}

settingsButton.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) closeSettings();
});
// Esc closes Settings, as any sheet, unless something inside it (a menu, a sheet on top) uses it.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || settingsOverlay.hidden || e.defaultPrevented) return;
  if (document.querySelector('.sheet-overlay')) return;
  e.preventDefault();
  closeSettings();
  settingsButton.focus();
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
    renderScope();
    try {
      localStorage.setItem('optimia:settings-pane', pane);
    } catch {
      /* no persistence */
    }
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
    time.textContent = new Date(e.ts).toLocaleTimeString(window.optimiaLang?.locale || 'es-ES');
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

// As in macOS Settings, changes apply at once: there is no Save button. Menus save on change; text
// fields when typing stops or when leaving the field. Each change goes to the chosen layer (all
// repos or this one).
let settingsLoading = false;
let saveChain = Promise.resolve();
const pendingText = new Map(); // elemento -> temporizador

async function patchSettings(body, rerender = false) {
  saveChain = saveChain.then(async () => {
    const res = await fetch(apiPath('/api/settings'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    currentSettings = data;
    applyUi(data.ui);
    effortSelect.value = data.ai.claude.effort || 'default';
    modeLabel.textContent = ENGINE_LABEL[data.ai.mode] || 'Claude Code';
    await populateChatModelSelect(data);
    if (rerender) populateSettingsForm();
    else for (const [el, dotted] of AI_INPUTS) renderFieldOrigin(el, dotted);
    if (!pendingText.size) {
      settingsSaveStatus.textContent =
        body.scope === 'global' ? 'Guardado para todos los repos' : 'Guardado solo para este repo';
    }
  });
  return saveChain.catch((err) => {
    settingsSaveStatus.textContent = `No se pudo guardar: ${err.message}`;
  });
}

const patchLayer = (patch) => patchSettings({ scope: settingsScope, ...patch });

async function saveMemoryNow() {
  await fetch(apiPath('/api/memory'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: memoryTextarea.value })
  });
  if (!pendingText.size) settingsSaveStatus.textContent = 'Memoria de este repo guardada';
  refreshMemoryKnown();
}

function saveField(el) {
  if (settingsLoading || !currentSettings) return;
  if (el === memoryTextarea) return saveMemoryNow();
  if (el === instructionsTextarea) return patchLayer({ preferences: { instructions: el.value } });
  const entry = AI_INPUTS.find(([input]) => input === el);
  if (entry) return patchLayer({ ai: aiPatch(entry[1], el.value.trim()) });
}

function scheduleText(el, delay = 700) {
  clearTimeout(pendingText.get(el));
  settingsSaveStatus.textContent = 'Cambios sin guardar…';
  pendingText.set(
    el,
    setTimeout(() => {
      pendingText.delete(el);
      saveField(el);
    }, delay)
  );
}

function flushSettingsSave() {
  for (const [el, timer] of pendingText) {
    clearTimeout(timer);
    pendingText.delete(el);
    saveField(el);
  }
  return saveChain;
}

for (const el of [claudeModelSelect, claudeEffortSelect]) el.addEventListener('change', () => saveField(el));
for (const el of [uiThemeSelect, uiClockSelect]) {
  el.addEventListener('change', () => patchSettings({ scope: 'global', ui: currentUiDraft() }));
}
for (const el of [localUrlInput, localModelInput, localAuthInput, instructionsTextarea, memoryTextarea]) {
  el.addEventListener('input', () => scheduleText(el));
  el.addEventListener('blur', () => {
    if (pendingText.has(el)) scheduleText(el, 0);
  });
}

// ---- local AI: detect the servers running on this machine ----

const localDetectButton = document.getElementById('local-ai-detect');
const localServersBox = document.getElementById('local-ai-servers');
const localModelsList = document.getElementById('local-ai-models');

async function detectLocalAi() {
  localDetectButton.disabled = true;
  localServersBox.textContent = 'Buscando…';
  let servers = [];
  try {
    ({ servers = [] } = await fetch(apiPath('/api/local-ai/detect')).then((r) => r.json()));
  } catch {
    /* shown as "none found" */
  }
  localDetectButton.disabled = false;
  localServersBox.replaceChildren();
  if (!servers.length) {
    localServersBox.textContent =
      'No hay ningún servidor local en marcha. Abre LM Studio y arranca su servidor (lms server start) o abre Ollama.';
    return;
  }
  for (const server of servers) {
    const row = document.createElement('div');
    row.className = 'local-ai-server';
    const name = document.createElement('span');
    const count = server.models.length;
    name.textContent = `${server.label} · ${server.url} · ${count} ${count === 1 ? 'modelo' : 'modelos'}`;
    const use = document.createElement('button');
    use.type = 'button';
    const inUse = localUrlInput.value.replace(/\/+$/, '') === server.url;
    use.textContent = inUse ? 'En uso' : 'Usar';
    use.disabled = inUse;
    use.addEventListener('click', () => {
      localUrlInput.value = server.url;
      if (!localModelInput.value && server.models[0]) localModelInput.value = server.models[0].name;
      saveField(localUrlInput);
      saveField(localModelInput);
      detectLocalAi();
    });
    row.append(name, use);
    localServersBox.appendChild(row);
  }
  localModelsList.replaceChildren(
    ...servers.flatMap((s) =>
      s.models.map((m) => {
        const opt = document.createElement('option');
        opt.value = m.name;
        opt.label = s.label;
        return opt;
      })
    )
  );
}
localDetectButton.addEventListener('click', detectLocalAi);

// ---- scope: all repos / only this repo ----

// Which panes support both scopes and which only one.
const SCOPED_PANES = new Set(['claude', 'local-ai', 'instructions', 'nogo', 'agents']);
const GLOBAL_PANES = new Set(['general', 'sync', 'appearance', 'monitor']);
let settingsScope = 'global';
try {
  settingsScope = localStorage.getItem('optimia:settings-scope') === 'project' ? 'project' : 'global';
} catch {
  /* no persistence */
}
window.optimiaSettingsScope = settingsScope;
const scopeControl = document.getElementById('settings-scope');
const scopeNote = document.getElementById('settings-scope-note');

function currentPane() {
  return document.querySelector('.settings-nav-item.active')?.dataset.pane || 'claude';
}

function renderScope() {
  const pane = currentPane();
  const repo = projectLabel.textContent || 'este repo';
  for (const el of document.querySelectorAll('.scope-repo-name')) el.textContent = repo;
  scopeControl.parentElement.hidden = !SCOPED_PANES.has(pane);
  for (const b of scopeControl.querySelectorAll('button')) {
    const on = b.dataset.scope === settingsScope;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  }
  if (pane === 'skills')
    scopeNote.textContent = `Las skills de optimia y de ECC valen para todos los repos; las propias, solo para ${repo}.`;
  else if (pane === 'sync') scopeNote.textContent = 'Igual en todos los repos y en todos tus equipos.';
  else if (GLOBAL_PANES.has(pane)) scopeNote.textContent = 'Igual en todos los repos.';
  else if (!SCOPED_PANES.has(pane)) scopeNote.textContent = `Solo de este repo (${repo}).`;
  else if (settingsScope === 'global')
    scopeNote.textContent = 'Los cambios se aplican a todos los repos, salvo a los que tengan su propio valor.';
  else scopeNote.textContent = `Los cambios se aplican solo a ${repo}; lo demás se hereda de todos los repos.`;
}

function setSettingsScope(scope) {
  flushSettingsSave();
  settingsScope = scope;
  window.optimiaSettingsScope = scope;
  try {
    localStorage.setItem('optimia:settings-scope', scope);
  } catch {
    /* no persistence */
  }
  renderScope();
  if (currentSettings) populateSettingsForm();
  window.dispatchEvent(new CustomEvent('optimia:settings-scope', { detail: scope }));
}

for (const b of scopeControl.querySelectorAll('button')) {
  b.addEventListener('click', () => setSettingsScope(b.dataset.scope));
}

// ---- "Conocer este repo": an agent studies the repo and proposes its memory ----

const onboardButton = document.getElementById('onboard-button');
async function startOnboarding() {
  onboardButton.disabled = true;
  try {
    const res = await fetch(apiPath('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Conocer el repo',
        type: 'onboard',
        instruction: memoryTextarea.value.trim()
          ? 'Revisa y mejora la memoria actual del repo.'
          : 'Escribe la memoria de este repo desde cero.',
        chatId: currentChatId || undefined
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    applyTaskFromServer(data);
    renderTasks();
    closeSettings();
    appendMessage(
      'system',
      'Estudiando el repo. Cuando termine, revisa la memoria propuesta en su tarjeta y guárdala.'
    );
  } catch (err) {
    document.getElementById('onboard-status').textContent = `No se pudo lanzar: ${err.message}`;
  } finally {
    onboardButton.disabled = false;
  }
}
onboardButton.addEventListener('click', startOnboarding);

// Interface language (see web/js/i18n.js): the browser's by default; changing it reloads the page.
const languageSelect = document.getElementById('setting-ui-language');
if (languageSelect && window.optimiaLang) {
  languageSelect.value = window.optimiaLang.choice;
  languageSelect.addEventListener('change', () => window.optimiaLang.set(languageSelect.value));
}
