'use strict';

const fs = require('fs');
const path = require('path');
const { git } = require('./gitState');

// Diffs para el visor: siempre de solo lectura (git diff / git show) y ya
// troceados en hunks y lineas, con numeros de linea antiguos y nuevos.
// Modos:
//   worktree  cambios sin stage            (git diff)
//   staged    cambios en stage             (git diff --cached)
//   head      todo frente a HEAD           (git diff HEAD) — lo que ve un agente en su worktree
//   commit    los cambios de un commit     (git show <ref>)
// context: lineas de contexto; "full" = el fichero entero con los cambios marcados.

const MODES = ['worktree', 'staged', 'head', 'commit'];
const MAX_DIFF_BYTES = 4 * 1024 * 1024;
const FULL_CONTEXT = 1000000;

function safeRel(p) {
  if (typeof p !== 'string' || !p || p.includes('\0')) return null;
  const norm = path.posix.normalize(p.replace(/\\/g, '/'));
  if (norm.startsWith('/') || norm === '..' || norm.startsWith('../')) return null;
  return norm;
}

function parseUnifiedDiff(text) {
  const files = [];
  let file = null;
  let hunk = null;
  let oldNo = 0;
  let newNo = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      file = { oldPath: m ? m[1] : null, newPath: m ? m[2] : null, status: 'modified', binary: false, hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (!hunk) {
      if (line.startsWith('new file mode')) file.status = 'added';
      else if (line.startsWith('deleted file mode')) file.status = 'deleted';
      else if (line.startsWith('rename from ')) {
        file.status = 'renamed';
        file.oldPath = line.slice(12);
      } else if (line.startsWith('rename to ')) file.newPath = line.slice(10);
      else if (line.startsWith('Binary files')) file.binary = true;
      else if (line.startsWith('--- ')) file.oldPath = line === '--- /dev/null' ? null : line.slice(6);
      else if (line.startsWith('+++ ')) file.newPath = line === '+++ /dev/null' ? null : line.slice(6);
    }
    const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line);
    if (hm) {
      hunk = {
        oldStart: Number(hm[1]),
        oldLines: hm[2] === undefined ? 1 : Number(hm[2]),
        newStart: Number(hm[3]),
        newLines: hm[4] === undefined ? 1 : Number(hm[4]),
        header: hm[5] || '',
        lines: []
      };
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith('+')) hunk.lines.push({ type: 'add', text: line.slice(1), newNo: newNo++ });
    else if (line.startsWith('-')) hunk.lines.push({ type: 'del', text: line.slice(1), oldNo: oldNo++ });
    else if (line.startsWith(' '))
      hunk.lines.push({ type: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    else if (line.startsWith('\\')) hunk.lines.push({ type: 'meta', text: line });
  }
  for (const f of files) {
    f.added = f.hunks.reduce((n, h) => n + h.lines.filter((l) => l.type === 'add').length, 0);
    f.removed = f.hunks.reduce((n, h) => n + h.lines.filter((l) => l.type === 'del').length, 0);
  }
  return files;
}

// Un fichero nuevo sin seguimiento no sale en git diff: se muestra entero como anadido.
function untrackedAsDiff(cwd, rel) {
  const abs = path.join(cwd, rel);
  const stat = fs.statSync(abs);
  if (stat.size > MAX_DIFF_BYTES)
    return [
      { oldPath: null, newPath: rel, status: 'added', binary: false, tooLarge: true, hunks: [], added: 0, removed: 0 }
    ];
  const buf = fs.readFileSync(abs);
  if (buf.includes(0))
    return [{ oldPath: null, newPath: rel, status: 'added', binary: true, hunks: [], added: 0, removed: 0 }];
  const lines = buf.toString('utf8').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const hunk = {
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: lines.length,
    header: '',
    lines: lines.map((text, i) => ({ type: 'add', text, newNo: i + 1 }))
  };
  return [
    { oldPath: null, newPath: rel, status: 'untracked', binary: false, hunks: [hunk], added: lines.length, removed: 0 }
  ];
}

async function isUntracked(cwd, rel) {
  try {
    await git(cwd, ['ls-files', '--error-unmatch', '--', rel]);
    return false;
  } catch {
    return fs.existsSync(path.join(cwd, rel));
  }
}

/**
 * Diff de un fichero (o de todo si no se da path) en `cwd`.
 * Devuelve { mode, context, files: [...], truncated }.
 */
async function getDiff(cwd, { path: p, mode = 'head', ref, context = 3 } = {}) {
  if (!MODES.includes(mode)) throw new Error(`modo de diff no valido: ${mode}`);
  const rel = p === undefined || p === null || p === '' ? null : safeRel(p);
  if (p && !rel) throw new Error('ruta no valida');
  const ctx = context === 'full' ? FULL_CONTEXT : Math.max(0, Math.min(1000, Number(context) || 0));
  if (rel && mode !== 'commit' && mode !== 'staged' && (await isUntracked(cwd, rel))) {
    return { mode, context, files: untrackedAsDiff(cwd, rel), truncated: false };
  }
  const args = ['-c', 'core.quotePath=false'];
  if (mode === 'commit') {
    if (typeof ref !== 'string' || !/^[0-9a-fA-F]{4,40}$/.test(ref)) throw new Error('commit no valido');
    args.push('show', `-U${ctx}`, '--format=', '-M', ref);
  } else {
    args.push('diff', `-U${ctx}`, '-M');
    if (mode === 'staged') args.push('--cached');
    if (mode === 'head') args.push('HEAD');
  }
  if (rel) args.push('--', rel);
  let out = await git(cwd, args, { maxBuffer: MAX_DIFF_BYTES * 2 });
  const truncated = out.length > MAX_DIFF_BYTES;
  if (truncated) out = out.slice(0, MAX_DIFF_BYTES);
  return { mode, context, files: parseUnifiedDiff(out), truncated };
}

/** Ultimos commits de la rama actual, con sus ficheros y lineas. */
async function listCommits(cwd, { limit = 50, skip = 0 } = {}) {
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  let out;
  try {
    out = await git(cwd, [
      'log',
      `-n${n}`,
      `--skip=${Math.max(0, Number(skip) || 0)}`,
      '--format=%x1e%H%x00%h%x00%s%x00%an%x00%cI',
      '--numstat',
      '-z'
    ]);
  } catch {
    return []; // sin commits
  }
  return out
    .split('\x1e')
    .filter((chunk) => chunk.trim())
    .map((chunk) => {
      const [sha, short, subject, author, rest] = chunk.split('\0');
      const date = (rest || '').split('\n')[0];
      const numstat = chunk.slice(chunk.indexOf(date) + date.length);
      let added = 0;
      let removed = 0;
      let filesCount = 0;
      for (const m of numstat.matchAll(/(-|\d+)\t(-|\d+)\t/g)) {
        filesCount++;
        added += m[1] === '-' ? 0 : Number(m[1]);
        removed += m[2] === '-' ? 0 : Number(m[2]);
      }
      return { sha, short, subject, author, date, files: filesCount, added, removed };
    });
}

module.exports = { MODES, safeRel, parseUnifiedDiff, getDiff, listCommits, FULL_CONTEXT };
