'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// optimia is now Faradia. What the old name left on this computer is moved once, at start:
//   ~/.config/optimia       -> ~/.config/faradia
//   ~/.local/share/optimia  -> ~/.local/share/faradia
//   <repo>/.optimia         -> <repo>/.faradia   (when the repo is opened)
// plus the OPTIMIA_* environment variables, read as FARADIA_*. Nothing is moved over a folder that
// already exists: then the old one stays where it is, untouched.

const LEGACY = 'optimia';
const LEGACY_REPO_DIR = '.optimia';
const REPO_DIR = '.faradia';

/** OPTIMIA_X is read as FARADIA_X when FARADIA_X is not set. */
function adoptLegacyEnv(env = process.env) {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('OPTIMIA_')) continue;
    const next = `FARADIA_${key.slice('OPTIMIA_'.length)}`;
    if (env[next] === undefined) env[next] = value;
  }
}

function base(kind, env) {
  if (kind === 'config') return env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
}

function moveIfAlone(from, to) {
  if (!fs.existsSync(from) || fs.existsSync(to)) return false;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  return true;
}

/** Moves the global config and data folders. Returns what moved, as [from, to] pairs. */
function migrateGlobal(env = process.env) {
  const moved = [];
  for (const kind of ['config', 'data']) {
    const from = path.join(base(kind, env), LEGACY);
    const to = path.join(base(kind, env), 'faradia');
    try {
      if (moveIfAlone(from, to)) moved.push([from, to]);
    } catch {
      /* left where it is: the old data is still there for whoever needs it */
    }
  }
  return moved;
}

// Something already created .faradia (a log, a settings file) before the old folder was moved:
// what .faradia does not have yet moves in; the rest stays in .optimia, which is removed if empty.
function mergeInto(from, to) {
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name);
    const dest = path.join(to, name);
    if (!fs.existsSync(dest)) fs.renameSync(src, dest);
    else if (fs.statSync(src).isDirectory() && fs.statSync(dest).isDirectory()) mergeInto(src, dest);
  }
  try {
    fs.rmdirSync(from);
  } catch {
    /* something could not move: kept */
  }
}

// Paths saved in a repo's task files that pointed into the old folders.
function rewritePaths(file, pairs) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  let next = text;
  for (const [from, to] of pairs) {
    next = next.split(JSON.stringify(from).slice(1, -1)).join(JSON.stringify(to).slice(1, -1));
  }
  if (next !== text) fs.writeFileSync(file, next);
}

/**
 * Moves <repo>/.optimia to <repo>/.faradia, points the saved task worktrees at their new place and
 * lets git know where they are now. Returns true when it moved the folder.
 */
function migrateRepo(projectRoot, env = process.env) {
  const from = path.join(projectRoot, LEGACY_REPO_DIR);
  const to = path.join(projectRoot, REPO_DIR);
  if (!fs.existsSync(from)) return false;
  try {
    if (!moveIfAlone(from, to)) mergeInto(from, to);
  } catch {
    return false;
  }
  const oldData = path.join(base('data', env), LEGACY);
  const newData = path.join(base('data', env), 'faradia');
  const pairs = [
    [`${from}${path.sep}`, `${to}${path.sep}`],
    [`${oldData}${path.sep}`, `${newData}${path.sep}`]
  ];
  for (const name of ['tasks.json', 'tasks-archive.json']) rewritePaths(path.join(to, name), pairs);
  // CodeGraph's link into the old folder.
  const link = path.join(projectRoot, '.codegraph');
  try {
    const target = fs.readlinkSync(link);
    if (path.resolve(projectRoot, target).startsWith(`${from}${path.sep}`)) {
      fs.unlinkSync(link);
      fs.symlinkSync(path.join(to, path.relative(from, path.resolve(projectRoot, target))), link);
    }
  } catch {
    /* no link */
  }
  // Worktrees inside the old folder moved with it: git still has their old paths.
  const worktrees = [];
  try {
    const tasks = JSON.parse(fs.readFileSync(path.join(to, 'tasks.json'), 'utf8'));
    for (const t of tasks) if (t.worktreePath && fs.existsSync(t.worktreePath)) worktrees.push(t.worktreePath);
  } catch {
    /* no tasks */
  }
  if (worktrees.length) spawnSync('git', ['worktree', 'repair', ...worktrees], { cwd: projectRoot });
  return true;
}

module.exports = { adoptLegacyEnv, migrateGlobal, migrateRepo, REPO_DIR, LEGACY_REPO_DIR };
