'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Baseline allow-list and mode — not user-editable via the Settings UI for
// now ("No-go files & commands" only edits the deny side). Mirrors what the
// old wizard used to generate per project.
const DEFAULT_ALLOW = [
  'Read',
  'Glob',
  'Grep',
  'LS',
  'Edit',
  'MultiEdit',
  'Write(src/**)',
  'Write(tests/**)',
  'Write(docs/**)',
  'Bash(npm run *)',
  'Bash(npm test *)',
  'Bash(npx tsc *)',
  'Bash(npx prettier *)',
  'Bash(npx eslint *)',
  'Bash(git status)',
  'Bash(git diff *)',
  'Bash(git log *)',
  'Bash(git add *)',
  // Pre-granted so background work (task worktrees, subagents spawned via
  // the Agent tool) runs end-to-end without hitting the terminal handoff
  // for routine research — only a genuinely unexpected tool should still
  // deny and hand off.
  'WebSearch',
  'WebFetch',
  // Names verified against a real --mcp-config session's stream-json "init"
  // event (mcp__<server-key-in-mcp.json>__<tool-name>), not guessed.
  'mcp__optimia-tasks__create_task',
  'mcp__optimia-tasks__update_task_progress'
];
const DEFAULT_MODE = 'acceptEdits';

// Ajustes de Claude Code que optimia aplica SOLO a sus propios procesos (chat,
// agentes y terminal), con `claude --settings <fichero>`. Antes se escribian en
// .claude/settings.json del repo: eso cambiaba la configuracion compartida (y
// versionada) del proyecto, afectaba a las sesiones normales de claude del
// usuario y de su equipo, y sustituia la lista deny que el repo ya tuviera. Con
// --settings el repo no se toca y las reglas deny del repo siguen sumandose
// (verificado con el binario real: deny, defaultMode y enableAllProjectMcpServers
// se aplican desde --settings y el MCP de optimia conecta).
function optimiaClaudeSettingsPath(projectRoot) {
  return path.join(projectRoot, '.optimia', 'claude-settings.json');
}

// Variante para los agentes de las tareas: solo las prohibiciones y la aprobacion
// del MCP. Sin allow ni defaultMode: cada etapa recibe sus herramientas con
// --allowedTools y una etapa de solo lectura no debe heredar acceptEdits.
function agentClaudeSettingsPath(projectRoot) {
  return path.join(projectRoot, '.optimia', 'claude-settings-agents.json');
}

// Ruta del .claude/settings.json del repo (solo para leer/importar o limpiar).
function claudeSettingsPath(projectRoot) {
  return path.join(projectRoot, '.claude', 'settings.json');
}

function buildClaudeSettings(noGo) {
  return {
    // Cargar un servidor MCP por --mcp-config necesita esta aprobacion, ademas de
    // los permisos de herramientas (verificado con el binario real).
    enableAllProjectMcpServers: true,
    permissions: {
      allow: [...DEFAULT_ALLOW],
      deny: Array.isArray(noGo) ? noGo : [],
      defaultMode: DEFAULT_MODE
    }
  };
}

/**
 * Regenera .optimia/claude-settings.json a partir de la lista "prohibido" del
 * usuario (settings.preferences.noGo). Devuelve la ruta para --settings.
 */
function syncClaudeSettings(projectRoot, noGo) {
  const file = optimiaClaudeSettingsPath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const settings = buildClaudeSettings(noGo);
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  const agents = {
    enableAllProjectMcpServers: true,
    permissions: { deny: settings.permissions.deny }
  };
  fs.writeFileSync(agentClaudeSettingsPath(projectRoot), JSON.stringify(agents, null, 2) + '\n');
  cleanupLegacyClaudeSettings(projectRoot, noGo);
  return file;
}

// Versiones anteriores dejaban .claude/settings.json en el repo. Se borra solo si
// lo genero optimia (sus claves y su lista allow, nada mas), git no lo sigue y su
// lista deny ya esta en la de optimia (si no, el aviso de importacion de Ajustes
// la ofrece primero). Si el usuario lo ha cambiado o versionado, se deja tal cual.
function cleanupLegacyClaudeSettings(projectRoot, noGo = []) {
  const file = claudeSettingsPath(projectRoot);
  let current;
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
  const keys = Object.keys(current).sort().join(',');
  const permKeys = Object.keys(current.permissions || {})
    .sort()
    .join(',');
  const allow = current.permissions?.allow || [];
  const generated =
    keys === 'enableAllProjectMcpServers,permissions' &&
    permKeys === 'allow,defaultMode,deny' &&
    current.permissions.defaultMode === DEFAULT_MODE &&
    allow.length === DEFAULT_ALLOW.length &&
    DEFAULT_ALLOW.every((rule) => allow.includes(rule));
  if (!generated) return false;
  const deny = Array.isArray(current.permissions.deny) ? current.permissions.deny : [];
  if (!deny.every((rule) => noGo.includes(rule))) return false;
  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '.claude/settings.json'], {
    cwd: projectRoot,
    stdio: 'ignore'
  });
  if (tracked.status === 0) return false;
  fs.rmSync(file);
  try {
    fs.rmdirSync(path.dirname(file)); // solo si queda vacia
  } catch {
    /* hay mas cosas en .claude/ */
  }
  return true;
}

module.exports = {
  claudeSettingsPath,
  optimiaClaudeSettingsPath,
  agentClaudeSettingsPath,
  buildClaudeSettings,
  syncClaudeSettings,
  cleanupLegacyClaudeSettings,
  DEFAULT_ALLOW,
  DEFAULT_MODE
};
