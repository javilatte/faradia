'use strict';

const fs = require('fs');
const path = require('path');
const { configDir } = require('./globalPaths');

// Ajustes en dos capas, para que todos los repos trabajen igual y cada uno pueda
// tener lo suyo:
//
//   global  ~/.config/optimia/settings.json   apariencia, modelo/effort, IA local,
//                                              instrucciones de flujo de trabajo y
//                                              lista "Prohibido" comunes a todos
//   repo    <repo>/.optimia/settings.json      solo lo que ese repo cambia (ai.*),
//                                              sus instrucciones y prohibiciones
//                                              propias (se SUMAN a las globales) y
//                                              los permisos aprobados en sus tareas
//
// loadSettings() devuelve los ajustes efectivos de un repo (lo que usan las
// sesiones); loadSettingsLayers() devuelve además cada capa, para Ajustes.

const THEMES = ['system', 'light', 'dark'];
const CLOCKS = ['datetime', 'time'];
const MODES = ['claude', 'local'];
const PROJECT_VERSION = 2;

// Campos de `ai` que un repo puede cambiar (rutas con puntos).
const AI_FIELDS = ['mode', 'claude.model', 'claude.effort', 'localAi.url', 'localAi.model', 'localAi.authHeader'];

function defaultSettings() {
  return {
    ui: { theme: 'system', clock: 'datetime' },
    ai: {
      mode: 'claude', // 'claude' | 'local'
      claude: { model: 'default', effort: 'high' },
      localAi: { url: '', model: '', authHeader: '' }
    },
    preferences: {
      instructions: '',
      // Patrones "deny" de Claude Code, p. ej. "Read(**/.env*)" o "Bash(rm -rf *)".
      // Se pasan a las sesiones de optimia con --settings (claudeSettingsSync.js).
      noGo: [],
      // Permisos que el usuario aprobo desde una tarjeta de tarea (ver
      // approvalRule en taskStages.js). Siempre del repo.
      approvedTools: []
    }
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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
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
  // Quita los objetos que se hayan quedado vacios.
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
      clock: CLOCKS.includes(g.ui?.clock) ? g.ui.clock : d.ui.clock
    },
    ai,
    preferences: {
      instructions: str(g.preferences?.instructions),
      noGo: strList(g.preferences?.noGo)
    },
    // Notify about new versions (asks the npm registry once a day).
    updates: { check: g.updates?.check !== false }
  };
}

function loadGlobalSettings() {
  return sanitizeGlobal(readJson(globalSettingsPath()));
}

/** Cambia la capa global. `patch` puede traer ui, ai y preferences.{instructions,noGo}. */
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
  const clean = sanitizeGlobal(next);
  writeJson(globalSettingsPath(), clean);
  return clean;
}

// ---------- capa del repo ----------

function settingsPath(projectRoot) {
  return path.join(projectRoot, '.optimia', 'settings.json');
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

// Las versiones anteriores guardaban en cada repo una copia completa de todo. Al
// leerla por primera vez se convierte: se queda como cambio del repo solo lo que
// difiere de los valores por defecto, y la apariencia pasa a la capa global si
// esta aun no existe.
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
 * Cambia la capa del repo. `patch.ai` crea cambios propios del repo; un valor
 * igual al global deja de ser un cambio (vuelve a heredarse). `reset` quita
 * cambios ("ai.claude.model", "preferences.instructions"...).
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

/** Pasa cambios del repo a la capa global (y deja de ser un cambio del repo). */
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
    preferences: {
      // Las instrucciones del repo se suman a las de todos los repos.
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
 * Compatibilidad con clientes que envian los ajustes completos (PUT /api/settings):
 * la apariencia va a la capa global; ai se guarda como cambio del repo solo donde
 * difiere de la global; instrucciones y "Prohibido" son las del repo.
 */
function saveSettings(projectRoot, full) {
  if (full?.ui) saveGlobalSettings({ ui: full.ui });
  const { global, effective } = loadSettingsLayers(projectRoot);
  const patch = { ai: full?.ai, preferences: {} };
  const prefs = full?.preferences || {};
  // Si devuelven los valores efectivos tal cual (globales + del repo), no se
  // copian las globales dentro del repo.
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
