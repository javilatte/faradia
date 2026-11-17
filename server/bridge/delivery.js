'use strict';

const { execFile } = require('child_process');

// Delivering a task as a pull request: push its branch and open (or update) the PR with the GitHub
// CLI. Without gh, or on GitLab / Bitbucket, the branch is pushed and the user gets the link to
// open the PR (or merge request) in the browser.

const PUSH_TIMEOUT_MS = 120_000;

function run(cmd, args, { cwd, input, timeout = 30_000, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      // Never wait for a password prompt: there is no terminal to answer it.
      { cwd, timeout, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env } },
      (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          return reject(err);
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      }
    );
    if (input !== undefined) child.stdin.end(input);
  });
}

// "git@github.com:org/repo.git", "ssh://git@host/org/repo", "https://user@host/org/repo.git" ->
// "https://host/org/repo".
function webUrlOf(remoteUrl) {
  const raw = String(remoteUrl || '').trim();
  let m = /^[\w.-]+@([^:/]+):(.+?)(?:\.git)?\/?$/.exec(raw);
  if (m) return `https://${m[1]}/${m[2]}`;
  m = /^(?:ssh|git|https?):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(raw);
  if (m) return `https://${m[1]}/${m[2]}`;
  return null;
}

function providerOf(webUrl) {
  if (!webUrl) return null;
  const host = new URL(webUrl).hostname;
  if (host === 'github.com' || host.includes('github')) return 'github';
  if (host.includes('gitlab')) return 'gitlab';
  if (host.includes('bitbucket')) return 'bitbucket';
  return null;
}

// Where a PR from `head` into `base` is opened in the browser.
function compareUrl(webUrl, provider, base, head) {
  const e = encodeURIComponent;
  if (provider === 'github') return `${webUrl}/compare/${e(base)}...${e(head)}?expand=1`;
  if (provider === 'gitlab')
    return `${webUrl}/-/merge_requests/new?merge_request[source_branch]=${e(head)}&merge_request[target_branch]=${e(base)}`;
  if (provider === 'bitbucket') return `${webUrl}/pull-requests/new?source=${e(head)}&dest=${e(base)}`;
  return null;
}

/**
 * The repo's remote for PRs: "origin" or, if there is none, the first one. null without remotes.
 * {name, url, webUrl, provider}
 */
async function remoteInfo(dir) {
  let names;
  try {
    names = (await run('git', ['remote'], { cwd: dir })).stdout.split('\n').filter(Boolean);
  } catch {
    return null;
  }
  if (!names.length) return null;
  const name = names.includes('origin') ? 'origin' : names[0];
  // The URL as configured (get-url would apply url.*.insteadOf rewrites and hide the host).
  const url = (await run('git', ['config', '--get', `remote.${name}.url`], { cwd: dir })).stdout.trim();
  const webUrl = webUrlOf(url);
  return { name, url, webUrl, provider: providerOf(webUrl) };
}

// gh installed and logged in (only matters for GitHub remotes).
async function ghReady() {
  try {
    await run('gh', ['auth', 'status'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function remoteHasBranch(dir, remote, branch) {
  try {
    const { stdout } = await run('git', ['ls-remote', '--heads', remote, branch], { cwd: dir, timeout: 30_000 });
    return stdout.trim() !== '';
  } catch {
    return false;
  }
}

async function pushBranch(dir, remote, branch) {
  try {
    const { stderr } = await run('git', ['push', '-u', remote, `${branch}:${branch}`], {
      cwd: dir,
      timeout: PUSH_TIMEOUT_MS
    });
    return { output: stderr };
  } catch (err) {
    const detail = String(err.stderr || err.message)
      .split('\n')
      .filter((l) => l.trim() && !l.startsWith('hint:'))
      .slice(-3)
      .join(' ');
    throw new Error(`no se pudo subir la rama ${branch} a ${remote}: ${detail}`);
  }
}

// First link the server printed after the push ("remote: Create a merge request: https://...").
function linkFromPushOutput(output) {
  const m = /^remote:\s+(https?:\/\/\S+)/m.exec(output || '');
  return m ? m[1] : null;
}

/**
 * Pushes the task branch and opens its PR, or updates it if it already exists. Returns
 * {url, created, updated, manual}: `manual` = the user has to open it from `url` (no gh, or not
 * GitHub).
 */
async function deliverPullRequest({
  dir,
  branch,
  base,
  title,
  body,
  draft = false,
  existingUrl,
  gh = ghReady,
  remote: knownRemote
}) {
  const remote = knownRemote || (await remoteInfo(dir));
  if (!remote) throw new Error('el repo no tiene ningún remoto: añade uno (git remote add origin …) para abrir PRs');
  if (!(await remoteHasBranch(dir, remote.name, base))) {
    throw new Error(`la rama base "${base}" no está en ${remote.name}: súbela antes o elige otra base`);
  }
  const push = await pushBranch(dir, remote.name, branch);

  if (remote.provider === 'github' && (await gh())) {
    if (existingUrl) {
      await run('gh', ['pr', 'edit', existingUrl, '--title', title, '--body-file', '-'], { cwd: dir, input: body });
      return { url: existingUrl, updated: true, remote: remote.name };
    }
    const args = ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body-file', '-'];
    if (draft) args.push('--draft');
    try {
      const { stdout } = await run('gh', args, { cwd: dir, input: body, timeout: 60_000 });
      const url = stdout.trim().split('\n').pop();
      return { url, created: true, remote: remote.name };
    } catch (err) {
      const text = `${err.stderr || ''}\n${err.stdout || ''}`;
      // Someone already opened it: reuse it.
      const existing = /already exists[^\n]*\n?\s*(https:\/\/\S+)/i.exec(text);
      if (existing) return { url: existing[1], created: false, remote: remote.name };
      throw new Error(`gh no pudo crear la PR: ${text.trim().split('\n').slice(-2).join(' ')}`);
    }
  }
  const url =
    (remote.webUrl && compareUrl(remote.webUrl, remote.provider, base, branch)) || linkFromPushOutput(push.output);
  if (!url) throw new Error(`rama subida a ${remote.name}, pero no sé abrir PRs en ${remote.url}`);
  return { url, manual: true, remote: remote.name };
}

module.exports = {
  webUrlOf,
  providerOf,
  compareUrl,
  remoteInfo,
  ghReady,
  pushBranch,
  linkFromPushOutput,
  deliverPullRequest
};
