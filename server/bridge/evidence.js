'use strict';

const fs = require('fs');
const path = require('path');

// Evidence of a verification: what optimia saw the Verifier run (every Bash command with its result,
// from the session's own stream, not from what the agent says), plus the screenshots or videos it
// saved in the task's evidence folder. Kept in <repo>/.optimia/evidence/<taskId>/, outside the
// worktree so it never ends up in a commit:
//   verify-<n>.json   one per verification run: {run, startedAt, finishedAt, checks, images}
//   <name>.png|...    the images and videos of the runs

const OUTPUT_TAIL = 4000;
const MEDIA = /\.(png|jpe?g|webp|gif|mp4|webm)$/i;
const TASK_ID = /^[A-Za-z0-9_-]{1,80}$/;

function evidenceRoot(projectRoot) {
  return path.join(projectRoot, '.optimia', 'evidence');
}

function evidenceDir(projectRoot, taskId) {
  if (!TASK_ID.test(String(taskId))) throw new Error('id de tarea no válido');
  return path.join(evidenceRoot(projectRoot), taskId);
}

// Summaries test runners, linters and compilers print when something failed. A pipe (`npm test |
// tail`) hides the exit code, so the output is read too.
const FAILED_OUTPUT = [
  /^# fail [1-9]/m, // node --test, TAP
  /^\s*ℹ fail [1-9]/m, // node --test (spec reporter)
  /\b[1-9]\d* failing\b/, // mocha
  /^Tests:\s+.*\b[1-9]\d* failed/m, // jest, vitest
  /^\s*Test Files\s+.*\b[1-9]\d* failed/m, // vitest
  /^=+ .*\b[1-9]\d* (failed|errors?)\b.* =+$/m, // pytest
  /^(--- )?FAIL\b/m, // go test, jest
  /^test result: FAILED/m, // cargo test
  /✖ [1-9]\d* problems?/, // eslint
  /\berror TS\d{3,5}:/, // tsc
  /^npm ERR! /m,
  /^Found [1-9]\d* errors?/m // tsc --build, mypy, ruff
];

// A command the agent runs to show that something fails (the mistake a check must catch) carries
// this comment, at its end or on the step that fails (break, check it fails, restore, check again): its failure is expected and does not count against the verdict, but it stays on the
// card for whoever reviews.
const EXPECTED_FAILURE = /#\s*se espera que falle\b/i;

function outputFailed(text) {
  return FAILED_OUTPUT.some((re) => re.test(text));
}

function resultText(block) {
  return Array.isArray(block.content) ? block.content.map((c) => c.text || '').join('\n') : String(block.content || '');
}

/**
 * Follows a stage's stream-json events and keeps each Bash command with its result.
 * isDenied(text) tells a command the safety policy blocked (it did not run).
 */
function createRecorder({ isDenied = () => false, now = Date.now } = {}) {
  const pending = new Map();
  const checks = [];
  return {
    onEvent(event) {
      for (const block of event?.message?.content || []) {
        if (event.type === 'assistant' && block.type === 'tool_use' && block.name === 'Bash') {
          pending.set(block.id, { command: String(block.input?.command || ''), startedAt: now() });
        }
        if (event.type === 'user' && block.type === 'tool_result' && pending.has(block.tool_use_id)) {
          const use = pending.get(block.tool_use_id);
          pending.delete(block.tool_use_id);
          const text = resultText(block);
          const denied = Boolean(block.is_error) && Boolean(isDenied(text));
          const exit = /^Exit code (\d+)/m.exec(text);
          const failedOutput = !block.is_error && outputFailed(text);
          checks.push({
            command: use.command,
            ...(EXPECTED_FAILURE.test(use.command.trim()) ? { expectedFailure: true } : {}),
            ok: denied ? null : !block.is_error && !failedOutput,
            ...(failedOutput ? { failedInOutput: true } : {}),
            ...(denied ? { denied: true } : {}),
            ...(exit ? { exitCode: Number(exit[1]) } : {}),
            ms: Math.max(0, now() - use.startedAt),
            output: text.length > OUTPUT_TAIL ? `…${text.slice(-OUTPUT_TAIL)}` : text
          });
        }
      }
    },
    checks: () => checks.slice()
  };
}

function runFiles(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => /^verify-\d+\.json$/.test(n))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  } catch {
    return [];
  }
}

function mediaSince(dir, sinceMs) {
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => MEDIA.test(n))
      .filter((n) => fs.statSync(path.join(dir, n)).mtimeMs >= sinceMs - 1000)
      .sort();
  } catch {
    return [];
  }
}

/** Writes one verification run and returns it ({run, checks, images, ...}). */
function saveRun(projectRoot, taskId, { checks, startedAt, finishedAt = Date.now() }) {
  const dir = evidenceDir(projectRoot, taskId);
  fs.mkdirSync(dir, { recursive: true });
  const files = runFiles(dir);
  const run = files.length ? Number(files[files.length - 1].match(/\d+/)[0]) + 1 : 1;
  const record = {
    run,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    checks,
    images: mediaSince(dir, startedAt)
  };
  fs.writeFileSync(path.join(dir, `verify-${run}.json`), JSON.stringify(record, null, 2) + '\n');
  return record;
}

/** Every verification run of a task, oldest first. */
function listRuns(projectRoot, taskId) {
  const dir = evidenceDir(projectRoot, taskId);
  return runFiles(dir)
    .map((n) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** Absolute path of one image or video of a task's evidence, or null (never outside its folder). */
function mediaPath(projectRoot, taskId, name) {
  if (typeof name !== 'string' || !MEDIA.test(name) || name !== path.basename(name) || name.startsWith('.')) {
    return null;
  }
  const file = path.join(evidenceDir(projectRoot, taskId), name);
  try {
    return fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

function removeEvidence(projectRoot, taskId) {
  try {
    fs.rmSync(evidenceDir(projectRoot, taskId), { recursive: true, force: true });
  } catch {
    /* nothing to remove */
  }
}

module.exports = {
  outputFailed,
  evidenceRoot,
  evidenceDir,
  createRecorder,
  saveRun,
  listRuns,
  mediaPath,
  removeEvidence,
  MEDIA
};
