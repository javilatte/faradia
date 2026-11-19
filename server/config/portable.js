'use strict';

const fs = require('fs');
const path = require('path');
const { configDir } = require('../store/globalPaths');
const { loadGlobalSettings, saveGlobalSettings, globalSettingsPath } = require('../store/settingsStore');
const { loadPrefs, savePrefs } = require('../store/globalPrefs');
const catalog = require('../agents/catalog');
const { eccAgents } = require('../ecc/library');
const { MAPPABLE } = require('../agents/stageMap');
const { STAGES } = require('../bridge/taskStages');
const pkg = require('../../package.json');

// Portable configuration: everything global in optimia, in one JSON file the user
// keeps wherever they want (it is private: it holds their instructions and their
// agents' prompts) and imports by dropping it on the browser, e.g. when installing
// optimia on another machine. It contains:
//   settings     appearance, model/effort, local AI, global instructions and no-go list
//   agents       the global agents (their .md files as they are)
//   stageMap     which agent runs each stage (global)
//   preferences  signals, thresholds and notifications
// Security (sandbox, package registries) is exported for reference but not imported: whether the
// sandbox can run depends on each machine.
// It leaves out what depends on the machine (workbenches, repo paths, watchlists)
// and what belongs to each repo (its memory and overrides). The local AI auth
// header is a secret: it is only included on request.

const FORMAT = 'optimia-config';
const FORMAT_VERSION = 1;
const MAX_AGENTS = 100;
const MAX_TEXT = 50_000;
const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

function stateFile() {
  return path.join(configDir(), 'state.json');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function globalAgentFiles() {
  const dir = catalog.globalAgentsDir();
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.md') && ID_RE.test(n.slice(0, -3)))
      .sort()
      .map((n) => ({ id: n.slice(0, -3), content: fs.readFileSync(path.join(dir, n), 'utf8') }));
  } catch {
    return [];
  }
}

function globalStageMapFile() {
  return path.join(catalog.globalAgentsDir(), 'stages.json');
}

// ---------- export ----------

function exportConfig({ includeSecrets = false } = {}) {
  const settings = loadGlobalSettings();
  if (!includeSecrets) {
    settings.ai.localAi.authHeader = '';
  }
  return {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    optimiaVersion: pkg.version,
    secretsIncluded: Boolean(includeSecrets),
    settings,
    agents: globalAgentFiles(),
    stageMap: readJson(globalStageMapFile(), {}),
    preferences: loadPrefs()
  };
}

// ---------- validation ----------

class ConfigError extends Error {}

function validateAgent(entry, i) {
  if (!entry || typeof entry !== 'object') throw new ConfigError(`agents[${i}] no es un objeto`);
  if (typeof entry.id !== 'string' || !ID_RE.test(entry.id)) throw new ConfigError(`agents[${i}]: id no válido`);
  if (typeof entry.content !== 'string' || entry.content.length > MAX_TEXT) {
    throw new ConfigError(`agente "${entry.id}": contenido no válido o demasiado largo`);
  }
  const { fields, prompt } = catalog.parseAgentFile(entry.content);
  if (fields.engine !== undefined && !catalog.ENGINES.includes(fields.engine)) {
    throw new ConfigError(`agente "${entry.id}": motor no válido`);
  }
  if (fields.access !== undefined && !catalog.ACCESS.includes(fields.access)) {
    throw new ConfigError(`agente "${entry.id}": acceso no válido`);
  }
  if (fields.effort !== undefined && !catalog.EFFORTS.includes(fields.effort)) {
    throw new ConfigError(`agente "${entry.id}": effort no válido`);
  }
  // Rewritten with optimia's own serializer: known fields only.
  const clean = {};
  for (const k of ['name', 'description', 'engine', 'model', 'effort', 'access', 'enabled']) {
    if (fields[k] !== undefined) clean[k] = fields[k];
  }
  return { id: entry.id, content: catalog.serializeAgent({ ...clean, prompt }), name: clean.name || entry.id };
}

