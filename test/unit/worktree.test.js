'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { mkTmpDir, rmTmpDir } = require('./helpers');
const {
  createTaskWorktree,
  stageForReview,
  worktreeDir,
  removeTaskWorktree,
  listLocalBranches,
  branchNameProblem,
  commitTaskWorktree,
  mergeTaskBranch,
  ignoredAmong,
  filesChangedBy,
  changedFiles
} = require('../../server/bridge/worktree');

function initGitRepo(dir) {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'hola\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
}

test('createTaskWorktree: creates a real git worktree on its own branch and copies nothing into it', (t) => {
  const dir = mkTmpDir('worktree-repo');
  t.after(() => {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', worktreeDir(dir, 'task-123')], { cwd: dir });
    } catch {
      /* best effort */
    }
    rmTmpDir(dir);
  });

  initGitRepo(dir);
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), '{"permissions":{"deny":[]}}');

  const { dir: wtDir, branch } = createTaskWorktree(dir, 'task-123');

  assert.equal(wtDir, worktreeDir(dir, 'task-123'));
  assert.equal(branch, 'faradia/task-task-123'); // taskId.slice(0, 8) of "task-123" is "task-123" itself (8 chars)
  assert.equal(fs.existsSync(path.join(wtDir, 'README.md')), true);
  // An untracked .claude/ of the repo is not copied: it would end up in the task's commit.
  assert.equal(fs.existsSync(path.join(wtDir, '.claude', 'settings.json')), false);

  const branches = execFileSync('git', ['branch', '--list', branch], { cwd: dir, encoding: 'utf8' });
  assert.match(branches, new RegExp(branch));
});

test('createTaskWorktree: no .claude/ in the worktree when the project has none', (t) => {
  const dir = mkTmpDir('worktree-repo');
  t.after(() => {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', worktreeDir(dir, 'task-456')], { cwd: dir });
    } catch {
      /* best effort */
    }
    rmTmpDir(dir);
  });

  initGitRepo(dir);
  const { dir: wtDir } = createTaskWorktree(dir, 'task-456');
  assert.equal(fs.existsSync(path.join(wtDir, '.claude')), false);
});

test('stageForReview: reports hasChanges false on a clean worktree and true after an edit', (t) => {
  const dir = mkTmpDir('worktree-repo');
  t.after(() => {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', worktreeDir(dir, 'task-789')], { cwd: dir });
    } catch {
      /* best effort */
    }
    rmTmpDir(dir);
  });

  initGitRepo(dir);
  const { dir: wtDir } = createTaskWorktree(dir, 'task-789');

  assert.equal(stageForReview(wtDir).hasChanges, false);

  fs.writeFileSync(path.join(wtDir, 'README.md'), 'cambiado\n');
  assert.equal(stageForReview(wtDir).hasChanges, true);
});

test('removeTaskWorktree: removes the worktree with uncommitted changes and its branch', (t) => {
  const dir = mkTmpDir('worktree-remove');
  t.after(() => rmTmpDir(dir));

  initGitRepo(dir);
  const { dir: wt, branch } = createTaskWorktree(dir, 'task-remove-1');
  fs.writeFileSync(path.join(wt, 'nuevo.txt'), 'cambio sin commitear\n');
  stageForReview(wt);

  removeTaskWorktree(dir, { worktreePath: wt, branch });

  assert.equal(fs.existsSync(wt), false);
  const branches = execFileSync('git', ['branch', '--list', branch], { cwd: dir, encoding: 'utf8' });
  assert.equal(branches.trim(), '');
});

test('removeTaskWorktree: a task without worktree or branch does not fail', (t) => {
  const dir = mkTmpDir('worktree-remove-empty');
  t.after(() => rmTmpDir(dir));
  initGitRepo(dir);
  assert.doesNotThrow(() => removeTaskWorktree(dir, { worktreePath: null, branch: null }));
});

