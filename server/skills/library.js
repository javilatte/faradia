'use strict';

const fs = require('fs');
const path = require('path');

// Skills optimia always gives to the chat and to every agent, on top of the ECC ones the user picks:
//   - optimia's own, in server/skills/<name> (frontend-craft).
//   - third-party ones bundled unmodified in vendor/skills/<name> by scripts/vendor-skill.sh (unslop,
//     security-audit, plan-optimizer, ponytail with its review and audit, which scripts/vendor-ponytail.sh
//     changes so it leaves no marks in the code). Each folder carries its LICENSE and a SOURCE.md
//     with the attribution, and both travel with the copy sessions read.

const OWN = __dirname;
const VENDORED = path.join(__dirname, '..', '..', 'vendor', 'skills');

const CREDITS = {
  'frontend-craft': 'optimia',
  unslop: 'Damir Sokolovsky · CC BY 4.0',
  'security-audit': 'Cloudflare · MIT',
  'plan-optimizer': 'Sean Geng · MIT',
  ponytail: 'Dietrich Gebert · MIT',
  'ponytail-review': 'Dietrich Gebert · MIT',
  'ponytail-audit': 'Dietrich Gebert · MIT'
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

/** Copies the built-in skills into <dir>/.claude/skills. */
function copyBuiltinSkills(dir) {
  for (const s of builtinSkills()) {
    fs.cpSync(s.dir, path.join(dir, '.claude', 'skills', s.name), { recursive: true });
  }
}

module.exports = { builtinSkills, copyBuiltinSkills, frontmatterDescription };
