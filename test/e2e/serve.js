'use strict';

// Starts optimia for the Playwright suite: a throwaway git repo as the project,
// the fake `claude` first in PATH, a fixed port and no browser auto-open.
// Everything lives under one temp dir that is removed when the process exits.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PORT = Number(process.env.E2E_PORT || 47321);

// Playwright para este proceso con SIGKILL, asi que la limpieza al salir no siempre
// llega: al arrancar se borran las carpetas de ejecuciones anteriores (de mas de 10 min).
for (const name of fs.readdirSync(os.tmpdir())) {
  if (!name.startsWith('optimia-e2e-')) continue;
  const dir = path.join(os.tmpdir(), name);
  try {
    if (Date.now() - fs.statSync(dir).mtimeMs > 10 * 60 * 1000) fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* otra ejecucion la esta usando o ya no existe */
  }
}
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
// No network in tests: never ask the npm registry for updates.
process.env.OPTIMIA_NO_UPDATE_CHECK = '1';
// Skip the first-run welcome sheet (test/e2e/config.spec.js brings it back on purpose).
fs.mkdirSync(path.join(home, '.config', 'optimia'), { recursive: true });
fs.writeFileSync(path.join(home, '.config', 'optimia', 'state.json'), JSON.stringify({ welcomed: 'e2e' }));
// Los specs encuentran esta ejecucion por este fichero (ver test/e2e/helpers.js).
fs.writeFileSync(path.join(os.tmpdir(), `optimia-e2e-current-${PORT}.txt`), tmp);
// Cada llamada al claude simulado queda aqui (argumentos y carpeta), para los tests de agentes.
process.env.FAKE_CLAUDE_LOG = path.join(tmp, 'claude-calls.jsonl');

const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

const { start } = require('../../server/index.js');
start({ projectRoot: project, port: PORT, open: false, token: 'e2e-token' });
