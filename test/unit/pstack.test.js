'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mkTmpDir, rmTmpDir } = require('./helpers');
const {
  decideAfterStage,
  buildStagePrompt,
  parseCorrection,
  parseRuleProposals,
  crossCheckVerdict,
  isCheckCommand,
  canRun
} = require('../../server/bridge/taskStages');
const evidence = require('../../server/bridge/evidence');
const catalog = require('../../server/agents/catalog');
const { principlesPrompt } = require('../../server/bridge/sessionOptions');
const { defaultSettings } = require('../../server/store/settingsStore');

const task = (type, extra = {}) => ({
  id: 'task-1',
  title: 'x',
  instruction: 'No vuelvas a usar console.log en src',
  type,
  status: 'pending',
  stageOutputs: {},
  ...extra
});

// ---------- principles per agent ----------

test('each default agent gets the pstack principles of its stage, named in its prompt', () => {
  const agents = catalog.loadAgents(null);
  const verifier = agents.find((a) => a.id === 'verifier');
  assert.deepEqual(verifier.principles, ['prove-it-works', 'test-behavior-not-implementation', 'explain-the-number']);
  assert.deepEqual(agents.find((a) => a.id === 'debugger').principles, [
    'fix-root-causes',
    'attack-the-premise',
    'prove-it-works'
  ]);
  const prompt = principlesPrompt(defaultSettings(), verifier);
  assert.match(prompt, /Principios de ingeniería \(de pstack, Lauren Tan, licencia MIT\)/);
  assert.match(prompt, /### Prove It Works/);
  assert.match(prompt, /nombra cada principio que cambió una decisión/);
  assert.doesNotMatch(prompt, /disable-model-invocation/, 'without the frontmatter');
});

test('principles: off for every agent with the setting, off for one with an empty list, unknown ones rejected', (t) => {
  const settings = defaultSettings();
  const verifier = catalog.loadAgents(null).find((a) => a.id === 'verifier');
  assert.equal(principlesPrompt({ ...settings, principles: { enabled: false } }, verifier), '');
  assert.equal(principlesPrompt(settings, { ...verifier, principles: [] }), '');

  const repo = mkTmpDir('principles-repo');
  t.after(() => rmTmpDir(repo));
  const saved = catalog.saveAgent(repo, 'project', 'verifier', { principles: ['fix-root-causes'] });
  assert.deepEqual(saved.principles, ['fix-root-causes']);
  assert.deepEqual(catalog.saveAgent(repo, 'project', 'verifier', { principles: [] }).principles, []);
  assert.throws(() => catalog.saveAgent(repo, 'project', 'verifier', { principles: ['inventado'] }), /desconocido/);
});

test('the comment hunter follows Comment Sicko and the corrector exists, both editing', () => {
  const agents = catalog.loadAgents(null);
  const sicko = agents.find((a) => a.id === 'comment-sicko');
  assert.equal(sicko.access, 'edit');
  assert.match(sicko.prompt, /## Método: Comment Sicko \(de pstack, Lauren Tan, licencia MIT\)/);
  assert.match(sicko.prompt, /I hate comments/);
  assert.equal(agents.find((a) => a.id === 'corrector').access, 'edit');
});

// ---------- comments stage ----------

test('tidy: only the lines of this task, reports constraints as PROPUESTA lines and chains the verification', () => {
  const prompt = buildStagePrompt(task('coding'), 'tidy');
  assert.match(prompt, /git diff HEAD/);
  assert.match(prompt, /No toques comentarios que ya estaban/);
  assert.match(prompt, /PROPUESTA: <la regla> → <la comprobación/);
  const text =
    'Borrados 3.\nPROPUESTA: no llamar a fetch en render → regla de lint no-restricted-syntax\n- PROPUESTA: la caché vive 5 min -> test';
  const { patch, next } = decideAfterStage(task('coding'), 'tidy', { text, hasChanges: true });
  assert.equal(next, 'verify');
  assert.deepEqual(patch.ruleProposals, [
    { rule: 'no llamar a fetch en render', check: 'regla de lint no-restricted-syntax' },
    { rule: 'la caché vive 5 min', check: 'test' }
  ]);
  assert.equal(
    decideAfterStage(task('coding'), 'tidy', { text: 'Nada que borrar.', hasChanges: true }).patch.ruleProposals,
    undefined
  );
});

test('parseRuleProposals: nothing, "none", or at most ten', () => {
  assert.deepEqual(parseRuleProposals('sin propuestas'), []);
  assert.deepEqual(
    parseRuleProposals('- **PROPUESTA:** ninguna, porque no había restricciones defendidas con comentarios.'),
    []
  );
  assert.deepEqual(parseRuleProposals('PROPUESTA: none'), []);
  assert.equal(parseRuleProposals(Array.from({ length: 15 }, (_, i) => `PROPUESTA: r${i}`).join('\n')).length, 10);
});

// ---------- corrections ----------

test('correction: follows the correct skill, proves the check fails on the real mistake and reports its level', () => {
  const prompt = buildStagePrompt(task('correction'), 'correct', { skillsDir: '/data/optimia/ecc/.claude/skills' });
  // The skills reach the session through --add-dir, not the worktree: the absolute path.
  assert.match(prompt, /Lee y sigue \/data\/optimia\/ecc\/\.claude\/skills\/correct\/SKILL\.md/);
  assert.match(buildStagePrompt(task('correction'), 'correct'), /la skill correct \(\/correct\)/);
  assert.match(prompt, /ejecútala sobre el error real/);
  assert.match(prompt, /CLAUDE\.md o AGENTS\.md/);
  assert.equal(canRun(task('correction'), 'correct'), null);
  const text = 'Añadida la regla.\n\nNIVEL: lint — no-console en src/**';
  const { patch, next } = decideAfterStage(task('correction'), 'correct', { text, hasChanges: true });
  assert.equal(next, 'verify');
  assert.deepEqual(patch.correction, { level: 'lint', rule: 'no-console en src/**' });
  // Without changes there is nothing to review.
  assert.match(decideAfterStage(task('correction'), 'correct', { text, hasChanges: false }).patch.error, /cambios/);
});

test('parseCorrection: the last NIVEL line, only known levels', () => {
  assert.deepEqual(parseCorrection('NIVEL: docs\n...\n**NIVEL:** tipos: Result<T> en la API'), {
    level: 'tipos',
    rule: 'Result<T> en la API'
  });
  assert.equal(parseCorrection('NIVEL: magia'), null);
  assert.equal(parseCorrection('sin nivel'), null);
});

test('verification-kit: follows create-verification-skill in .claude/skills and is a test commit', () => {
  const prompt = buildStagePrompt(task('verification-kit'), 'verification-kit', { skillsDir: '/d/.claude/skills' });
  assert.match(prompt, /\/d\/\.claude\/skills\/create-verification-skill\/SKILL\.md/);
  // Claude Code does not let a session write in .claude/: the kit goes to a staging folder that
  // optimia moves after the stage.
  assert.match(prompt, /\.optimia-kit\/verify-<app>\//);
  assert.match(prompt, /\.claude\/skills\/verify-<app>/);
});

// ---------- evidence ----------

const bash = (id, command) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] }
});
const result = (id, text, isError = false) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }], is_error: isError }] }
});

