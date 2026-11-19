'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mkTmpDir, rmTmpDir } = require('./helpers');
const ecc = require('../../server/ecc/library');
const catalog = require('../../server/agents/catalog');
const { buildSessionOptions } = require('../../server/bridge/sessionOptions');
const { defaultSettings } = require('../../server/store/settingsStore');

// faradia's own skill first, then the bundled ones in alphabetical order (pstack's among them).
const BUILTIN_NAMES = [
  'frontend-craft',
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
  'plan-optimizer',
  'ponytail',
  'ponytail-audit',
  'ponytail-review',
  'security-audit',
  'tdd',
  'unslop',
  'why'
];
test('ECC is bundled with its licence and its source commit', () => {
  assert.ok(ecc.available());
  assert.match(fs.readFileSync(path.join(ecc.VENDOR, 'LICENSE'), 'utf8'), /MIT License/);
  assert.match(fs.readFileSync(path.join(ecc.VENDOR, 'SOURCE.md'), 'utf8'), /affaan-m\/ECC, commit `[0-9a-f]{40}`/);
});

test('ECC agents join the catalog, off until needed, with their model and access', () => {
  const agents = catalog.loadAgents(null);
  const reviewer = agents.find((a) => a.id === 'ecc-code-reviewer');
  assert.equal(reviewer.source, 'ecc');
  assert.equal(reviewer.enabled, false);
  assert.equal(reviewer.access, 'read');
  assert.equal(reviewer.model, 'sonnet');
  assert.equal(agents.find((a) => a.id === 'ecc-tdd-guide').access, 'edit');
  assert.ok(agents.filter((a) => a.source === 'ecc').length >= 70);
});

