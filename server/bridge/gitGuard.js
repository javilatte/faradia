'use strict';

const fs = require('fs');
const path = require('path');

// Commits and pushes are always the user's. Permission rules compare text, so a `git -c ... commit`
// slips past them; these hooks run whenever git commits or pushes, whatever the syntax.
const HOOKS = ['pre-commit', 'pre-merge-commit', 'pre-rebase', 'pre-push'];
const MESSAGE = 'faradia: los commits, merges y pushes los hace el usuario, no un agente de tarea.';

function ensureGitGuardHooks(projectRoot) {
  const dir = path.join(projectRoot, '.faradia', 'git-guard');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of HOOKS) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/bin/sh\necho "${MESSAGE}" >&2\nexit 1\n`, { mode: 0o755 });
    fs.chmodSync(file, 0o755);
  }
  return dir;
}

module.exports = { ensureGitGuardHooks };
