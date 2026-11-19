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
          checks.push({
            command: use.command,
            ok: denied ? null : !block.is_error,
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

module.exports = { evidenceRoot, evidenceDir, createRecorder, saveRun, listRuns, mediaPath, removeEvidence, MEDIA };