test('the recorder keeps each Bash command with its result, from the stream and not from the agent', () => {
  let clock = 1000;
  const rec = evidence.createRecorder({ isDenied: (t) => t.includes('optimia bloqueó'), now: () => clock });
  rec.onEvent(bash('a', 'npm test'));
  clock += 2500;
  rec.onEvent(result('a', '266 passing'));
  rec.onEvent(bash('b', 'npm run lint'));
  rec.onEvent(result('b', 'Exit code 1\nerror  no-console', true));
  rec.onEvent(bash('c', 'rm -rf /'));
  rec.onEvent(result('c', 'optimia bloqueó este comando', true));
  rec.onEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'd', name: 'Read', input: {} }] } });
  rec.onEvent(result('d', 'file text'));
  const checks = rec.checks();
  assert.equal(checks.length, 3, 'only Bash');
  assert.deepEqual(
    checks.map(({ command, ok, exitCode, denied, ms }) => ({ command, ok, exitCode, denied, ms })),
    [
      { command: 'npm test', ok: true, exitCode: undefined, denied: undefined, ms: 2500 },
      { command: 'npm run lint', ok: false, exitCode: 1, denied: undefined, ms: 0 },
      { command: 'rm -rf /', ok: null, exitCode: undefined, denied: true, ms: 0 }
    ]
  );
});

test('a long output keeps its tail', () => {
  const rec = evidence.createRecorder();
  rec.onEvent(bash('a', 'npm test'));
  rec.onEvent(result('a', `${'x'.repeat(10000)}FIN`));
  const out = rec.checks()[0].output;
  assert.ok(out.length <= 4001);
  assert.ok(out.endsWith('FIN'));
});