test("faradia's own agents keep their id and stage, and follow their ECC counterpart's method", () => {
  const agents = catalog.loadAgents(null);
  const own = (id) => agents.find((a) => a.id === id);
  assert.equal(own('reviewer').name, 'Revisor');
  assert.equal(own('reviewer').source, 'builtin');
  assert.match(
    own('reviewer').prompt,
    /Eres el Revisor[\s\S]*## Método: code-reviewer \(de ECC, licencia MIT\)[\s\S]*Confidence-Based Filtering/
  );
  assert.match(own('auditor').prompt, /security-reviewer[\s\S]*performance-optimizer/);
  assert.match(own('planner').prompt, /## Método: planner/);
  assert.doesNotMatch(own('implementer').prompt, /## Método/);
});

test('enabled ECC skills reach every session through --add-dir; none, no folder', (t) => {
  const data = mkTmpDir('ecc-data');
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = data;
  t.after(() => {
    process.env.XDG_DATA_HOME = prev;
    rmTmpDir(data);
  });
  assert.deepEqual(
    ecc.selection({}).skills,
    ecc.DEFAULT_SKILLS.filter((s) => ecc.eccSkills().some((x) => x.name === s))
  );
  const dir = ecc.prepareActiveDir({ skills: ['tdd-workflow', 'no-existe'], commands: true });
  assert.ok(fs.existsSync(path.join(dir, '.claude', 'skills', 'tdd-workflow', 'SKILL.md')));
  assert.ok(!fs.existsSync(path.join(dir, '.claude', 'skills', 'no-existe')));
  assert.ok(fs.readdirSync(path.join(dir, '.claude', 'commands')).length > 50);
  const only = ecc.prepareActiveDir({ skills: [], commands: false });
  assert.deepEqual(fs.readdirSync(path.join(only, '.claude', 'skills')).sort(), [...BUILTIN_NAMES].sort());

  const settings = defaultSettings();
  settings.ecc = { skills: ['tdd-workflow'], commands: false };
  const repo = mkTmpDir('ecc-repo');
  t.after(() => rmTmpDir(repo));
  assert.equal(buildSessionOptions(settings, repo).addDirs[0], dir);
  assert.ok(!fs.existsSync(path.join(dir, '.claude', 'commands')), 'rebuilt when the selection changes');
});

test("faradia's built-in skills always reach the sessions, unslop with its license", (t) => {
  const data = mkTmpDir('builtin-data');
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = data;
  t.after(() => {
    process.env.XDG_DATA_HOME = prev;
    rmTmpDir(data);
  });
  const { builtinSkills } = require('../../server/skills/library');
  assert.deepEqual(
    builtinSkills().map((s) => s.name),
    BUILTIN_NAMES
  );
  const byName = (n) => builtinSkills().find((s) => s.name === n);
  assert.match(byName('plan-optimizer').description, /^Iteratively optimize a plan/);
  assert.match(builtinSkills()[0].description, /Skeleton|skeletons/);
  const dir = ecc.prepareActiveDir({ skills: [] });
  const unslop = path.join(dir, '.claude', 'skills', 'unslop');
  assert.ok(fs.existsSync(path.join(unslop, 'SKILL.md')));
  assert.match(fs.readFileSync(path.join(unslop, 'LICENSE'), 'utf8'), /Attribution 4\.0/);
  assert.match(fs.readFileSync(path.join(unslop, 'SOURCE.md'), 'utf8'), /Damir Sokolovsky/);
  assert.ok(fs.existsSync(path.join(dir, '.claude', 'skills', 'frontend-craft', 'SKILL.md')));
  assert.match(fs.readFileSync(path.join(dir, '.claude', 'skills', 'security-audit', 'LICENSE'), 'utf8'), /Cloudflare/);
});

test("pstack's skills, principles and Comment Sicko are bundled unmodified with their license and credit", (t) => {
  const data = mkTmpDir('pstack-data');
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = data;
  t.after(() => {
    process.env.XDG_DATA_HOME = prev;
    rmTmpDir(data);
  });
  const lib = require('../../server/skills/library');
  const correct = lib.builtinSkills().find((s) => s.name === 'correct');
  assert.equal(correct.credit, lib.PSTACK_CREDIT);
  assert.match(fs.readFileSync(path.join(correct.dir, 'LICENSE'), 'utf8'), /Lauren Tan/);
  assert.match(fs.readFileSync(path.join(correct.dir, 'SOURCE.md'), 'utf8'), /cursor\/plugins/);
  assert.equal(lib.pstackPrinciples().length, 24);
  assert.match(lib.pstackPrinciple('prove-it-works'), /^# Prove It Works/);
  assert.doesNotMatch(lib.pstackPrinciple('prove-it-works'), /^---/);
  assert.equal(lib.pstackPrinciple('../agents/comment-sicko'), null);
  assert.match(lib.pstackAgent('comment-sicko'), /Comment Sicko/);
  // The principles stay out of the / menu.
  assert.ok(!lib.builtinSkills().some((s) => s.name.startsWith('principle-')));
  // The skills link to the Claude Code adapter at ../../docs/harness/claude-code.md.
  const dir = ecc.prepareActiveDir({ skills: [] });
  const adapter = path.resolve(dir, '.claude', 'skills', 'how', '../../docs/harness/claude-code.md');
  assert.match(fs.readFileSync(adapter, 'utf8'), /pstack in Claude Code/);
});

test('ponytail is bundled without its code markers', () => {
  const fs2 = require('fs');
  const { builtinSkills } = require('../../server/skills/library');
  const ponytail = builtinSkills().find((s) => s.name === 'ponytail');
  const text = fs2.readFileSync(require('path').join(ponytail.dir, 'SKILL.md'), 'utf8');
  assert.match(text, /Leave no marks in the code/);
  assert.doesNotMatch(text, /gets a code comment in this form/);
  assert.match(
    fs2.readFileSync(require('path').join(ponytail.dir, 'SOURCE.md'), 'utf8'),
    /Modified by (optimia|Faradia)/
  );
  assert.ok(!builtinSkills().some((s) => s.name === 'ponytail-debt'));
});
