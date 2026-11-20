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
 * `canDelete(segment)`: an `rm` the agent may run anyway (see ownFilesOnly).
 */
function checkCommand(command, approved = [], { canDelete } = {}) {
  const exact = String(command || '').trim();
  if (approved.includes(exact)) return null;
  const parts = segments(command);
  // ownFilesOnly resolves paths from the session's folder: not valid once the command moves.
  const movesDir = parts.some((seg) => /^(cd|pushd|popd)(\s|$)/.test(seg));
  for (const seg of parts) {
    const rule = RULES.find((r) => r.re.test(seg));
    if (rule?.id === 'delete' && !movesDir && canDelete?.(seg)) continue;
    if (rule) return rule;
  }
  return null;
}

/**
 * Whether `rm …` only removes what the agent itself created in its worktree: every target is inside
 * `cwd`, is not a symbolic link nor reached through one (dependencies linked from the main repo),
 * and git does not track anything in it. A fresh worktree only has the repo's tracked files, so an
 * untracked path there was made during the task (an install's package-lock.json, a build folder).
 * Anything that cannot be checked (globs, variables, quotes, ~) stays blocked.
 */
function ownFilesOnly(segment, cwd, { tracked } = {}) {
  const fs = require('fs');
  const path = require('path');
  if (!cwd || /[*?[\]{}$`~"'\\]/.test(segment)) return false;
  // Only a plain `rm …` (not `xargs rm`, `find … -delete`, `command rm`…): its words are the targets.
  if (!/^rm(\s|$)/.test(segment.trim())) return false;
  const words = segment.trim().split(/\s+/).slice(1);
  const targets = words.filter((w) => !w.startsWith('-'));
  if (!targets.length || words.some((w) => w === '--')) return false;
  const root = fs.realpathSync(cwd);
  const isTracked =
    tracked ||
    ((rel) => {
      const { spawnSync } = require('child_process');
      const res = spawnSync('git', ['ls-files', '--', rel], { cwd: root, encoding: 'utf8' });
      return res.status !== 0 || res.stdout.trim() !== '';
    });
  return targets.every((t) => {
    if (t.endsWith('/')) return false;
    const abs = path.resolve(root, t);
    if (abs === root || !abs.startsWith(root + path.sep)) return false;
    let st;
    try {
      st = fs.lstatSync(abs);
    } catch (err) {
      return err.code === 'ENOENT'; // already gone: nothing to protect; anything else, blocked
    }
    if (st.isSymbolicLink()) return false;
    // Reached through a symlinked folder: the real path leaves the worktree.
    if (fs.realpathSync(abs) !== abs) return false;
    return !isTracked(path.relative(root, abs));
  });
}

const DENY_PREFIX = 'faradia-policy';

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
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/faradia-policy-check' } }),
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, FARADIA_APPROVED_COMMANDS: '[]' }
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
  ownFilesOnly,
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