test('an "OK" the evidence contradicts becomes unverified', () => {
  const ok = { ok: true, unverified: false, line: 'VEREDICTO: OK' };
  const none = crossCheckVerdict(ok, { checks: [] });
  assert.equal(none.ok, false);
  assert.equal(none.unverified, true);
  assert.match(none.line, /no ejecutó ninguna comprobación/);
  assert.equal(none.contradicted, true, 'the card says the evidence contradicts it, not that checks could not run');
  const failed = crossCheckVerdict(ok, {
    checks: [
      { command: 'npm test', ok: false },
      { command: 'ls', ok: true }
    ]
  });
  assert.match(failed.line, /`npm test` falló/);
  // Fixed and run again: the last run of each check counts.
  assert.equal(
    crossCheckVerdict(ok, {
      checks: [
        { command: 'npm test', ok: false },
        { command: 'npm test', ok: true }
      ]
    }),
    ok
  );
  // A failing command that is not a check (a grep with no matches) does not count.
  assert.equal(
    crossCheckVerdict(ok, {
      checks: [
        { command: 'grep -r foo src', ok: false },
        { command: 'npm test', ok: true }
      ]
    }),
    ok
  );
  // A verdict that is not OK, or no evidence (local model, older run), is left as it is.
  const ko = { ok: false, unverified: false, line: 'VEREDICTO: FALLA' };
  assert.equal(crossCheckVerdict(ko, { checks: [] }), ko);
  assert.equal(crossCheckVerdict(ok, undefined), ok);
});

test('verify stores the evidence summary with the verdict', () => {
  const { patch } = decideAfterStage(task('coding'), 'verify', {
    text: 'VEREDICTO: OK',
    evidence: { run: 2, checks: [{ command: 'npm test', ok: true }], images: ['home.png'] }
  });
  assert.equal(patch.verification.ok, true);
  assert.deepEqual(patch.verification.evidence, { checks: 1, failed: 0, images: 1, run: 2 });
});

test('evidence runs are saved outside the worktree, numbered, with the images of the run; media never leaves the folder', (t) => {
  const repo = mkTmpDir('evidence-repo');
  t.after(() => rmTmpDir(repo));
  const dir = evidence.evidenceDir(repo, 'task-1');
  assert.equal(dir, path.join(repo, '.optimia', 'evidence', 'task-1'));
  fs.mkdirSync(dir, { recursive: true });
  const started = Date.now();
  fs.writeFileSync(path.join(dir, 'home.png'), 'png');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not media');
  const first = evidence.saveRun(repo, 'task-1', { checks: [{ command: 'npm test', ok: true }], startedAt: started });
  assert.equal(first.run, 1);
  assert.deepEqual(first.images, ['home.png']);
  const second = evidence.saveRun(repo, 'task-1', { checks: [], startedAt: Date.now() + 60000 });
  assert.equal(second.run, 2);
  assert.deepEqual(second.images, [], 'only the images of that run');
  assert.deepEqual(
    evidence.listRuns(repo, 'task-1').map((r) => r.run),
    [1, 2]
  );

  assert.equal(evidence.mediaPath(repo, 'task-1', 'home.png'), path.join(dir, 'home.png'));
  assert.equal(evidence.mediaPath(repo, 'task-1', 'notes.txt'), null);
  assert.equal(evidence.mediaPath(repo, 'task-1', '../tasks.png'), null);
  assert.equal(evidence.mediaPath(repo, 'task-1', 'missing.png'), null);
  assert.throws(() => evidence.evidenceDir(repo, '../x'), /no válido/);

  evidence.removeEvidence(repo, 'task-1');
  assert.ok(!fs.existsSync(dir));
});

test('the verify prompt asks for real commands and offers the evidence folder for captures', () => {
  const prompt = buildStagePrompt(task('coding'), 'verify', { evidenceDir: '/tmp/ev/task-1' });
  assert.match(prompt, /guarda como evidencia cada comando/);
  assert.match(prompt, /\/tmp\/ev\/task-1/);
  assert.match(prompt, /\.claude\/skills\/verify-\*/);
  assert.doesNotMatch(buildStagePrompt(task('coding'), 'verify'), /capturas o vídeos/);
});

