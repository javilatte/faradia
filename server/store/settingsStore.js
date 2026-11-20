'use strict';

const { writeJsonFile } = require('./jsonFile');
const fs = require('fs');
const path = require('path');
const { configDir } = require('./globalPaths');

// Settings in two layers, so every repo works the same way and each one can still have its own:
//
//   global  ~/.config/faradia/settings.json   appearance, model/effort, local AI,
//                                              workflow instructions and the
//                                              "Prohibido" list shared by all repos
//   repo    <repo>/.faradia/settings.json      only what that repo changes (ai.*),
//                                              its own instructions and no-go rules
//                                              (ADDED to the global ones) and the
//                                              permissions approved in its tasks
//
// loadSettings() returns a repo's effective settings (what sessions use); loadSettingsLayers() also
// returns each layer, for Settings.

const THEMES = ['system', 'light', 'dark'];
const CLOCKS = ['datetime', 'time'];
const MODES = ['claude', 'local'];
// Chat dictation (see web/js/project/voice.js).
const VOICE_MODELS = ['auto', 'turbo', 'small', 'base'];
// 'local' was the engine's own value before it became the default ('auto').
const VOICE_ENGINES = ['auto', 'whisper', 'browser'];
const VOICE_LANGUAGES = ['es-en', 'detect', 'es', 'en', 'ca', 'eu', 'gl', 'pt', 'fr', 'it', 'de'];
const PROJECT_VERSION = 2;

// Fields of `ai` a repo can override (dotted paths).
const AI_FIELDS = ['mode', 'claude.model', 'claude.effort', 'localAi.url', 'localAi.model', 'localAi.authHeader'];

function defaultSettings() {
  return {
    ui: { theme: 'system', clock: 'datetime', faces: true },
    ai: {
      mode: 'claude', // 'claude' | 'local'
      claude: { model: 'default', effort: 'high' },
      localAi: { url: '', model: '', authHeader: '' }
    },
    // Skill/agent suggestions while typing in the chat: 'auto' (the local model when it answers fast,
    // else Claude Haiku with low effort) or 'off'.
    suggestions: { mode: 'auto' },
    // pstack's engineering principles in each agent's prompt (see sessionOptions.js).
    principles: { enabled: true },
    voice: defaultVoice(),
    preferences: {
      instructions: '',
      // Claude Code "deny" patterns, e.g. "Read(**/.env*)" or "Bash(rm -rf *)". Passed to faradia's
      // sessions with --settings (claudeSettingsSync.js).
      noGo: [],
      // Permissions the user approved from a task card (see approvalRule in taskStages.js). Always
      // per repo.
      approvedTools: []
    }
  };
}

// Dictation in the chat, always on this computer: the audio never leaves it. engine "auto" is
// Faradia's own engine (voice/localEngine.js), a native process: macOS's speech recognition on a Mac
// and Whisper elsewhere; "whisper" is Whisper even on a Mac; "browser" runs Whisper in the page;
// model "auto" is large-v3-turbo when it runs fast enough and small when not; "es-en" detects which
// of the two languages is spoken.
function defaultVoice() {
  return { enabled: true, engine: 'auto', model: 'auto', language: 'es-en' };
}

function sanitizeVoice(raw) {
  const d = defaultVoice();
  const v = raw && typeof raw === 'object' ? raw : {};
  const pick = (value, list, def) => (list.includes(value) ? value : def);
  return {
    enabled: v.enabled !== false,
    engine: pick(v.engine === 'local' ? 'auto' : v.engine, VOICE_ENGINES, d.engine),
    model: pick(v.model, VOICE_MODELS, d.model),
    language: pick(v.language, VOICE_LANGUAGES, d.language)
  };
}

// ---------- utilidades ----------

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  writeJsonFile(file, value);
}

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    if (!o[k] || typeof o[k] !== 'object') o[k] = {};
    o = o[k];
  }
  o[keys[keys.length - 1]] = value;
}

