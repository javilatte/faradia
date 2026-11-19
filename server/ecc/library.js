'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataDir } = require('../store/globalPaths');
const { builtinSkills, copyBuiltinSkills } = require('../skills/library');

// ECC (Everything Claude Code, github.com/affaan-m/ECC, MIT) bundled in vendor/ecc: its agents,
// skills and commands are part of optimia, not a plugin.
//   - agents: an extra origin of the agent catalog (ids "ecc-<name>"), off until the user turns
//     them on; then they work like any other agent (tasks, stages, model, prompt).
//   - skills and commands: the ones the user enables are copied into <data>/optimia/ecc/.claude/
//     and that folder goes to every session with --add-dir, where Claude Code loads them. Each
//     enabled skill adds its description to the context of every session, hence the choice.

const VENDOR = path.join(__dirname, '..', '..', 'vendor', 'ecc');

// Enabled until the user changes the list: general software engineering ones.
const DEFAULT_SKILLS = [
  'api-design',
  'architecture-decision-records',
  'backend-patterns',
  'codebase-onboarding',
  'coding-standards',
  'conventional-commit-review',
  'database-migrations',
  'deployment-patterns',
  'docker-patterns',
  'e2e-testing',
  'error-handling',
  'frontend-patterns',
  'git-workflow',
  'python-patterns',
  'react-patterns',
  'search-first',
  'security-review',
  'tdd-workflow',
  'typescript-patterns',
  'verification-loop'
];

function available() {
  return fs.existsSync(path.join(VENDOR, 'agents'));
}

function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { fields: {}, body: text.trim() };
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0 && !/^\s/.test(line))
      fields[line.slice(0, i).trim()] = line
        .slice(i + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
  }
  return { fields, body: m[2].trim() };
}

const MODELS = ['opus', 'sonnet', 'haiku'];
let agentsCache = null;

/** ECC agents as catalog entries (not yet merged with the user's settings). */
function eccAgents() {
  if (agentsCache) return agentsCache;
  const dir = path.join(VENDOR, 'agents');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.md'));
  } catch {
    return (agentsCache = []);
  }
  agentsCache = names
    .map((name) => {
      const { fields, body } = frontmatter(fs.readFileSync(path.join(dir, name), 'utf8'));
      const base = (fields.name || name.slice(0, -3)).toLowerCase().replace(/[^a-z0-9-]/g, '-');
      const tools = String(fields.tools || '');
      return {
        id: `ecc-${base}`.slice(0, 40),
        name: `${base} (ECC)`,
        description: fields.description || '',
        engine: 'claude',
        model: MODELS.includes(fields.model) ? fields.model : 'default',
        effort: 'default',
        access: /\b(Edit|Write|MultiEdit)\b/.test(tools) ? 'edit' : 'read',
        enabled: false,
        prompt: body,
        library: 'ecc'
      };
    })
    .filter((a) => /^[a-z0-9][a-z0-9-]{1,39}$/.test(a.id));
  return agentsCache;
}

function listDir(sub, filter) {
  try {
    return fs.readdirSync(path.join(VENDOR, sub)).filter(filter).sort();
  } catch {
    return [];
  }
}

/** [{name, description, size}] of the bundled skills. */
function eccSkills() {
  return listDir('skills', (n) => fs.existsSync(path.join(VENDOR, 'skills', n, 'SKILL.md'))).map((name) => {
    const text = fs.readFileSync(path.join(VENDOR, 'skills', name, 'SKILL.md'), 'utf8');
    const { fields } = frontmatter(text);
    return { name, description: fields.description || '', size: text.length };
  });
}

function eccCommands() {
  return listDir('commands', (n) => n.endsWith('.md')).map((n) => n.slice(0, -3));
}

/** The user's choice (settings.ecc) with the defaults filled in. */
function selection(prefs = {}) {
  const known = new Set(eccSkills().map((s) => s.name));
  const skills = Array.isArray(prefs.skills) ? prefs.skills : DEFAULT_SKILLS;
  return { skills: skills.filter((s) => known.has(s)), commands: prefs.commands === true };
}

function activeDir() {
  return path.join(dataDir(), 'ecc');
}

/**
 * Builds <data>/optimia/ecc/.claude/{skills,commands} with optimia's built-in skills (always) and
 * what is enabled of ECC, and returns that folder for --add-dir, or null when there is nothing.
 * Rebuilt only when the selection or the bundles change.
 */
function prepareActiveDir(prefs) {
  const builtin = builtinSkills();
  const sel = available() ? selection(prefs) : { skills: [], commands: false };
  if (!builtin.length && !sel.skills.length && !sel.commands) return null;
  const dir = activeDir();
  const eccStamp = available() ? fs.statSync(path.join(VENDOR, 'SOURCE.md')).mtimeMs : 0;
  const signature = crypto
    .createHash('sha256')
    .update(JSON.stringify({ sel, eccStamp, builtin: builtin.map((s) => [s.name, s.mtimeMs]) }))
    .digest('hex');
  const stamp = path.join(dir, '.selection');
  try {
    if (fs.readFileSync(stamp, 'utf8') === signature) return dir;
  } catch {
    /* first time */
  }
  fs.rmSync(path.join(dir, '.claude'), { recursive: true, force: true });
  copyBuiltinSkills(dir);
  for (const name of sel.skills) {
    fs.cpSync(path.join(VENDOR, 'skills', name), path.join(dir, '.claude', 'skills', name), { recursive: true });
  }
  if (sel.commands) {
    fs.cpSync(path.join(VENDOR, 'commands'), path.join(dir, '.claude', 'commands'), { recursive: true });
  }
  if (available()) fs.copyFileSync(path.join(VENDOR, 'LICENSE'), path.join(dir, 'LICENSE'));
  fs.writeFileSync(stamp, signature);
  return dir;
}

module.exports = {
  VENDOR,
  DEFAULT_SKILLS,
  available,
  eccAgents,
  eccSkills,
  eccCommands,
  selection,
  prepareActiveDir
};
