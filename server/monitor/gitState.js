'use strict';

const { execFile } = require('child_process');

// Plane 1: git state of a repo or worktree, without touching anything (reads only). Asynchronous so
// the server is not blocked while watching many repos.

function git(cwd, args, { maxBuffer = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, encoding: 'utf8', maxBuffer, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
  });
}

const XY = {
  M: 'modified',
  T: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  U: 'conflict'
};

/**
 * Parses `git status --porcelain=v2 --branch -z --untracked-files=all`.
 * Returns { branch, upstream, ahead, behind, detached, oid, files }.
 */
function parseStatusV2(out) {
  const result = { branch: null, upstream: null, ahead: 0, behind: 0, detached: false, oid: null, files: [] };
  const entries = out.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const line = entries[i];
    if (!line) continue;
    if (line.startsWith('# branch.oid ')) result.oid = line.slice(13) === '(initial)' ? null : line.slice(13);
    else if (line.startsWith('# branch.head ')) {
      const head = line.slice(14);
      result.detached = head === '(detached)';
      result.branch = result.detached ? null : head;
    } else if (line.startsWith('# branch.upstream ')) result.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) {
        result.ahead = Number(m[1]);
        result.behind = Number(m[2]);
      }
    } else if (line[0] === '1' || line[0] === '2') {
      // 1 XY sub mH mI mW hH hI path        |  2 XY sub mH mI mW hH hI Xscore path \0 origPath
      const parts = line.split(' ');
      const xy = parts[1];
      const path = parts.slice(line[0] === '1' ? 8 : 9).join(' ');
      const file = { path, index: xy[0], worktree: xy[1] };
      if (line[0] === '2') file.origPath = entries[++i];
      file.staged = xy[0] !== '.';
      file.unstaged = xy[1] !== '.';
      file.status = XY[xy[1] !== '.' ? xy[1] : xy[0]] || 'modified';
      result.files.push(file);
    } else if (line[0] === 'u') {
      const parts = line.split(' ');
      result.files.push({
        path: parts.slice(10).join(' '),
        index: 'U',
        worktree: 'U',
        staged: false,
        unstaged: true,
        status: 'conflict'
      });
    } else if (line[0] === '?') {
      result.files.push({
        path: line.slice(2),
        index: '?',
        worktree: '?',
        staged: false,
        unstaged: true,
        status: 'untracked'
      });
    }
  }
  return result;
}

/** `git diff --numstat -z` -> Map(path -> { added, removed, binary }) */
function parseNumstat(out) {
  const map = new Map();
  const tokens = out.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(t);
    if (!m) continue;
    let path = m[3];
    if (path === '') {
      // renombrado: "a\tb\t" seguido de origen y destino como tokens aparte
      i += 1;
      path = tokens[++i];
    }
    map.set(path, {
      added: m[1] === '-' ? 0 : Number(m[1]),
      removed: m[2] === '-' ? 0 : Number(m[2]),
      binary: m[1] === '-'
    });
  }
  return map;
}

async function lastCommit(cwd) {
  try {
    const out = await git(cwd, ['log', '-1', '--format=%H%x00%s%x00%an%x00%cI']);
    const [sha, subject, author, date] = out.trim().split('\0');
    return sha ? { sha, subject, author, date } : null;
  } catch {
    return null; // repo without commits
  }
}

/**
 * Full state of a repo: branch, ahead/behind, files with their state and +/- lines (staged and
 * unstaged together, against HEAD), and the last commit.
 */
async function getRepoState(cwd) {
  const statusOut = await git(cwd, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
  const status = parseStatusV2(statusOut);
  let numstat = new Map();
  if (status.oid) {
    try {
      numstat = parseNumstat(await git(cwd, ['diff', 'HEAD', '--numstat', '-z', '-M']));
    } catch {
      /* no valid HEAD */
    }
  }
  let added = 0;
  let removed = 0;
  for (const f of status.files) {
    const n = numstat.get(f.path);
    if (n) {
      f.added = n.added;
      f.removed = n.removed;
      f.binary = n.binary;
      added += n.added;
      removed += n.removed;
    }
  }
  const counts = { modified: 0, staged: 0, untracked: 0, deleted: 0, conflicts: 0 };
  for (const f of status.files) {
    if (f.status === 'untracked') counts.untracked++;
    else if (f.status === 'conflict') counts.conflicts++;
    else {
      if (f.staged) counts.staged++;
      if (f.unstaged) counts.modified++;
      if (f.status === 'deleted') counts.deleted++;
    }
  }
  return {
    ...status,
    counts,
    lines: { added, removed },
    dirty: status.files.length > 0,
    lastCommit: await lastCommit(cwd),
    at: new Date().toISOString()
  };
}

async function isGitRepo(cwd) {
  try {
    return (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch {
    return false;
  }
}

module.exports = { git, parseStatusV2, parseNumstat, getRepoState, isGitRepo };