test('tasks: start from the chosen base branch, with their own branch, and merge into the base', (t) => {
  const dir = mkTmpDir('worktree-flow');
  t.after(() => rmTmpDir(dir));
  initGitRepo(dir);
  fs.writeFileSync(path.join(dir, '.gitignore'), '/docs\n/.faradia\n');
  execFileSync('git', ['add', '.gitignore'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'ignore docs'], { cwd: dir });
  execFileSync('git', ['checkout', '-q', '-b', 'fix/rebranding'], { cwd: dir });

  const listed = listLocalBranches(dir);
  assert.equal(listed.current, 'fix/rebranding');
  assert.ok(listed.branches.includes('fix/rebranding'));
  assert.equal(branchNameProblem('fix/rebranding-buttons'), null);
  assert.ok(branchNameProblem('mal..nombre'));

  const { dir: wt, branch } = createTaskWorktree(dir, 'task-flow-1', {
    baseRef: 'fix/rebranding',
    branchName: 'fix/rebranding-buttons'
  });
  t.after(() => {
    try {
      removeTaskWorktree(dir, { worktreePath: wt, branch });
    } catch {
      /* best effort */
    }
  });
  assert.equal(branch, 'fix/rebranding-buttons');

  fs.writeFileSync(path.join(wt, 'boton.css'), '.btn{}\n');
  fs.mkdirSync(path.join(wt, 'docs'));
  fs.writeFileSync(path.join(wt, 'docs', 'botones.docx'), 'x');
  const sha = commitTaskWorktree(wt, 'feat: botones', ['docs/botones.docx']);
  assert.match(sha, /^[0-9a-f]{40}$/);
  const committed = execFileSync('git', ['show', '--name-only', '--format=', sha], { cwd: dir, encoding: 'utf8' });
  assert.match(committed, /docs\/botones\.docx/);

  const merge = mergeTaskBranch(dir, branch, 'fix/rebranding');
  assert.equal(merge.sha, sha, 'the base did not move: fast-forward to the task commit');
  assert.equal(merge.fastForward, true);
  assert.ok(fs.existsSync(path.join(dir, 'boton.css')));
});

test('mergeTaskBranch: merges even if the main checkout is on another branch, and does not change it', (t) => {
  const dir = mkTmpDir('worktree-merge-temp');
  t.after(() => rmTmpDir(dir));
  initGitRepo(dir);
  execFileSync('git', ['branch', 'fix/base'], { cwd: dir });
  execFileSync('git', ['checkout', '-q', '-b', 'fix/tarea-x', 'fix/base'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'x.txt'), 'x\n');
  execFileSync('git', ['add', 'x.txt'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'x'], { cwd: dir });
  execFileSync('git', ['checkout', '-q', 'main'], { cwd: dir });
  const before = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

  mergeTaskBranch(dir, 'fix/tarea-x', 'fix/base');

  const after = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  assert.equal(after, before);
  assert.ok(execFileSync('git', ['show', 'fix/base:x.txt'], { cwd: dir, encoding: 'utf8' }).includes('x'));
});

