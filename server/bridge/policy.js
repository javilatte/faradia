'use strict';

// Safety policy for agent sessions, applied by a PreToolUse hook (policyHook.js) instead of deny
// rules: a deny rule always wins in Claude Code and admits no exceptions, while the hook can let
// through the exact commands the user approved from the task card, even in the middle of a stage.
// The agent gets the reason and carries on another way; it never stops the stage.

// Each rule: what it blocks, why (for the agent and for the card) and whether the user can approve
// it. Commit, push, merge and rebase are the user's actions from the card (Commit, Crear PR).
const RULES = [
  { id: 'delete', re: /^rm(\s|$)/, reason: 'borrar ficheros', approvable: true },
  { id: 'sudo', re: /^sudo(\s|$)/, reason: 'ejecutar como administrador (sudo)', approvable: true },
  { id: 'chmod-r', re: /^chmod\s+(-\w*R|--recursive)/, reason: 'cambiar permisos en bloque', approvable: true },
  { id: 'find-delete', re: /^find\s.*\s-delete(\s|$)/, reason: 'borrar ficheros con find', approvable: true },
  { id: 'reset-hard', re: /^git\s+reset\s+.*--hard/, reason: 'descartar cambios (git reset --hard)', approvable: true },
  { id: 'clean', re: /^git\s+clean(\s|$)/, reason: 'borrar ficheros sin seguimiento (git clean)', approvable: true },
  {
    id: 'discard',
    re: /^git\s+(checkout\s+--(\s|$)|restore(\s|$))/,
    reason: 'descartar cambios de ficheros',
    approvable: true
  },
  { id: 'branch-delete', re: /^git\s+branch\s+.*-[dD](\s|$)/, reason: 'borrar ramas', approvable: true },
  { id: 'worktree-remove', re: /^git\s+worktree\s+remove/, reason: 'borrar worktrees', approvable: true },
  { id: 'stash-drop', re: /^git\s+stash\s+(drop|clear)/, reason: 'borrar stashes', approvable: true },
  {
    id: 'git-history',
    re: /^git\s+(commit|push|merge|rebase)(\s|$)/,
    reason: 'hacer commit, push, merge o rebase: los haces tú desde la tarjeta (Commit, Crear PR)',
    approvable: false
  }
];

// `git -c a=b --no-pager commit` -> `git commit`; env assignments and `command`/`exec` prefixes go
// too, so the rules see the real program.
function normalize(segment) {
  let s = segment.trim().replace(/^\(+|\)+$/g, '');
  s = s.replace(/^((\w+=\S*|command|exec|env)\s+)+/, '');
  if (/^git\s/.test(s)) s = s.replace(/^git((\s+(-c\s+\S+|-C\s+\S+|--[\w-]+(=\S+)?))+)/, 'git');
  return s;
}

// A command line split into the commands it runs (`a && b; c | d`).
function segments(command) {
  return String(command || '')
    .split(/&&|\|\||;|\||\n|\$\(|`/)
    .map(normalize)
    .filter(Boolean);
}

/**
 * The rule a Bash command breaks, or null. `approved` holds exact commands the user allowed.
 */
function checkCommand(command, approved = []) {
  const exact = String(command || '').trim();
  if (approved.includes(exact)) return null;
  for (const seg of segments(command)) {
    const rule = RULES.find((r) => r.re.test(seg));
    if (rule) return rule;
  }
  return null;
}

const DENY_PREFIX = 'optimia-policy';

// Message the agent receives (and the runtime recognizes in the tool result).
function denialMessage(rule) {
  const how = rule.approvable
    ? 'Si es imprescindible, explica en tu respuesta para qué lo necesitas: el usuario puede permitirlo desde la tarjeta.'
    : 'No lo intentes de otra forma.';
  return `${DENY_PREFIX}[${rule.id}]: los agentes no pueden ${rule.reason}. Sigue con la tarea sin esta acción. ${how}`;
}

// The rule id out of a denied tool result, or null if it was not this policy.
function parseDenial(text) {
  const m = new RegExp(`${DENY_PREFIX}\\[([\\w-]+)\\]`).exec(String(text || ''));
  return m ? RULES.find((r) => r.id === m[1]) || null : null;
}

// Exact commands approved in this repo: the Bash(...) rules of preferences.approvedTools.
function approvedCommands(approvedTools = []) {
  return approvedTools
    .map((r) => /^Bash\((.*)\)$/.exec(r))
    .filter(Boolean)
    .map((m) => m[1]);
}

// Runs the hook the way Claude Code does and checks that it really blocks: if it cannot (no node,
// a broken install), agent sessions fall back to plain deny rules. Fail closed, never open.
function hookWorks(command) {
  const { spawnSync } = require('child_process');
  const [bin, script] = command.match(/"((?:[^"\\]|\\.)*)"/g).map((q) => JSON.parse(q));
  const res = spawnSync(bin, [script], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/optimia-policy-check' } }),
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, OPTIMIA_APPROVED_COMMANDS: '[]' }
  });
  try {
    return JSON.parse(res.stdout).hookSpecificOutput.permissionDecision === 'deny';
  } catch {
    return false;
  }
}

// Plain deny rules equivalent to the policy, for when the hook cannot run (no exceptions possible).
const FALLBACK_DENY = [
  'Bash(rm *)',
  'Bash(sudo *)',
  'Bash(chmod -R *)',
  'Bash(find * -delete*)',
  'Bash(git reset --hard*)',
  'Bash(git clean *)',
  'Bash(git checkout -- *)',
  'Bash(git restore *)',
  'Bash(git branch -D *)',
  'Bash(git branch -d *)',
  'Bash(git worktree remove *)',
  'Bash(git stash drop*)'
];
// Never approvable: always deny rules as well, on top of the hook and the git hook.
const HARD_DENY = [
  'Bash(git commit*)',
  'Bash(git push*)',
  'Bash(git merge*)',
  'Bash(git rebase*)',
  'Bash(git -c * commit*)',
  'Bash(git -c * push*)',
  'Bash(git -c * merge*)',
  'Bash(git -c * rebase*)'
];

module.exports = {
  RULES,
  DENY_PREFIX,
  segments,
  checkCommand,
  denialMessage,
  parseDenial,
  approvedCommands,
  hookWorks,
  FALLBACK_DENY,
  HARD_DENY
};
