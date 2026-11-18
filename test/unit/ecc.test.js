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

test("optimia's own agents keep their id and stage, and follow their ECC counterpart's method", () => {
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
  assert.deepEqual(fs.readdirSync(path.join(only, '.claude', 'skills')).sort(), [
    'frontend-craft',
    'plan-optimizer',
    'ponytail',
    'ponytail-audit',
    'ponytail-debt',
    'ponytail-review',
    'security-audit',
    'unslop'
  ]);

  const settings = defaultSettings();
  settings.ecc = { skills: ['tdd-workflow'], commands: false };
  const repo = mkTmpDir('ecc-repo');
  t.after(() => rmTmpDir(repo));
  assert.equal(buildSessionOptions(settings, repo).addDirs[0], dir);
  assert.ok(!fs.existsSync(path.join(dir, '.claude', 'commands')), 'rebuilt when the selection changes');
});

test("optimia's built-in skills always reach the sessions, unslop with its license", (t) => {
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
    [
      'frontend-craft',
      'plan-optimizer',
      'ponytail',
      'ponytail-audit',
      'ponytail-debt',
      'ponytail-review',
      'security-audit',
      'unslop'
    ]
  );
  assert.match(builtinSkills()[1].description, /^Iteratively optimize a plan/);
  assert.match(builtinSkills()[0].description, /Skeleton|skeletons/);
  const dir = ecc.prepareActiveDir({ skills: [] });
  const unslop = path.join(dir, '.claude', 'skills', 'unslop');
  assert.ok(fs.existsSync(path.join(unslop, 'SKILL.md')));
  assert.match(fs.readFileSync(path.join(unslop, 'LICENSE'), 'utf8'), /Attribution 4\.0/);
  assert.match(fs.readFileSync(path.join(unslop, 'SOURCE.md'), 'utf8'), /Damir Sokolovsky/);
  assert.ok(fs.existsSync(path.join(dir, '.claude', 'skills', 'frontend-craft', 'SKILL.md')));
  assert.match(fs.readFileSync(path.join(dir, '.claude', 'skills', 'security-audit', 'LICENSE'), 'utf8'), /Cloudflare/);
});
