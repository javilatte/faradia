'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { buildStagePrompt } = require('../../server/bridge/taskStages');
const { builtinSkills } = require('../../server/skills/library');

const SKILLS = '/data/faradia/ecc/.claude/skills';
const HUMANIZER = /\/data\/faradia\/ecc\/\.claude\/skills\/humanizer\/SKILL\.md en modo embebido/;

function task(type, extra = {}) {
  return { id: 't1', type, title: 'Tarea', instruction: 'Encargo', stageOutputs: {}, baseBranch: 'main', ...extra };
}

test('humanizer is bundled unmodified, with its MIT license and its source', () => {
  const skill = builtinSkills().find((s) => s.name === 'humanizer');
  assert.ok(skill, 'humanizer is a built-in skill');
  assert.equal(skill.credit, 'Siqi Chen (blader) · MIT');
  const dir = path.join(__dirname, '..', '..', 'vendor', 'skills', 'humanizer');
  assert.match(fs.readFileSync(path.join(dir, 'LICENSE'), 'utf8'), /MIT License[\s\S]*Siqi Chen/);
  assert.match(fs.readFileSync(path.join(dir, 'SOURCE.md'), 'utf8'), /blader\/humanizer .*commit `[0-9a-f]{40}`/s);
  assert.match(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), /^---\nname: humanizer\n/);
});

test('every stage that writes for people goes through humanizer', () => {
  const doc = (mode) => task('documentation', { docOptions: { mode, format: 'md', targetPath: 'README.md' } });
  for (const mode of ['new', 'edit', 'fragments']) {
    assert.match(buildStagePrompt(doc(mode), 'write', { skillsDir: SKILLS }), HUMANIZER, `write ${mode}`);
  }
  assert.match(
    buildStagePrompt(task('coding'), 'describe', { skillsDir: SKILLS, describeOptions: { target: 'pr' } }),
    HUMANIZER
  );
  assert.match(
    buildStagePrompt(task('coding'), 'describe', { skillsDir: SKILLS, describeOptions: { target: 'jira' } }),
    HUMANIZER
  );
  assert.match(buildStagePrompt(task('coding'), 'commit', { skillsDir: SKILLS }), HUMANIZER);
  // Implementing touches README or docs only sometimes: the rule says when it applies.
  assert.match(
    buildStagePrompt(task('coding'), 'implement', { skillsDir: SKILLS }),
    /README, documentación, CHANGELOG/
  );
  assert.match(buildStagePrompt(task('coding'), 'implement', { skillsDir: SKILLS }), HUMANIZER);
});

test('the humanizer pass keeps facts and the repo style first, and the commit line still ends the reply', () => {
  const prompt = buildStagePrompt(task('coding'), 'commit', { skillsDir: SKILLS });
  assert.match(prompt, /sin cambiar ningún dato, nombre, cifra, comando, ruta ni enlace/);
  assert.match(prompt, /manda la del repo/);
  assert.ok(prompt.indexOf('humanizer') < prompt.indexOf('Termina SIEMPRE con una línea exacta "MENSAJE:'));
});

test('stages that do not write for people leave humanizer out', () => {
  for (const stage of ['plan', 'verify', 'review']) {
    assert.doesNotMatch(buildStagePrompt(task('coding'), stage, { skillsDir: SKILLS }), /humanizer/, stage);
  }
});
