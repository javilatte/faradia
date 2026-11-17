'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

function worktreeDir(projectRoot, taskId) {
  return path.join(projectRoot, '.optimia', 'worktrees', taskId);
}

function git(projectRoot, args) {
  return execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8' }).trim();
}

/**
 * One git worktree + branch per task, so concurrent task sessions never
 * collide on uncommitted changes in the main checkout. Branches off whatever
 * the project's current HEAD is at creation time.
 */
function createTaskWorktree(projectRoot, taskId, { baseRef, branchName, existingBranch = false } = {}) {
  const dir = worktreeDir(projectRoot, taskId);
  const branch = branchName || `optimia/task-${taskId.slice(0, 8)}`;
  if (existingBranch) {
    // A branch shared by several tasks: the task continues where the previous one left it.
    git(projectRoot, ['worktree', 'add', dir, branch]);
    return { dir, branch };
  }
  const base = baseRef || git(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  git(projectRoot, ['worktree', 'add', '-b', branch, dir, base]);
  // The session's permissions come with --settings (.optimia/claude-settings-agents.json): nothing
  // is copied into the worktree, where it would end up in the task's commit.
  return { dir, branch };
}

/**
 * Stages all changes in the task's worktree so a human can review and commit — never commits on its
 * own. The golden rule (no commit unless the user asks for it) applies to task worktrees exactly
 * like the main repo.
 */
function stageForReview(worktreeDirPath) {
  execFileSync('git', ['add', '-A'], { cwd: worktreeDirPath });
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: worktreeDirPath, encoding: 'utf8' });
  return { hasChanges: status.trim().length > 0 };
}

/**
 * Removes a task's worktree (including any staged or uncommitted changes) and
 * its branch. Callers must have confirmed with the user first.
 */
function removeTaskWorktree(projectRoot, { worktreePath, branch }, { keepBranch = false } = {}) {
  if (worktreePath && fs.existsSync(worktreePath)) {
    git(projectRoot, ['worktree', 'remove', '--force', worktreePath]);
  }
  git(projectRoot, ['worktree', 'prune']);
  if (branch && !keepBranch) {
    const exists = (() => {
      try {
        git(projectRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
        return true;
      } catch {
        return false;
      }
    })();
    if (exists) git(projectRoot, ['branch', '-D', branch]);
  }
}

function listLocalBranches(projectRoot) {
  const branches = git(projectRoot, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
    .split('\n')
    .filter(Boolean);
  return { current: git(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']), branches };
}

// Returns the reason if the name is not a valid branch name, or null.
function branchNameProblem(name) {
  try {
    execFileSync('git', ['check-ref-format', '--branch', name], { stdio: 'pipe' });
    return null;
  } catch {
    return `nombre de rama no válido: ${name}`;
  }
}

// Commits the task's changes. Respects .gitignore: a file git ignores only goes in if the user
// explicitly asks for it (`includeIgnored`, e.g. a generated .docx).
function commitTaskWorktree(worktreeDirPath, message, includeIgnored = []) {
  execFileSync('git', ['add', '-A'], { cwd: worktreeDirPath });
  const existing = includeIgnored.filter((f) => fs.existsSync(path.join(worktreeDirPath, f)));
  if (existing.length) execFileSync('git', ['add', '-f', '--', ...existing], { cwd: worktreeDirPath });
  const staged = execFileSync('git', ['diff', '--cached', '--name-only'], {
    cwd: worktreeDirPath,
    encoding: 'utf8'
  }).trim();
  if (!staged) throw new Error('no hay cambios que commitear');
  execFileSync('git', ['commit', '-m', message], { cwd: worktreeDirPath, encoding: 'utf8' });
  return git(worktreeDirPath, ['rev-parse', 'HEAD']);
}

// Out of `files` (relative), the ones git ignores in `dir`.
function ignoredAmong(dir, files) {
  if (!files.length) return [];
  const res = spawnSync('git', ['check-ignore', '--stdin'], { cwd: dir, input: files.join('\n'), encoding: 'utf8' });
  return res.status === 0 ? res.stdout.split('\n').filter(Boolean) : [];
}

function worktreeIsClean(worktreeDirPath) {
  return git(worktreeDirPath, ['status', '--porcelain']) === '';
}

// Path of the worktree where a branch is checked out, or null if it is not checked out anywhere.
function worktreeOfBranch(projectRoot, branch) {
  let current = null;
  for (const line of git(projectRoot, ['worktree', 'list', '--porcelain']).split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length);
    else if (line === `branch refs/heads/${branch}`) return current;
  }
  return null;
}

// Fast-forward if the base has not moved (linear history); if it has, a normal merge with git's
// standard message ("Merge branch '...'"), which Conventional Commits tools ignore.
function mergeAt(dir, branch, targetBranch) {
  const before = git(dir, ['rev-parse', 'HEAD']);
  try {
    git(dir, ['merge', '--ff-only', branch]);
    return { sha: git(dir, ['rev-parse', 'HEAD']), before, fastForward: true };
  } catch {
    /* the base moved on: a merge commit is needed */
  }
  try {
    git(dir, ['merge', '--no-ff', '--no-edit', branch]);
  } catch (err) {
    try {
      git(dir, ['merge', '--abort']);
    } catch {
      /* no habia merge en curso */
    }
    throw new Error(
      `conflictos al fusionar ${branch} en ${targetBranch}; resuélvelos a mano. ${err.message.split('\n')[0]}`
    );
  }
  return { sha: git(dir, ['rev-parse', 'HEAD']), before, fastForward: false };
}

// Merges the task branch into its base without switching branches in the user's checkout: if the
// base is checked out in some worktree, the merge happens there (it must be clean); otherwise a
// temporary worktree on the base is used and removed afterwards.
function mergeTaskBranch(projectRoot, branch, targetBranch) {
  const checkedOutAt = worktreeOfBranch(projectRoot, targetBranch);
  if (checkedOutAt) {
    if (git(checkedOutAt, ['status', '--porcelain']) !== '') {
      throw new Error(`hay cambios sin commitear en ${checkedOutAt}; no se puede fusionar en "${targetBranch}" ahora`);
    }
    return mergeAt(checkedOutAt, branch, targetBranch);
  }
  const tmp = path.join(
    projectRoot,
    '.optimia',
    'merge-tmp',
    `${targetBranch.replace(/[^A-Za-z0-9]/g, '-')}-${Date.now()}`
  );
  git(projectRoot, ['worktree', 'add', tmp, targetBranch]);
  try {
    return mergeAt(tmp, branch, targetBranch);
  } finally {
    try {
      git(projectRoot, ['worktree', 'remove', '--force', tmp]);
    } catch {
      /* already removed */
    }
  }
}

// Files changed by a commit (or a merge, against its first parent), or the files changed between
// two commits when `from` is given.
function filesChangedBy(dir, sha, from = `${sha}^1`) {
  return git(dir, ['diff', '--name-only', from, sha]).split('\n').filter(Boolean);
}

// Files modified, staged or untracked in a worktree right now.
function changedFiles(dir) {
  try {
    return git(dir, ['status', '--porcelain', '--untracked-files=all'])
      .split('\n')
      .filter(Boolean)
      .map((line) => line.slice(3));
  } catch {
    return [];
  }
}

module.exports = {
  worktreeOfBranch,
  worktreeDir,
  createTaskWorktree,
  stageForReview,
  removeTaskWorktree,
  listLocalBranches,
  branchNameProblem,
  commitTaskWorktree,
  worktreeIsClean,
  mergeTaskBranch,
  ignoredAmong,
  filesChangedBy,
  changedFiles
};