test("the sandbox lets the agents' commands write the evidence folder, with or without registries", () => {
  const { sandboxSettings, agentCacheDir } = require('../../server/bridge/sandbox');
  const withRegistries = sandboxSettings('on', { registries: true, extraWrite: ['/repo/.optimia/evidence'] });
  assert.deepEqual(withRegistries.filesystem.allowWrite, [agentCacheDir(), '/repo/.optimia/evidence']);
  assert.ok(withRegistries.network);
  const without = sandboxSettings('on', { registries: false, extraWrite: ['/repo/.optimia/evidence'] });
  assert.deepEqual(without.filesystem.allowWrite, ['/repo/.optimia/evidence']);
  assert.equal(without.network, undefined);
  assert.equal(sandboxSettings('off', { extraWrite: ['/x'] }), undefined);
});

test('sessions know where the bundled skills are, so stage prompts can point at them', (t) => {
  const data = mkTmpDir('skills-data');
  const repo = mkTmpDir('skills-repo');
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = data;
  t.after(() => {
    process.env.XDG_DATA_HOME = prev;
    rmTmpDir(data);
    rmTmpDir(repo);
  });
  const { buildSessionOptions } = require('../../server/bridge/sessionOptions');
  const opts = buildSessionOptions(defaultSettings(), repo);
  assert.ok(fs.existsSync(path.join(opts.skillsDir, 'correct', 'SKILL.md')));
  assert.equal(path.dirname(path.dirname(opts.skillsDir)), opts.addDirs[0]);
});

test('a failure a pipe hid from the exit code is read from the output', () => {
  const rec = evidence.createRecorder();
  rec.onEvent(bash('a', 'node --test test/ 2>&1 | tail -12'));
  rec.onEvent(result('a', '# tests 3\n# pass 2\n# fail 1\n# cancelled 0'));
  rec.onEvent(bash('b', 'npm test 2>&1 | tail -3'));
  rec.onEvent(result('b', '# tests 3\n# pass 3\n# fail 0'));
  rec.onEvent(bash('c', 'npx eslint src | tail -2'));
  rec.onEvent(result('c', '✖ 2 problems (2 errors, 0 warnings)'));
  rec.onEvent(bash('d', 'npx jest 2>&1 | tail'));
  rec.onEvent(result('d', 'Tests:       1 failed, 4 passed, 5 total'));
  rec.onEvent(bash('e', 'pytest -q | tail -1'));
  rec.onEvent(result('e', '========= 12 passed in 0.31s ========='));
  assert.deepEqual(
    rec.checks().map((c) => [c.ok, Boolean(c.failedInOutput)]),
    [
      [false, true],
      [true, false],
      [false, true],
      [false, true],
      [true, false]
    ]
  );
  assert.equal(evidence.outputFailed('========= 1 failed, 11 passed in 0.4s ========='), true);
  assert.equal(evidence.outputFailed('ok  	example.com/pkg	0.01s'), false);
  assert.equal(evidence.outputFailed('--- FAIL: TestCart (0.00s)'), true);
});

test('only commands whose program is a test runner, linter, type checker or build count as checks', () => {
  for (const cmd of [
    'npm test',
    'npm run lint 2>&1 | tail -5',
    'cd web && pnpm build',
    'CI=1 npx vitest run',
    'node --test test/',
    'python -m pytest -q',
    'cargo clippy --all-targets',
    'go test ./...',
    'make test',
    './gradlew check',
    'npx --yes eslint src',
    'git diff --stat && npm test 2>&1 | tail -3'
  ]) {
    assert.ok(isCheckCommand(cmd), cmd);
  }
  for (const cmd of [
    `node -e "const {test} = require('./x'); test()"`,
    'grep -rn "test" src',
    'cat test/cart.test.js',
    'ls test',
    'git log --oneline -5',
    'echo check'
  ]) {
    assert.ok(!isCheckCommand(cmd), cmd);
  }
  // A script the verifier ran to show a mutation throws does not turn its OK into unverified.
  const ok = { ok: true, unverified: false, line: 'VEREDICTO: OK' };
  assert.equal(
    crossCheckVerdict(ok, {
      checks: [
        { command: 'npm test', ok: true },
        { command: 'node -e "require(\'./src/cart\').addItem(frozen, {}) // test"', ok: false }
      ]
    }),
    ok
  );
});

