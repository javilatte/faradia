'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  checkCommand,
  segments,
  denialMessage,
  parseDenial,
  approvedCommands,
  hookWorks
} = require('../../server/bridge/policy');
const { policyHookCommand } = require('../../server/bridge/claudeSettingsSync');
const { sandboxStatus, sandboxProblem, sandboxSettings } = require('../../server/bridge/sandbox');

test('checkCommand: catches the dangerous command anywhere in a command line', () => {
  for (const cmd of [
    'rm -rf build',
    'npm test && rm -rf dist',
    'cd src; rm x.js',
    'git -c core.hooksPath=/dev/null commit -m x',
    'git --no-pager push origin main',
    'FOO=1 git push',
    'echo $(rm -rf /)',
    'sudo apt install x',
    'git reset --hard HEAD~1',
    'find . -name "*.tmp" -delete',
    'git branch -D feature'
  ]) {
    assert.ok(checkCommand(cmd), cmd);
  }
  for (const cmd of ['npm test', 'git status', 'git diff HEAD', 'ls -la', 'grep -rn rm src', 'npm run format']) {
    assert.equal(checkCommand(cmd), null, cmd);
  }
  assert.deepEqual(segments('a && b | c; d'), ['a', 'b', 'c', 'd']);
});

test('checkCommand: an exact approved command passes; commit/push can never be approved', () => {
  assert.equal(checkCommand('rm -rf build', ['rm -rf build']), null);
  assert.ok(checkCommand('rm -rf build2', ['rm -rf build']), 'only the exact command');
  const rule = checkCommand('git push');
  assert.equal(rule.approvable, false);
  assert.deepEqual(approvedCommands(['WebFetch', 'Bash(rm -rf build)']), ['rm -rf build']);
});

test('denialMessage / parseDenial: the runtime recognizes what the agent was told', () => {
  const rule = checkCommand('rm -rf build');
  const msg = denialMessage(rule);
  assert.match(msg, /Sigue con la tarea/);
  assert.equal(parseDenial(`PreToolUse:Bash hook error: ${msg}`).id, 'delete');
  assert.equal(parseDenial('some other error'), null);
});

test('the policy hook denies, and only lets through approved commands from the environment', () => {
  const hook = path.join(__dirname, '../../server/bridge/policyHook.js');
  const run = (command, approved) =>
    spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
      encoding: 'utf8',
      env: { ...process.env, OPTIMIA_APPROVED_COMMANDS: JSON.stringify(approved || []) }
    }).stdout;
  assert.equal(JSON.parse(run('rm -rf build')).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(run('rm -rf build', ['rm -rf build']), '');
  assert.equal(run('npm test'), '');
  assert.equal(hookWorks(policyHookCommand()), true);
  assert.equal(hookWorks('"/nonexistent/node" "/nonexistent/hook.js"'), false, 'a broken hook is detected');
});

test('sandbox: required by default, explained when its tools are missing', () => {
  const has = (bins) => (b) => bins.includes(b);
  assert.deepEqual(sandboxStatus({ platform: 'linux', has: has(['bwrap']) }), {
    available: false,
    missing: ['socat'],
    install: 'sudo apt install socat'
  });
  assert.equal(sandboxStatus({ platform: 'linux', has: has(['bwrap', 'socat']) }).available, true);
  assert.equal(sandboxStatus({ platform: 'darwin', has: has(['sandbox-exec']) }).available, true);
  const missing = sandboxStatus({ platform: 'linux', has: has([]) });
  assert.match(sandboxProblem('required', missing), /sudo apt install bubblewrap socat/);
  assert.equal(sandboxProblem('off', missing), null);
  assert.equal(sandboxSettings('off'), undefined);
  assert.equal(sandboxSettings('required').failIfUnavailable, true);
});