/** Checks and normalizes an imported file. Throws ConfigError with a user-facing reason. */
function validateConfig(raw) {
  if (!raw || typeof raw !== 'object' || raw.format !== FORMAT) {
    throw new ConfigError('no es un fichero de configuración de optimia');
  }
  if (raw.formatVersion !== FORMAT_VERSION) {
    throw new ConfigError(
      `formato ${raw.formatVersion} no compatible con esta versión de optimia (${pkg.version}); actualiza optimia`
    );
  }
  const agents = Array.isArray(raw.agents) ? raw.agents : [];
  if (agents.length > MAX_AGENTS) throw new ConfigError('demasiados agentes');
  const normalizedAgents = agents.map(validateAgent);
  const ids = new Set(normalizedAgents.map((a) => a.id));
  if (ids.size !== normalizedAgents.length) throw new ConfigError('hay agentes repetidos');
  const instructions = raw.settings?.preferences?.instructions;
  if (instructions !== undefined && (typeof instructions !== 'string' || instructions.length > MAX_TEXT)) {
    throw new ConfigError('instrucciones no válidas o demasiado largas');
  }
  const stageMap = {};
  const warnings = [];
  const known = new Set([...catalog.BUILTIN_AGENTS.map((a) => a.id), ...eccAgents().map((a) => a.id), ...ids]);
  for (const [stage, agentId] of Object.entries(raw.stageMap && typeof raw.stageMap === 'object' ? raw.stageMap : {})) {
    if (!MAPPABLE.includes(stage)) {
      warnings.push(`etapa desconocida "${stage}": se ignora`);
      continue;
    }
    if (typeof agentId !== 'string' || !known.has(agentId)) {
      warnings.push(`la etapa "${STAGES[stage].label}" apunta a un agente que no existe: se ignora`);
      continue;
    }
    stageMap[stage] = agentId;
  }
  return {
    exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : null,
    optimiaVersion: typeof raw.optimiaVersion === 'string' ? raw.optimiaVersion : null,
    secretsIncluded: raw.secretsIncluded === true,
    settings: raw.settings && typeof raw.settings === 'object' ? raw.settings : {},
    agents: normalizedAgents,
    stageMap,
    preferences: raw.preferences && typeof raw.preferences === 'object' ? raw.preferences : null,
    warnings
  };
}

// ---------- preview and import ----------

/** What an import would change, to show the user before applying it. */
function previewImport(raw) {
  const cfg = validateConfig(raw);
  const current = loadGlobalSettings();
  const currentAgents = new Map(globalAgentFiles().map((a) => [a.id, a.content]));
  const importIds = new Set(cfg.agents.map((a) => a.id));
  const builtin = new Set([...catalog.BUILTIN_AGENTS.map((a) => a.id), ...eccAgents().map((a) => a.id)]);
  const label = (id, name) => (builtin.has(id) ? `${name} (ajustes del agente por defecto)` : name);
  const s = cfg.settings;
  const changes = [];
  const differs = (a, b) => JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
  if (s.ui && differs({ ...current.ui, ...s.ui }, current.ui)) changes.push('Apariencia');
  if (s.ai) {
    const next = JSON.parse(JSON.stringify(s.ai));
    if (!cfg.secretsIncluded && next.localAi) next.localAi.authHeader = current.ai.localAi.authHeader;
    if (differs({ ...current.ai, ...next }, current.ai)) changes.push('Modelo, effort e IA local');
  }
  if (s.preferences?.instructions !== undefined && s.preferences.instructions !== current.preferences.instructions) {
    changes.push('Instrucciones para todos los repos');
  }
  if (s.preferences?.noGo !== undefined && differs(s.preferences.noGo, current.preferences.noGo)) {
    changes.push('Lista "Prohibido" para todos los repos');
  }
  if (cfg.preferences && differs(cfg.preferences, loadPrefs())) changes.push('Avisos y notificaciones');
  return {
    exportedAt: cfg.exportedAt,
    optimiaVersion: cfg.optimiaVersion,
    secretsIncluded: cfg.secretsIncluded,
    settings: changes,
    instructionsPreview: (s.preferences?.instructions || '').slice(0, 600),
    agents: {
      added: cfg.agents.filter((a) => !currentAgents.has(a.id)).map((a) => label(a.id, a.name)),
      updated: cfg.agents
        .filter((a) => currentAgents.has(a.id) && currentAgents.get(a.id) !== a.content)
        .map((a) => label(a.id, a.name)),
      removed: [...currentAgents.keys()].filter((id) => !importIds.has(id))
    },
    stages: Object.keys(cfg.stageMap).length,
    warnings: cfg.warnings
  };
}