test('a command marked "# se espera que falle" shows its failure but does not count against the OK', () => {
  const rec = evidence.createRecorder();
  rec.onEvent(bash('a', 'git stash && npm test # se espera que falle'));
  rec.onEvent(result('a', 'Exit code 1\n# fail 1', true));
  rec.onEvent(bash('b', 'npm test'));
  rec.onEvent(result('b', '# pass 3\n# fail 0'));
  const checks = rec.checks();
  assert.equal(checks[0].expectedFailure, true);
  assert.equal(checks[0].ok, false);
  const ok = { ok: true, unverified: false, line: 'VEREDICTO: OK' };
  assert.equal(
    crossCheckVerdict(ok, {
      checks: [checks[0], { command: 'npm test # se espera que falle', ok: false, expectedFailure: true }, checks[1]]
    }),
    ok
  );
  assert.match(buildStagePrompt(task('coding'), 'verify'), /# se espera que falle/);
  // On the step that fails of a longer command (break, show it fails, restore, run again).
  const multi = evidence.createRecorder();
  multi.onEvent(bash('m', 'cp a b\nnpm test | grep fail # se espera que falle\ncp b a; npm test'));
  multi.onEvent(result('m', '# fail 3\n# fail 0'));
  assert.equal(multi.checks()[0].expectedFailure, true);
});

test('optimia state is written the way Prettier formats JSON, with the repo print width', (t) => {
  const { stringify, printWidth, writeJsonFile, repoOf, _clearWidthCache } = require('../../server/store/jsonFile');
  assert.equal(
    stringify({ a: ['review'], b: {}, c: [], d: [{ x: 1 }] }),
    '{\n  "a": ["review"],\n  "b": {},\n  "c": [],\n  "d": [\n    {\n      "x": 1\n    }\n  ]\n}\n'
  );
  assert.equal(
    stringify([
      [1, 2],
      [3, 4]
    ]),
    '[\n  [1, 2],\n  [3, 4]\n]\n'
  );
  const long = Array.from({ length: 12 }, (_, i) => `item-${i}`);
  assert.match(stringify({ list: long }, 80), /"list": \[\n/);
  assert.match(stringify({ list: long }, 160), /"list": \["item-0"/);

  const repo = mkTmpDir('json-width');
  t.after(() => rmTmpDir(repo));
  _clearWidthCache();
  assert.equal(printWidth(repo), 80);
  fs.writeFileSync(path.join(repo, '.prettierrc'), '{ "printWidth": 160 }');
  _clearWidthCache();
  assert.equal(printWidth(repo), 160);
  const file = path.join(repo, '.optimia', 'tasks.json');
  assert.equal(repoOf(file), repo);
  writeJsonFile(file, { list: long });
  assert.match(fs.readFileSync(file, 'utf8'), /"list": \["item-0"/);
});

test('a usage limit with no local model: a clear message with the reset time', () => {
  const { limitMessage } = require('../../server/ai/fallback');
  const now = new Date('2026-11-20T10:00:00').getTime();
  assert.match(limitMessage(new Date('2026-11-20T13:30:00').getTime(), now), /hasta las 13:30\. La etapa seguirá sola/);
  assert.match(limitMessage(new Date('2026-11-21T09:05:00').getTime(), now), /hasta el 21 de noviembre a las 09:05/);
});

test('a stage is resumed only when Claude Code still has its transcript', (t) => {
  const { transcriptExists } = require('../../server/bridge/claudeTranscripts');
  const dir = mkTmpDir('claude-config');
  t.after(() => rmTmpDir(dir));
  const id = '12345678-aaaa-bbbb-cccc-1234567890ab';
  assert.equal(transcriptExists(id, dir), false);
  fs.mkdirSync(path.join(dir, 'projects', '-tmp-repo'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'projects', '-tmp-repo', `${id}.jsonl`), '{}\n');
  assert.equal(transcriptExists(id, dir), true);
  assert.equal(transcriptExists('../../etc/passwd', dir), false);
});

test("the user's answers reach every later stage, and the Verifier judges against them", () => {
  const t = task('coding', {
    instruction: 'Añade show_date a version_option',
    answers: [{ stage: 'plan', text: 'B: respeta la congelación y documenta el ejemplo', at: 'x' }]
  });
  for (const stage of ['implement', 'tidy', 'verify']) {
    const prompt = buildStagePrompt(t, stage);
    assert.match(prompt, /Decisiones del usuario durante la tarea[^\n]*\n- B: respeta la congelación/, stage);
  }
  // The stage that asked gets its own answers through the conversation, not twice.
  assert.doesNotMatch(buildStagePrompt(t, 'plan'), /Decisiones del usuario/);
});