function deletePath(obj, dotted) {
  const keys = dotted.split('.');
  const parents = [obj];
  for (const k of keys.slice(0, -1)) {
    const next = parents[parents.length - 1]?.[k];
    if (!next || typeof next !== 'object') return;
    parents.push(next);
  }
  delete parents[parents.length - 1][keys[keys.length - 1]];
  // Removes objects left empty.
  for (let i = parents.length - 1; i > 0; i--) {
    if (Object.keys(parents[i]).length === 0) delete parents[i - 1][keys[i - 1]];
  }
}

const strList = (v) =>
  Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()))] : [];
const str = (v) => (typeof v === 'string' ? v : '');

function validAiValue(field, value) {
  if (field === 'mode') return MODES.includes(value);
  return typeof value === 'string';
}

// ---------- capa global ----------

function globalSettingsPath() {
  return path.join(configDir(), 'settings.json');
}

function sanitizeGlobal(raw) {
  const d = defaultSettings();
  const g = raw && typeof raw === 'object' ? raw : {};
  const ai = JSON.parse(JSON.stringify(d.ai));
  for (const field of AI_FIELDS) {
    const v = getPath(g.ai, field);
    if (v !== undefined && validAiValue(field, v)) setPath(ai, field, v);
  }
  return {
    ui: {
      theme: THEMES.includes(g.ui?.theme) ? g.ui.theme : d.ui.theme,
      clock: CLOCKS.includes(g.ui?.clock) ? g.ui.clock : d.ui.clock,
      faces: g.ui?.faces !== false
    },
    ai,
    suggestions: { mode: ['auto', 'off'].includes(g.suggestions?.mode) ? g.suggestions.mode : d.suggestions.mode },
    principles: { enabled: g.principles?.enabled !== false },
    voice: sanitizeVoice(g.voice),
    // Chat permissions: 'auto' (Claude Code's auto mode approves what is safe and asks the rest in
    // the chat) or 'ask' (every action that needs permission is asked; read-only commands are not).
    chat: { permissions: ['auto', 'ask'].includes(g.chat?.permissions) ? g.chat.permissions : 'auto' },
    // Archive of finished tasks: days they are kept (0 = forever). See store/taskArchive.js.
    tasks: { archiveDays: [0, 1, 7, 15, 30].includes(Number(g.tasks?.archiveDays)) ? Number(g.tasks.archiveDays) : 30 },
    preferences: {
      instructions: str(g.preferences?.instructions),
      noGo: strList(g.preferences?.noGo)
    },
    // Notify about new versions (asks the npm registry once a day).
    updates: { check: g.updates?.check !== false },
    // Agents run in Claude Code's OS sandbox (writes only in their worktree). "required": an agent
    // does not start without it; "off": agents run unsandboxed (explicit choice of the user).
    // ECC skills and commands given to every session (null skills = the default selection).
    ecc: {
      skills: Array.isArray(g.ecc?.skills) ? g.ecc.skills.filter((x) => typeof x === 'string').slice(0, 400) : null,
      commands: g.ecc?.commands === true
    },
    // Wikis: an agent updates them after each task, with the local model when there is one.
    wiki: { autoUpdate: g.wiki?.autoUpdate !== false, preferLocal: g.wiki?.preferLocal !== false },
    // FARADIA_AGENT_SANDBOX=off forces it off (test runs with a fake claude).
    security: {
      sandbox: g.security?.sandbox === 'off' || process.env.FARADIA_AGENT_SANDBOX === 'off' ? 'off' : 'required',
      // Agents may reach package registries (npm, PyPI…) to install dependencies.
      registries: g.security?.registries !== false
    }
  };
}

function loadGlobalSettings() {
  return sanitizeGlobal(readJson(globalSettingsPath()));
}

