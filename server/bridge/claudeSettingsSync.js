'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { hookWorks, HARD_DENY, FALLBACK_DENY } = require('./policy');
const { sandboxSettings } = require('./sandbox');
const { enabledPluginsSetting } = require('./plugins');
const { loadGlobalSettings } = require('../store/settingsStore');

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

// Claude Code settings that optimia applies ONLY to its own processes (chat, agents and terminal),
// with `claude --settings <file>`. They used to be written to the repo's .claude/settings.json:
// that changed the project's shared (and versioned) configuration, affected the user's and their
// team's normal claude sessions, and replaced whatever deny list the repo already had. With
// --settings the repo is untouched and the repo's own deny rules still add up (verified against the
// real binary: deny, defaultMode and enableAllProjectMcpServers apply from --settings and optimia's
// MCP server connects).
function optimiaClaudeSettingsPath(projectRoot) {
  return path.join(projectRoot, '.optimia', 'claude-settings.json');
}

// Variant for task agents: only the deny list and the MCP approval. No allow list and no
// defaultMode: each stage gets its tools through --allowedTools, and a read-only stage must not
// inherit acceptEdits.
function agentClaudeSettingsPath(projectRoot) {
  return path.join(projectRoot, '.optimia', 'claude-settings-agents.json');
}

// Path of the repo's .claude/settings.json (only to read, import or clean up).
// The same node that runs optimia (with nvm, "node" may not be on the PATH the hook gets).
function policyHookCommand() {
  const quote = (p) => `"${p.replace(/(["\\$`])/g, '\\$1')}"`;
  return `${quote(process.execPath)} ${quote(path.join(__dirname, 'policyHook.js'))}`;
}

// Checked once per process: the hook script and node do not change while optimia runs.
let hookCheck = null;
function policyHookWorks() {
  if (hookCheck === null) hookCheck = hookWorks(policyHookCommand());
  return hookCheck;
}

function claudeSettingsPath(projectRoot) {
  return path.join(projectRoot, '.claude', 'settings.json');
}

function buildClaudeSettings(noGo) {
  return {
    // Loading an MCP server through --mcp-config needs this approval on top of the tool permissions
    // (verified against the real binary).
    enableAllProjectMcpServers: true,
    permissions: {
      allow: [...DEFAULT_ALLOW],
      deny: Array.isArray(noGo) ? noGo : [],
      defaultMode: DEFAULT_MODE
    }
  };
}

/**
 * Regenerates .optimia/claude-settings.json from the user's "Prohibido" list
 * (settings.preferences.noGo). Returns the path for --settings.
 */
function syncClaudeSettings(projectRoot, noGo) {
  const file = optimiaClaudeSettingsPath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const global = loadGlobalSettings();
  // Plugins enabled only in optimia's sessions (ECC...).
  const plugins = enabledPluginsSetting(global.tools);
  const settings = { ...buildClaudeSettings(noGo), ...(plugins ? { enabledPlugins: plugins } : {}) };
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  // Agents: the safety policy (policy.js) runs as a hook so the user can approve exceptions; if the
  // hook cannot run, plain deny rules take its place (fail closed). Commit, push, merge and rebase
  // are always denied. The OS sandbox keeps Bash writes inside the worktree.
  const hookOk = policyHookWorks();
  const sandbox = sandboxSettings(global.security.sandbox);
  const agents = {
    enableAllProjectMcpServers: true,
    permissions: { deny: [...settings.permissions.deny, ...HARD_DENY, ...(hookOk ? [] : FALLBACK_DENY)] },
    ...(hookOk
      ? { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: policyHookCommand() }] }] } }
      : {}),
    ...(sandbox ? { sandbox } : {}),
    ...(plugins ? { enabledPlugins: plugins } : {})
  };
  fs.writeFileSync(agentClaudeSettingsPath(projectRoot), JSON.stringify(agents, null, 2) + '\n');
  cleanupLegacyClaudeSettings(projectRoot, noGo);
  return file;
}

// Older versions left .claude/settings.json in the repo. It is removed only if optimia generated it
// (its keys and its allow list, nothing else), git does not track it and its deny list is already
// in optimia's (otherwise the import notice in Settings offers it first). If the user changed or
// versioned it, it is left alone.
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
    fs.rmdirSync(path.dirname(file)); // only if it is empty now
  } catch {
    /* there is more in .claude/ */
  }
  return true;
}

module.exports = {
  policyHookCommand,
  policyHookWorks,
  claudeSettingsPath,
  optimiaClaudeSettingsPath,
  agentClaudeSettingsPath,
  buildClaudeSettings,
  syncClaudeSettings,
  cleanupLegacyClaudeSettings,
  DEFAULT_ALLOW,
  DEFAULT_MODE
};
