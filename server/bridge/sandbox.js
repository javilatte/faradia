'use strict';

const fs = require('fs');
const path = require('path');
const { dataDir } = require('../store/globalPaths');

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
// Package registries agents may reach from the sandbox to install dependencies (and nothing else on
// the network).
const PACKAGE_REGISTRIES = [
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'repo.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
  'crates.io',
  'index.crates.io',
  'static.crates.io',
  'proxy.golang.org',
  'sum.golang.org',
  'rubygems.org',
  'index.rubygems.org',
  'repo.maven.apache.org',
  'repo1.maven.org'
];
// Package managers write their caches in the agents' own folder, never in the user's (~/.npm,
// ~/.cargo, ~/.cache…): the user's tools run code from those outside the sandbox, so an agent that
// could write there could get code run without it. Shared by every agent, so a package downloads once.
function agentCacheDir() {
  return path.join(dataDir(), 'agent-cache');
}

/** Environment of an agent session that sends every package manager's cache to agentCacheDir(). */
function agentCacheEnv(dir = agentCacheDir()) {
  fs.mkdirSync(dir, { recursive: true });
  const at = (name) => path.join(dir, name);
  return {
    XDG_CACHE_HOME: at('xdg'), // pip, uv, poetry, go build, pre-commit…
    npm_config_cache: at('npm'), // npm and npx
    npm_config_store_dir: at('pnpm'),
    YARN_CACHE_FOLDER: at('yarn'),
    CARGO_HOME: at('cargo'),
    GOMODCACHE: at('go-mod'),
    BUNDLE_PATH: at('bundle'),
    GRADLE_USER_HOME: at('gradle'),
    MAVEN_OPTS: `-Dmaven.repo.local=${at('maven')}`
  };
}

function sandboxSettings(mode, { registries = true } = {}) {
  if (mode === 'off') return undefined;
  return {
    enabled: true,
    // Never fall back to running unsandboxed.
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: true,
    ...(registries
      ? { network: { allowedDomains: PACKAGE_REGISTRIES }, filesystem: { allowWrite: [agentCacheDir()] } }
      : {})
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

module.exports = { sandboxStatus, sandboxSettings, sandboxProblem, agentCacheDir, agentCacheEnv, PACKAGE_REGISTRIES };
