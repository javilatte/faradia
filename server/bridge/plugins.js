'use strict';

const { execFile } = require('child_process');

// Claude Code plugins optimia offers, starting with ECC (Everything Claude Code,
// github.com/affaan-m/ECC, MIT): agents, skills and commands for Claude Code. optimia installs it
// with the claude CLI and, by default, enables it only in optimia's own sessions (enabledPlugins in
// the settings file it passes with --settings), leaving the user's plain Claude Code as it was.
// ECC's hooks are off by default: they would run inside every agent stage.

const ECC = {
  id: 'ecc@ecc',
  name: 'ecc',
  marketplace: 'affaan-m/ECC',
  title: 'Everything Claude Code (ECC)',
  url: 'https://github.com/affaan-m/ECC',
  license: 'MIT'
};

function claude(args, { timeout = 60_000, runner = execFile } = {}) {
  return new Promise((resolve, reject) => {
    runner('claude', args, { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.message = String(stderr || stdout || err.message)
          .trim()
          .split('\n')
          .slice(-3)
          .join(' ');
        return reject(err);
      }
      resolve(String(stdout));
    });
  });
}

// One JSON value out of the CLI output (it may print notices before it).
function parseJson(text) {
  const start = text.search(/[[{]/);
  if (start === -1) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

const isEcc = (p) => [p?.id, p?.name, p?.plugin].some((v) => typeof v === 'string' && (v === ECC.id || v === ECC.name));

/** {installed, enabledEverywhere, version, scope} of ECC in the user's Claude Code. */
async function eccStatus(opts = {}) {
  let list = [];
  try {
    list = parseJson(await claude(['plugin', 'list', '--json'], opts)) || [];
  } catch {
    return { ...ECC, installed: false, error: 'no se pudo consultar el CLI de claude' };
  }
  const entry = (Array.isArray(list) ? list : list.plugins || []).find(isEcc);
  return {
    ...ECC,
    installed: Boolean(entry),
    version: entry?.version || null,
    enabledEverywhere: Boolean(entry && entry.enabled !== false),
    scope: entry?.scope || null
  };
}

/**
 * Installs ECC. `everywhere`: also for the user's own Claude Code; otherwise it is disabled there
 * right after installing and optimia enables it in its sessions. `hooks`: ECC's lifecycle hooks.
 */
async function installEcc({ everywhere = false, hooks = false } = {}, opts = {}) {
  await claude(
    [
      'plugin',
      'install',
      ECC.name,
      '--marketplace',
      ECC.marketplace,
      '--scope',
      'user',
      '--config',
      `hooks_enabled=${hooks ? 'true' : 'false'}`,
      '--json',
      '-y'
    ],
    { timeout: 10 * 60 * 1000, ...opts }
  );
  if (!everywhere) await claude(['plugin', 'disable', ECC.id, '--scope', 'user'], opts).catch(() => {});
  return eccStatus(opts);
}

async function setEccEverywhere(enabled, opts = {}) {
  await claude(['plugin', enabled ? 'enable' : 'disable', ECC.id, '--scope', 'user'], opts);
  return eccStatus(opts);
}

async function uninstallEcc(opts = {}) {
  await claude(['plugin', 'uninstall', ECC.id, '--scope', 'user'], opts);
  return eccStatus(opts);
}

// What ECC adds and its projected token cost per session (`claude plugin details`).
async function eccDetails(opts = {}) {
  try {
    return (await claude(['plugin', 'details', ECC.id], opts)).trim();
  } catch {
    return null;
  }
}

/** The enabledPlugins block for optimia's settings files. */
function enabledPluginsSetting(tools) {
  return tools?.ecc ? { [ECC.id]: true } : undefined;
}

module.exports = {
  ECC,
  eccStatus,
  installEcc,
  setEccEverywhere,
  uninstallEcc,
  eccDetails,
  enabledPluginsSetting,
  parseJson
};
