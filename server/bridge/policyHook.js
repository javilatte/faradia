#!/usr/bin/env node
'use strict';

// PreToolUse hook of agent sessions (see policy.js). Claude Code passes the tool call as JSON on
// stdin; a denial is answered on stdout. FARADIA_APPROVED_COMMANDS (JSON) lists the exact commands
// the user approved from the task cards. It is fixed when the stage starts: an agent cannot grant
// itself an exception by editing a file.

const { checkCommand, denialMessage, ownFilesOnly } = require('./policy');

let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  let call;
  try {
    call = JSON.parse(input);
  } catch {
    return; // nothing to check
  }
  if (call.tool_name !== 'Bash') return;
  let approved = [];
  try {
    approved = JSON.parse(process.env.FARADIA_APPROVED_COMMANDS || '[]');
  } catch {
    approved = [];
  }
  if (!Array.isArray(approved)) approved = [];
  // The agent may delete what it created itself in its worktree (never what git tracks).
  const cwd = call.cwd || process.cwd();
  const rule = checkCommand(call.tool_input?.command, approved, { canDelete: (seg) => ownFilesOnly(seg, cwd) });
  if (!rule) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: denialMessage(rule)
      }
    })
  );
});