/** Changes the global layer. `patch` may carry ui, ai and preferences.{instructions,noGo}. */
function saveGlobalSettings(patch = {}) {
  const current = loadGlobalSettings();
  const next = {
    ...current,
    ui: { ...current.ui, ...(patch.ui || {}) },
    ai: JSON.parse(JSON.stringify(current.ai)),
    preferences: { ...current.preferences }
  };
  for (const field of AI_FIELDS) {
    const v = getPath(patch.ai, field);
    if (v !== undefined) setPath(next.ai, field, v);
  }
  if (patch.preferences?.instructions !== undefined) next.preferences.instructions = patch.preferences.instructions;
  if (patch.preferences?.noGo !== undefined) next.preferences.noGo = patch.preferences.noGo;
  next.updates = { ...current.updates, ...(patch.updates || {}) };
  next.security = { ...current.security, ...(patch.security || {}) };
  next.wiki = { ...current.wiki, ...(patch.wiki || {}) };
  next.ecc = { ...current.ecc, ...(patch.ecc || {}) };
  next.suggestions = { ...current.suggestions, ...(patch.suggestions || {}) };
  next.principles = { ...current.principles, ...(patch.principles || {}) };
  next.voice = { ...current.voice, ...(patch.voice || {}) };
  next.chat = { ...current.chat, ...(patch.chat || {}) };
  next.tasks = { ...current.tasks, ...(patch.tasks || {}) };
  const clean = sanitizeGlobal(next);
  writeJson(globalSettingsPath(), clean);
  // It may hold API keys.
  try {
    fs.chmodSync(globalSettingsPath(), 0o600);
  } catch {
    /* not supported here */
  }
  return clean;
}

// ---------- repo layer ----------

function settingsPath(projectRoot) {
  return path.join(projectRoot, '.faradia', 'settings.json');
}

function sanitizeProject(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const ai = {};
  for (const field of AI_FIELDS) {
    const v = getPath(p.ai, field);
    if (v !== undefined && validAiValue(field, v)) setPath(ai, field, v);
  }
  return {
    version: PROJECT_VERSION,
    ai,
    preferences: {
      instructions: str(p.preferences?.instructions),
      noGo: strList(p.preferences?.noGo),
      approvedTools: strList(p.preferences?.approvedTools)
    }
  };
}

// Older versions stored a full copy of everything in each repo. On first read it is converted: only
// what differs from the defaults stays as a repo override, and the appearance moves to the global
// layer if that layer does not exist yet.
function migrateLegacy(projectRoot, legacy) {
  const d = defaultSettings();
  const ai = {};
  for (const field of AI_FIELDS) {
    const v = getPath(legacy.ai, field);
    if (v !== undefined && v !== getPath(d.ai, field) && validAiValue(field, v)) setPath(ai, field, v);
  }
  if (!fs.existsSync(globalSettingsPath()) && legacy.ui) {
    const ui = {
      theme: THEMES.includes(legacy.ui.theme) ? legacy.ui.theme : d.ui.theme,
      clock: CLOCKS.includes(legacy.ui.clock) ? legacy.ui.clock : d.ui.clock
    };
    if (ui.theme !== d.ui.theme || ui.clock !== d.ui.clock) saveGlobalSettings({ ui });
  }
  const migrated = sanitizeProject({ ai, preferences: legacy.preferences });
  writeJson(settingsPath(projectRoot), migrated);
  return migrated;
}

function loadProjectLayer(projectRoot) {
  const raw = readJson(settingsPath(projectRoot));
  if (!raw) return sanitizeProject({});
  if (raw.version !== PROJECT_VERSION) return migrateLegacy(projectRoot, raw);
  return sanitizeProject(raw);
}

/**
 * Changes the repo layer. `patch.ai` creates repo overrides; a value equal to the global one stops
 * being an override (it is inherited again). `reset` removes overrides ("ai.claude.model",
 * "preferences.instructions"...).
 */
function saveProjectSettings(projectRoot, patch = {}, { reset = [] } = {}) {
  const global = loadGlobalSettings();
  const next = loadProjectLayer(projectRoot);
  for (const field of AI_FIELDS) {
    const v = getPath(patch.ai, field);
    if (v === undefined) continue;
    if (v === getPath(global.ai, field)) deletePath(next.ai, field);
    else setPath(next.ai, field, v);
  }
  for (const k of ['instructions', 'noGo', 'approvedTools']) {
    if (patch.preferences?.[k] !== undefined) next.preferences[k] = patch.preferences[k];
  }
  for (const dotted of reset) {
    if (dotted.startsWith('ai.')) deletePath(next, dotted);
    else if (dotted === 'preferences.instructions') next.preferences.instructions = '';
    else if (dotted === 'preferences.noGo') next.preferences.noGo = [];
  }
  const clean = sanitizeProject(next);
  writeJson(settingsPath(projectRoot), clean);
  return clean;
}

