'use strict';

// Starts Faradia for the Playwright suite: a throwaway git repo as the project,
// the fake `claude` first in PATH, a fixed port and no browser auto-open.
// Everything lives under one temp dir that is removed when the process exits.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PORT = Number(process.env.E2E_PORT || 47321);

// Playwright stops this process with SIGKILL, so the cleanup on exit does not always run: on start,
// folders of earlier runs (older than 10 min) are removed.
for (const name of fs.readdirSync(os.tmpdir())) {
  if (!name.startsWith('faradia-e2e-')) continue;
  const dir = path.join(os.tmpdir(), name);
  try {
    if (Date.now() - fs.statSync(dir).mtimeMs > 10 * 60 * 1000) fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* another run is using it or it no longer exists */
  }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'faradia-e2e-'));
const home = path.join(tmp, 'home');
const project = path.join(tmp, 'repos', 'demo');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(project, { recursive: true });

const git = (args, cwd = project) => execFileSync('git', args, { cwd, stdio: 'pipe' });
git(['init', '-q', '-b', 'main']);
git(['config', 'user.email', 'e2e@example.com']);
git(['config', 'user.name', 'e2e']);
fs.writeFileSync(path.join(project, 'README.md'), '# demo\n');
git(['add', 'README.md']);
git(['commit', '-q', '-m', 'init']);

process.env.PATH = `${path.join(__dirname, 'fixtures', 'bin')}${path.delimiter}${process.env.PATH}`;
process.env.XDG_CONFIG_HOME = path.join(home, '.config');
process.env.XDG_DATA_HOME = path.join(home, '.local', 'share');
process.env.FARADIA_E2E_TMP = tmp;
// Commits Faradia makes itself (the first commit of a repo it creates) need an identity on CI.
for (const who of ['AUTHOR', 'COMMITTER']) {
  process.env[`GIT_${who}_NAME`] = 'e2e';
  process.env[`GIT_${who}_EMAIL`] = 'e2e@example.com';
}
// Faradia's dictation engine without installing it or downloading models (see voice/localEngine.js);
// an empty value uses the real one.
process.env.FARADIA_VOICE_ENGINE_MODULE ??= path.join(__dirname, 'fixtures', 'fake-transformers.mjs');
// No network in tests: never ask the npm registry for updates.
process.env.FARADIA_NO_UPDATE_CHECK = '1';
// Skip the first-run welcome sheet (test/e2e/config.spec.js brings it back on purpose) and the
// what's new tour of this version (test/e2e/tour.spec.js shows it on purpose).
fs.mkdirSync(path.join(home, '.config', 'faradia'), { recursive: true });
fs.writeFileSync(
  path.join(home, '.config', 'faradia', 'state.json'),
  JSON.stringify({ welcomed: 'e2e', tourSeen: require('../../package.json').version })
);
// The fake claude has no sandbox to run in: agents run without it in the e2e tests (the sandbox
// requirement itself is covered by unit tests).
process.env.FARADIA_AGENT_SANDBOX = 'off';
// Specs find this run through this file (see test/e2e/helpers.js).
fs.writeFileSync(path.join(os.tmpdir(), `faradia-e2e-current-${PORT}.txt`), tmp);
// Every call to the fake claude is recorded here (arguments and folder), for the agent tests.
process.env.FAKE_CLAUDE_LOG = path.join(tmp, 'claude-calls.jsonl');
process.env.FAKE_GH_LOG = path.join(tmp, 'gh-calls.jsonl');

const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

const { start } = require('../../server/index.js');
start({ projectRoot: project, port: PORT, open: false, token: 'e2e-token' });
