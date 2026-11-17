'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { mkTmpDir, rmTmpDir } = require('./helpers');
const {
  webUrlOf,
  providerOf,
  compareUrl,
  remoteInfo,
  linkFromPushOutput,
  deliverPullRequest
} = require('../../server/bridge/delivery');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// A repo with a bare "origin" (main pushed) and a task branch with one commit.
function repoWithRemote(t) {
  const root = mkTmpDir('delivery');
  t.after(() => rmTmpDir(root));
  const bare = path.join(root, 'origin.git');
  const repo = path.join(root, 'repo');
  git(root, 'init', '-q', '--bare', '-b', 'main', bare);
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@test.com');
  git(repo, 'config', 'user.name', 'test');
  fs.writeFileSync(path.join(repo, 'README.md'), 'hola\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'checkout', '-q', '-b', 'optimia/task-1');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'feat: a');
  return { repo, bare, root };
}

// A fake gh on the PATH that records its arguments and stdin and prints a PR URL.
function fakeGh(t, root) {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(root, 'gh-calls.jsonl');
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!/usr/bin/env node
const fs = require('fs');
const input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), input }) + '\\n');
console.log('https://github.com/acme/demo/pull/7');
`,
    { mode: 0o755 }
  );
  const prev = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${prev}`;
  t.after(() => (process.env.PATH = prev));
  return () =>
    fs.existsSync(log)
      ? fs
          .readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
}

test('webUrlOf / providerOf / compareUrl: ssh and https remotes of GitHub, GitLab and Bitbucket', () => {
  assert.equal(webUrlOf('git@github.com:acme/demo.git'), 'https://github.com/acme/demo');
  assert.equal(webUrlOf('https://user@gitlab.com/g/sub/demo.git'), 'https://gitlab.com/g/sub/demo');
  assert.equal(webUrlOf('ssh://git@bitbucket.org:22/team/demo'), 'https://bitbucket.org/team/demo');
  assert.equal(webUrlOf('/srv/git/demo.git'), null);
  assert.equal(providerOf('https://github.com/acme/demo'), 'github');
  assert.equal(providerOf('https://gitlab.example.com/a/b'), 'gitlab');
  assert.equal(providerOf(null), null);
  assert.equal(
    compareUrl('https://github.com/acme/demo', 'github', 'develop', 'feat/x'),
    'https://github.com/acme/demo/compare/develop...feat%2Fx?expand=1'
  );
  assert.match(compareUrl('https://gitlab.com/a/b', 'gitlab', 'main', 'f'), /merge_requests\/new\?.*source_branch\]=f/);
  assert.equal(
    linkFromPushOutput(
      'remote: \nremote: To create a merge request for f, visit:\nremote:   https://gl/x/-/merge_requests/new?a=1\n'
    ),
    'https://gl/x/-/merge_requests/new?a=1'
  );
});

test('remoteInfo: origin first, null without remotes', async (t) => {
  const { repo } = repoWithRemote(t);
  const info = await remoteInfo(repo);
  assert.equal(info.name, 'origin');
  assert.equal(info.provider, null);
  const lonely = mkTmpDir('delivery-noremote');
  t.after(() => rmTmpDir(lonely));
  git(lonely, 'init', '-q');
  assert.equal(await remoteInfo(lonely), null);
});

test('deliverPullRequest on GitHub with gh: pushes the branch and opens the PR with the description', async (t) => {
  const { repo, bare, root } = repoWithRemote(t);
  const calls = fakeGh(t, root);
  const remote = { name: 'origin', url: bare, webUrl: 'https://github.com/acme/demo', provider: 'github' };
  const result = await deliverPullRequest({
    dir: repo,
    branch: 'optimia/task-1',
    base: 'main',
    title: 'feat: a',
    body: '## Cambios\n- a',
    draft: true,
    remote,
    gh: async () => true
  });
  assert.equal(result.url, 'https://github.com/acme/demo/pull/7');
  assert.equal(result.created, true);
  assert.equal(git(bare, 'rev-parse', 'optimia/task-1'), git(repo, 'rev-parse', 'HEAD'), 'branch pushed');
  const [call] = calls();
  assert.deepEqual(call.args.slice(0, 6), ['pr', 'create', '--base', 'main', '--head', 'optimia/task-1']);
  assert.ok(call.args.includes('--draft'));
  assert.equal(call.input, '## Cambios\n- a', 'the body goes through stdin, not the command line');

  // Second time: the PR exists, it is updated.
  const again = await deliverPullRequest({
    dir: repo,
    branch: 'optimia/task-1',
    base: 'main',
    title: 'feat: a (v2)',
    body: 'v2',
    existingUrl: result.url,
    remote,
    gh: async () => true
  });
  assert.equal(again.updated, true);
  assert.deepEqual(calls()[1].args.slice(0, 3), ['pr', 'edit', result.url]);
});

test('deliverPullRequest without gh: pushes and returns the link to open the PR by hand', async (t) => {
  const { repo, bare } = repoWithRemote(t);
  const result = await deliverPullRequest({
    dir: repo,
    branch: 'optimia/task-1',
    base: 'main',
    title: 't',
    body: '',
    remote: { name: 'origin', url: bare, webUrl: 'https://github.com/acme/demo', provider: 'github' },
    gh: async () => false
  });
  assert.equal(result.manual, true);
  assert.equal(result.url, 'https://github.com/acme/demo/compare/main...optimia%2Ftask-1?expand=1');
});

test('deliverPullRequest: clear errors without a remote or when the base is not on the remote', async (t) => {
  const { repo } = repoWithRemote(t);
  await assert.rejects(
    deliverPullRequest({
      dir: repo,
      branch: 'optimia/task-1',
      base: 'develop',
      title: 't',
      body: '',
      gh: async () => false
    }),
    /la rama base "develop" no está en origin/
  );
  git(repo, 'remote', 'remove', 'origin');
  await assert.rejects(
    deliverPullRequest({ dir: repo, branch: 'optimia/task-1', base: 'main', title: 't', body: '' }),
    /no tiene ningún remoto/
  );
});