/** Moves repo overrides to the global layer (they stop being repo overrides). */
function promoteToGlobal(projectRoot, fields) {
  const project = loadProjectLayer(projectRoot);
  const ai = {};
  for (const dotted of fields) {
    if (!dotted.startsWith('ai.')) continue;
    const v = getPath(project, dotted);
    if (v !== undefined) setPath(ai, dotted.slice(3), v);
  }
  saveGlobalSettings({ ai });
  return saveProjectSettings(projectRoot, {}, { reset: fields.filter((f) => f.startsWith('ai.')) });
}

// ---------- ajustes efectivos ----------

function overriddenFields(project) {
  return AI_FIELDS.filter((f) => getPath(project.ai, f) !== undefined).map((f) => `ai.${f}`);
}

function effectiveFrom(global, project) {
  const ai = JSON.parse(JSON.stringify(global.ai));
  for (const field of AI_FIELDS) {
    const v = getPath(project.ai, field);
    if (v !== undefined) setPath(ai, field, v);
  }
  const globalInstructions = global.preferences.instructions.trim();
  const projectInstructions = project.preferences.instructions.trim();
  return {
    ui: global.ui,
    ai,
    security: global.security,
    wiki: global.wiki,
    ecc: global.ecc,
    suggestions: global.suggestions,
    principles: global.principles,
    voice: global.voice,
    chat: global.chat,
    tasks: global.tasks,
    preferences: {
      // The repo's instructions are added to those for all repos.
      instructions: [globalInstructions, projectInstructions].filter(Boolean).join('\n\n'),
      globalInstructions,
      projectInstructions,
      noGo: [...new Set([...global.preferences.noGo, ...project.preferences.noGo])],
      approvedTools: project.preferences.approvedTools
    }
  };
}

function loadSettings(projectRoot) {
  return effectiveFrom(loadGlobalSettings(), loadProjectLayer(projectRoot));
}

function loadSettingsLayers(projectRoot) {
  const global = loadGlobalSettings();
  const project = loadProjectLayer(projectRoot);
  return { global, project, effective: effectiveFrom(global, project), overrides: overriddenFields(project) };
}

/**
 * Compatibility with clients that send the full settings (PUT /api/settings): appearance goes to
 * the global layer; ai is stored as a repo override only where it differs from the global value;
 * instructions and "Prohibido" are the repo's own.
 */
function saveSettings(projectRoot, full) {
  if (full?.ui) saveGlobalSettings({ ui: full.ui });
  const { global, effective } = loadSettingsLayers(projectRoot);
  const patch = { ai: full?.ai, preferences: {} };
  const prefs = full?.preferences || {};
  // If they send back the effective values unchanged (global + repo), the global ones are not
  // copied into the repo.
  if (prefs.instructions !== undefined && prefs.instructions !== effective.preferences.instructions) {
    patch.preferences.instructions = prefs.instructions;
  }
  if (Array.isArray(prefs.noGo)) {
    patch.preferences.noGo = prefs.noGo.filter((r) => !global.preferences.noGo.includes(r));
  }
  if (prefs.approvedTools !== undefined) patch.preferences.approvedTools = prefs.approvedTools;
  return saveProjectSettings(projectRoot, patch);
}

module.exports = {
  AI_FIELDS,
  settingsPath,
  globalSettingsPath,
  defaultSettings,
  loadGlobalSettings,
  saveGlobalSettings,
  loadProjectLayer,
  saveProjectSettings,
  promoteToGlobal,
  loadSettings,
  loadSettingsLayers,
  saveSettings
};