test('mergeTaskBranch: refuses if the base is checked out with uncommitted changes', (t) => {
  const dir = mkTmpDir('worktree-merge-dirty');
  t.after(() => rmTmpDir(dir));
  initGitRepo(dir);
  execFileSync('git', ['checkout', '-q', '-b', 'fix/base'], { cwd: dir });
  execFileSync('git', ['checkout', '-q', '-b', 'fix/tarea-y'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'y.txt'), 'y\n');
  execFileSync('git', ['add', 'y.txt'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'y'], { cwd: dir });
  execFileSync('git', ['checkout', '-q', 'fix/base'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'cambio sin guardar\n');
  assert.throws(() => mergeTaskBranch(dir, 'fix/tarea-y', 'fix/base'), /cambios sin commitear/);
});

test('filesChangedBy and changedFiles: list the files of a commit and the pending ones', (t) => {
  const dir = mkTmpDir('worktree-files');
  t.after(() => rmTmpDir(dir));
  initGitRepo(dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  execFileSync('git', ['add', 'a.txt', 'b.txt'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'dos ficheros'], { cwd: dir });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  assert.deepEqual(filesChangedBy(dir, sha).sort(), ['a.txt', 'b.txt']);

  fs.writeFileSync(path.join(dir, 'c.txt'), 'c\n');
  assert.deepEqual(changedFiles(dir), ['c.txt']);
});

test("mergeTaskBranch: if the base moved on, merges with git's standard message", (t) => {
  const dir = mkTmpDir('worktree-merge-diverged');
  t.after(() => rmTmpDir(dir));
  initGitRepo(dir);
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('checkout', '-q', '-b', 'fix/tarea-z');
  fs.writeFileSync(path.join(dir, 'z.txt'), 'z\n');
  git('add', 'z.txt');
  git('commit', '-q', '-m', 'feat: z');
  git('checkout', '-q', 'main');
  fs.writeFileSync(path.join(dir, 'm.txt'), 'm\n');
  git('add', 'm.txt');
  git('commit', '-q', '-m', 'feat: m');

  const merge = mergeTaskBranch(dir, 'fix/tarea-z', 'main');
  assert.equal(merge.fastForward, false);
  assert.equal(git('log', '-1', '--format=%s', merge.sha), "Merge branch 'fix/tarea-z'");
  assert.deepEqual(filesChangedBy(dir, merge.sha, merge.before), ['z.txt']);
});

test('commitTaskWorktree respects .gitignore except for ticked files, and ignoredAmong detects them', (t) => {
  const dir = mkTmpDir('worktree-ignored');
  t.after(() => rmTmpDir(dir));
  initGitRepo(dir);
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(dir, '.gitignore'), '.env\ndist/\n');
  git('add', '.gitignore');
  git('commit', '-q', '-m', 'ignore');
  fs.writeFileSync(path.join(dir, 'a.js'), 'a\n');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1\n');
  fs.mkdirSync(path.join(dir, 'dist'));
  fs.writeFileSync(path.join(dir, 'dist', 'out.js'), 'x\n');

  assert.deepEqual(ignoredAmong(dir, ['a.js', '.env', 'dist/out.js']).sort(), ['.env', 'dist/out.js']);
  const sha = commitTaskWorktree(dir, 'feat: a', []);
  assert.equal(git('show', '--name-only', '--format=', sha), 'a.js');
  assert.equal(fs.existsSync(path.join(dir, '.claude')), false);
});

test('createTaskWorktree: links the installed dependencies, keeps them out of git and never deletes them', (t) => {
  const dir = mkTmpDir('worktree-deps');
  t.after(() => rmTmpDir(dir));
  initGitRepo(dir);
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  execFileSync('git', ['add', '.gitignore'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'ignore'], { cwd: dir });
  fs.mkdirSync(path.join(dir, 'node_modules', 'left-pad'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');

  const { dir: wt, branch } = createTaskWorktree(dir, 'task-deps');
  const link = path.join(wt, 'node_modules');
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(link, 'left-pad', 'index.js')));
  // "node_modules/" does not match a symlink: the link must not show up as a change.
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: wt, encoding: 'utf8' }), '');

  removeTaskWorktree(dir, { worktreePath: wt, branch });
  assert.ok(fs.existsSync(path.join(dir, 'node_modules', 'left-pad', 'index.js')));
});

test("createTaskWorktree: the worktree lives outside the repo, where the repo's tools do not see it", (t) => {
  const dir = mkTmpDir('wt-outside');
  initGitRepo(dir);
  const { dir: wt, branch } = createTaskWorktree(dir, 'task-outside');
  t.after(() => {
    removeTaskWorktree(dir, { worktreePath: wt, branch });
    rmTmpDir(dir);
  });
  assert.ok(!wt.startsWith(fs.realpathSync(dir)) && !wt.startsWith(dir), wt);
  assert.ok(fs.existsSync(path.join(wt, 'README.md')));
  assert.equal(worktreeDir(dir, 'task-outside'), wt);
  // Another repo with the same folder name gets its own place.
  const other = mkTmpDir('wt-outside');
  t.after(() => rmTmpDir(other));
  assert.notEqual(path.dirname(worktreeDir(other, 'x')), path.dirname(worktreeDir(dir, 'x')));
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }), '');
});
