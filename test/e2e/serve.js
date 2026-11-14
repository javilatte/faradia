'use strict';

// Starts optimia for the Playwright suite: a throwaway git repo as the project,
// the fake `claude` first in PATH, a fixed port and no browser auto-open.
// Everything lives under one temp dir that is removed when the process exits.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PORT = Number(process.env.E2E_PORT || 47321);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'optimia-e2e-'));
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
process.env.OPTIMIA_E2E_TMP = tmp;

const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

const { start } = require('../../server/index.js');
start({ projectRoot: project, port: PORT, open: false, token: 'e2e-token' });
