'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const plugins = require('../../server/bridge/plugins');

// A fake claude CLI: records the calls and answers like the real one.
function fakeRunner(state) {
  const calls = [];
  const runner = (cmd, args, _opts, cb) => {
    calls.push(args.join(' '));
    if (args[0] === 'plugin' && args[1] === 'list') {
      return cb(
        null,
        `notice\n${JSON.stringify(state.installed ? [{ id: 'ecc@ecc', version: '2.2.3', enabled: state.enabled }] : [])}`,
        ''
      );
    }
    if (args[1] === 'install') state.installed = state.enabled = true;
    if (args[1] === 'disable') state.enabled = false;
    if (args[1] === 'enable') state.enabled = true;
    if (args[1] === 'uninstall') state.installed = false;
    cb(null, '{}', '');
  };
  return { calls, runner };
}

test('ECC: installed from its marketplace with hooks off and, by default, only for optimia', async () => {
  const state = {};
  const { calls, runner } = fakeRunner(state);
  assert.equal((await plugins.eccStatus({ runner })).installed, false);
  const st = await plugins.installEcc({}, { runner });
  assert.equal(st.installed, true);
  assert.equal(st.enabledEverywhere, false, 'disabled in plain Claude Code');
  assert.match(
    calls.find((c) => c.includes('install')),
    /install ecc --marketplace affaan-m\/ECC --scope user --config hooks_enabled=false/
  );
  assert.ok(calls.includes('plugin disable ecc@ecc --scope user'));
  assert.equal((await plugins.setEccEverywhere(true, { runner })).enabledEverywhere, true);
  assert.equal((await plugins.uninstallEcc({ runner })).installed, false);
});

test('ECC: enabled in optimia sessions through enabledPlugins', () => {
  assert.deepEqual(plugins.enabledPluginsSetting({ ecc: true }), { 'ecc@ecc': true });
  assert.equal(plugins.enabledPluginsSetting({ ecc: false }), undefined);
  assert.deepEqual(plugins.parseJson('warning: x\n[{"a":1}]'), [{ a: 1 }]);
});
