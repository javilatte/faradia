'use strict';

const fs = require('fs');
const path = require('path');

// Skills optimia always gives to the chat and to every agent, on top of the ECC ones the user picks:
//   - optimia's own, in server/skills/<name> (frontend-craft).
//   - third-party ones bundled unmodified in vendor/skills/<name> by scripts/vendor-skill.sh (unslop,
//     security-audit, plan-optimizer, ponytail with its review and audit, which scripts/vendor-ponytail.sh
//     changes so it leaves no marks in the code). Each folder carries its LICENSE and a SOURCE.md
//     with the attribution, and both travel with the copy sessions read.
//   - part of pstack (Lauren Tan, MIT), bundled by scripts/vendor-pstack.sh: its skills in
//     vendor/skills, and in vendor/pstack its principles (which go into the agents' prompts, not the
//     / menu), the Comment Sicko agent and the Claude Code adapter its skills link to.

const OWN = __dirname;
const VENDORED = path.join(__dirname, '..', '..', 'vendor', 'skills');
const PSTACK = path.join(__dirname, '..', '..', 'vendor', 'pstack');
const PSTACK_CREDIT = 'Lauren Tan (poteto) · pstack · MIT';
const PSTACK_SKILLS = [
  'architect',
  'arena',
  'benchmark-checklist',
  'blast-radius',
  'correct',
  'create-verification-skill',
  'how',
  'in-your-own-words',
  'interrogate',
  'maintain-verification-skill',
  'no-comments',
  'tdd',
  'why'
];

const CREDITS = {
  'frontend-craft': 'optimia',
  unslop: 'Damir Sokolovsky · CC BY 4.0',
  'security-audit': 'Cloudflare · MIT',
  'plan-optimizer': 'Sean Geng · MIT',
  ponytail: 'Dietrich Gebert · MIT',
  'ponytail-review': 'Dietrich Gebert · MIT',
  'ponytail-audit': 'Dietrich Gebert · MIT',
  ...Object.fromEntries(PSTACK_SKILLS.map((n) => [n, PSTACK_CREDIT]))
};

function frontmatterDescription(file) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(fs.readFileSync(file, 'utf8'));
  if (!m) return '';
  const lines = m[1].split(/\r?\n/);
  const i = lines.findIndex((l) => l.startsWith('description:'));
  if (i === -1) return '';
  let value = lines[i].slice('description:'.length).trim();
  // YAML folded/literal block ("description: >-" followed by indented lines).
  if (/^[>|][-+]?$/.test(value)) {
    const block = [];
    for (let j = i + 1; j < lines.length && /^\s+/.test(lines[j]); j++) block.push(lines[j].trim());
    value = block.join(' ');
  }
  return value.replace(/^["']|["']$/g, '');
}

function skillDirs(root, skip = []) {
  try {
    return fs
      .readdirSync(root)
      .filter((n) => !skip.includes(n) && fs.existsSync(path.join(root, n, 'SKILL.md')))
      .sort()
      .map((n) => ({ name: n, dir: path.join(root, n) }));
  } catch {
    return [];
  }
}

/** [{name, description, credit, dir, mtimeMs}] of the built-in skills, optimia's first. */
function builtinSkills() {
  return [...skillDirs(OWN), ...skillDirs(VENDORED)].map(({ name, dir }) => {
    const file = path.join(dir, 'SKILL.md');
    return {
      name,
      dir,
      description: frontmatterDescription(file),
      credit: CREDITS[name] || 'optimia',
      mtimeMs: fs.statSync(file).mtimeMs
    };
  });
}

/**
 * Copies the built-in skills into <dir>/.claude/skills, and pstack's Claude Code adapter to
 * <dir>/.claude/docs/harness, where its skills link to it (../../docs/harness/claude-code.md).
 */
function copyBuiltinSkills(dir) {
  for (const s of builtinSkills()) {
    fs.cpSync(s.dir, path.join(dir, '.claude', 'skills', s.name), { recursive: true });
  }
  const adapter = path.join(PSTACK, 'docs', 'harness', 'claude-code.md');
  if (fs.existsSync(adapter)) {
    fs.mkdirSync(path.join(dir, '.claude', 'docs', 'harness'), { recursive: true });
    fs.copyFileSync(adapter, path.join(dir, '.claude', 'docs', 'harness', 'claude-code.md'));
  }
}

function withoutFrontmatter(text) {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
}

const bodyCache = new Map();
function cachedBody(file) {
  if (!bodyCache.has(file)) {
    let body = null;
    try {
      body = withoutFrontmatter(fs.readFileSync(file, 'utf8'));
    } catch {
      /* not bundled */
    }
    bodyCache.set(file, body);
  }
  return bodyCache.get(file);
}

/** Names of the bundled pstack principles (kebab case, without "principle-"). */
function pstackPrinciples() {
  try {
    return fs
      .readdirSync(path.join(PSTACK, 'principles'))
      .filter((n) => fs.existsSync(path.join(PSTACK, 'principles', n, 'SKILL.md')))
      .sort();
  } catch {
    return [];
  }
}

/** Text of one pstack principle, without its frontmatter, or null when it is not bundled. */
function pstackPrinciple(name) {
  if (!/^[a-z-]+$/.test(name)) return null;
  return cachedBody(path.join(PSTACK, 'principles', name, 'SKILL.md'));
}

/** Text of one pstack agent (comment-sicko), without its frontmatter, or null. */
function pstackAgent(name) {
  if (!/^[a-z-]+$/.test(name)) return null;
  return cachedBody(path.join(PSTACK, 'agents', `${name}.md`));
}

module.exports = {
  builtinSkills,
  copyBuiltinSkills,
  frontmatterDescription,
  pstackPrinciples,
  pstackPrinciple,
  pstackAgent,
  PSTACK_CREDIT
};
