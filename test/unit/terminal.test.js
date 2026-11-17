'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { mkTmpDir, rmTmpDir } = require('./helpers');

// A PtySession that cannot start, like node-pty on macOS when its spawn-helper is
// not executable ("posix_spawnp failed"). Installed before the runtime loads it.
const ptyPath = require.resolve('../../server/bridge/ptySession');
require.cache[ptyPath] = {
  id: ptyPath,
  filename: ptyPath,
  loaded: true,
  exports: {
    PtySession: class {
      constructor() {
        throw new Error('posix_spawnp failed.');
      }
    }
  }
};
const { createProjectRuntime } = require('../../server/runtime/projectRuntime');

test('a terminal that cannot start is reported to the interface and does not bring the server down', (t) => {
  const root = mkTmpDir('terminal-fail');
  t.after(() => {
    rmTmpDir(root);
    delete require.cache[ptyPath];
  });
  const sent = [];
  const rt = createProjectRuntime({
    projectId: 'abc123abc123',
    projectRoot: root,
    port: 1,
    token: 't',
    sendToClients: (msg) => sent.push(msg)
  });
  t.after(() => rt.dispose?.());
  const replies = [];
  const ws = { send: (raw) => replies.push(JSON.parse(raw)) };

  assert.doesNotThrow(() => rt.handleWsMessage({ type: 'terminal_subscribe' }, ws));
  const error = sent.find((m) => m.type === 'terminal_error');
  assert.ok(error, 'terminal_error is broadcast');
  assert.match(error.error, /posix_spawnp failed/);
  assert.match(error.error, /"claude"/);
  assert.equal(replies.length, 0, 'no scrollback without a session');
  assert.ok(path.isAbsolute(root));
});
