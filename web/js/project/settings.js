'use strict';

// Panel de ajustes, registro y cuenta de Claude.

// The effort selector tunes the real `--effort` flag the bridge already
// supports (server/bridge/claudeProcess.js) — not a model-name picker, since
// this app has no verified list of installed/available Claude model ids to
// offer without guessing at strings.
effortSelect.addEventListener('change', async () => {
  const where = await setAiField('claude.effort', effortSelect.value);
  appendMessage('system', `Effort "${effortSelect.value}" ${where}, desde la próxima sesión.`);
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

// "Prohibido": la lista del ámbito elegido; en "Solo este repo" se ven también,
// sin poder tocarlas, las de todos los repos (se suman).
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
    empty.textContent = 'No hay skills todavía.';
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

// Campos de IA que un repo puede cambiar: elemento -> ruta en los ajustes.
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

// Debajo de cada campo: de dónde viene el valor y, si este repo lo cambia,
// cómo volver a heredarlo o pasarlo a todos los repos.
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
  // El valor con la etiqueta que ve el usuario en el menú ("Alto", no "high").
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
  // En "Todos los repos" se ve y se edita la capa global; en "Solo este repo",
  // el valor efectivo (heredado o propio).
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
  // Se abre en el último apartado visitado (HIG: "Restore the most recently viewed pane").
  if (!settingsOverlay.dataset.opened) {
    settingsOverlay.dataset.opened = '1';
    let last = null;
    try {
      last = localStorage.getItem('optimia:settings-pane');
    } catch {
      /* sin persistencia */
    }
    if (last) showSettingsPane(last);
  }
  settingsOverlay.hidden = false;
  renderScope();
  settingsSaveStatus.textContent = '';
  claudeAccountInfo.textContent = 'Comprobando...';
  claudeAccountSwitchNote.hidden = true;

  // La cuenta (claude auth status) tarda: va aparte para que no retrase el
  // formulario. Mientras carga, los campos no se pueden editar, asi lo que
  // escribas no lo pisa la carga.
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
  // Los agentes se editan en Ajustes: el compositor y las tarjetas se ponen al dia.
  loadTaskKinds().catch(() => {});
}

function showSettingsPane(pane) {
  const item = [...settingsNavItems].find((i) => i.dataset.pane === pane);
  item?.click();
}

// Abre Ajustes directamente en un apartado (por ejemplo "agents" desde el compositor).
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
      /* sin persistencia */
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

// Como en los Ajustes de macOS, los cambios se aplican al momento: no hay botón
// Guardar. Los menús guardan al cambiar; los campos de texto, al dejar de escribir
// o al salir del campo. Cada cambio va a la capa elegida (todos los repos o este).
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
    modeLabel.textContent = data.ai.mode === 'local' ? 'IA local' : 'Claude Code';
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

// ---- ámbito: todos los repos / solo este repo ----

// Qué apartados admiten los dos ámbitos y cuáles son de uno solo.
const SCOPED_PANES = new Set(['claude', 'local-ai', 'instructions', 'nogo', 'agents']);
const GLOBAL_PANES = new Set(['general', 'appearance', 'monitor']);
let settingsScope = 'global';
try {
  settingsScope = localStorage.getItem('optimia:settings-scope') === 'project' ? 'project' : 'global';
} catch {
  /* sin persistencia */
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
  if (GLOBAL_PANES.has(pane)) scopeNote.textContent = 'Igual en todos los repos.';
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
    /* sin persistencia */
  }
  renderScope();
  if (currentSettings) populateSettingsForm();
  window.dispatchEvent(new CustomEvent('optimia:settings-scope', { detail: scope }));
}

for (const b of scopeControl.querySelectorAll('button')) {
  b.addEventListener('click', () => setSettingsScope(b.dataset.scope));
}

// ---- "Conocer este repo": un agente estudia el repo y propone su memoria ----

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