// Backup of the global configuration before an import, in
// ~/.config/optimia/backups/<date>/ (the last 10 are kept).
function backupGlobal() {
  const root = path.join(configDir(), 'backups');
  const dir = path.join(root, new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, 'optimia-config.json'), exportConfig({ includeSecrets: true }));
  // Copies set aside by sync (…-sync-remote) rotate on their own (sync/engine.js).
  const all = fs
    .readdirSync(root)
    .filter((n) => !/-sync-[a-z]+$/.test(n))
    .sort();
  for (const old of all.slice(0, Math.max(0, all.length - 10))) {
    fs.rmSync(path.join(root, old), { recursive: true, force: true });
  }
  return dir;
}

/**
 * Imports a configuration: replaces everything global (global agents included)
 * with the file's content, after a backup. If the file carries no secrets, the
 * current auth header is kept.
 */
function importConfig(raw) {
  const cfg = validateConfig(raw);
  const backup = backupGlobal();
  const current = loadGlobalSettings();
  const s = cfg.settings;
  const ai = s.ai && typeof s.ai === 'object' ? JSON.parse(JSON.stringify(s.ai)) : undefined;
  if (ai && !cfg.secretsIncluded) {
    ai.localAi = { ...(ai.localAi || {}), authHeader: current.ai.localAi.authHeader };
  }
  saveGlobalSettings({
    ui: s.ui,
    ai,
    suggestions: s.suggestions,
    chat: s.chat,
    tasks: s.tasks,
    wiki: s.wiki,
    ecc: s.ecc,
    preferences: s.preferences ? { instructions: s.preferences.instructions, noGo: s.preferences.noGo } : undefined,
    updates: s.updates
  });

  const dir = catalog.globalAgentsDir();
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.md')) fs.rmSync(path.join(dir, name));
  }
  for (const a of cfg.agents) fs.writeFileSync(path.join(dir, `${a.id}.md`), a.content);
  writeJson(globalStageMapFile(), cfg.stageMap);
  if (cfg.preferences) savePrefs(cfg.preferences);
  markWelcomed();
  return { backup, agents: cfg.agents.length, warnings: cfg.warnings };
}

// ---------- first run ----------

/** First time optimia 2 opens on this machine: nothing global exists yet. */
function isFirstRun() {
  if (readJson(stateFile(), {}).welcomed) return false;
  return !fs.existsSync(globalSettingsPath()) && globalAgentFiles().length === 0;
}

function markWelcomed() {
  writeJson(stateFile(), { ...readJson(stateFile(), {}), welcomed: new Date().toISOString() });
}

// ---------- what's new ----------

/** Last version whose "what's new" tour was shown (or skipped), or null. */
function tourSeen() {
  return readJson(stateFile(), {}).tourSeen || null;
}

function markTourSeen(version) {
  writeJson(stateFile(), { ...readJson(stateFile(), {}), tourSeen: String(version).slice(0, 20) });
}

module.exports = {
  tourSeen,
  markTourSeen,
  FORMAT,
  FORMAT_VERSION,
  ConfigError,
  exportConfig,
  validateConfig,
  previewImport,
  importConfig,
  isFirstRun,
  markWelcomed
};
