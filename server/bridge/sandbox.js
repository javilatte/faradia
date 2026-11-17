'use strict';

const fs = require('fs');
const path = require('path');

// Claude Code's OS sandbox for agent sessions: Bash can only write inside the task's worktree.
// macOS uses Seatbelt (built in); Linux needs bubblewrap and socat. Without them Claude Code would
// warn and run the commands unsandboxed, so optimia checks first and, when the sandbox is required,
// does not start the agent.

function onPath(bin, envPath = process.env.PATH || '') {
  return envPath.split(path.delimiter).some((dir) => {
    try {
      fs.accessSync(path.join(dir, bin), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** {available, missing: [], install} for this machine. */
function sandboxStatus({ platform = process.platform, has = onPath } = {}) {
  if (platform === 'darwin') {
    const ok = has('sandbox-exec');
    return { available: ok, missing: ok ? [] : ['sandbox-exec'], install: null };
  }
  if (platform === 'linux') {
    const missing = ['bwrap', 'socat'].filter((b) => !has(b));
    const pkgs = missing.map((b) => (b === 'bwrap' ? 'bubblewrap' : b));
    return {
      available: missing.length === 0,
      missing,
      install: missing.length ? `sudo apt install ${pkgs.join(' ')}` : null
    };
  }
  return { available: false, missing: [], install: null, unsupported: true };
}

// The "sandbox" block of the agents' Claude settings.
function sandboxSettings(mode) {
  if (mode === 'off') return undefined;
  return {
    enabled: true,
    // Never fall back to running unsandboxed.
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: true
  };
}

// Why an agent cannot start, or null.
function sandboxProblem(mode, status = sandboxStatus()) {
  if (mode === 'off' || status.available) return null;
  if (status.unsupported) {
    return 'los agentes necesitan el sandbox de Claude Code, que no está disponible en este sistema. Si aceptas el riesgo, desactívalo en Ajustes › General › Seguridad.';
  }
  return `los agentes necesitan el sandbox de Claude Code y faltan ${status.missing.join(' y ')}${status.install ? `: instálalos con «${status.install}»` : ''}. Si aceptas el riesgo, puedes desactivarlo en Ajustes › General › Seguridad.`;
}

module.exports = { sandboxStatus, sandboxSettings, sandboxProblem };
