'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mkTmpDir, rmTmpDir } = require('./helpers');
const { ProjectRegistry, projectIdFor } = require('../../server/runtime/registry');

function makeRegistry(sent = []) {
  return new ProjectRegistry({ port: 1234, token: 't', sendToClients: (p) => sent.push(p) });
}

test('projectIdFor: stable for the same folder and different across folders', (t) => {
  const a = mkTmpDir('reg-a');
  const b = mkTmpDir('reg-b');
  t.after(() => {
    rmTmpDir(a);
    rmTmpDir(b);
  });
  assert.equal(projectIdFor(a), projectIdFor(path.join(a, '.')));
  assert.notEqual(projectIdFor(a), projectIdFor(b));
  assert.match(projectIdFor(a), /^[a-f0-9]{12}$/);
});

test('register: validates the folder and does not duplicate projects', (t) => {
  const dir = mkTmpDir('reg-dup');
  t.after(() => rmTmpDir(dir));
  const reg = makeRegistry();
  const first = reg.register(dir);
  const second = reg.register(`${dir}/`);
  assert.equal(first.id, second.id);
  assert.equal(reg.list().length, 1);
  assert.equal(first.name, path.basename(dir));
  assert.throws(() => reg.register(path.join(dir, 'no-existe')), /no existe/);
});

test('runtime: created on demand, once, and writes an mcp.json with the project and token', (t) => {
  const dir = mkTmpDir('reg-rt');
  t.after(() => rmTmpDir(dir));
  const reg = makeRegistry();
  const { id } = reg.register(dir);
  assert.equal(reg.list()[0].active, false);
  const rt = reg.runtime(id);
  assert.equal(reg.runtime(id), rt);
  assert.equal(reg.list()[0].active, true);
  const mcp = JSON.parse(fs.readFileSync(path.join(dir, '.optimia', 'mcp.json'), 'utf8'));
  assert.deepEqual(mcp.mcpServers['optimia-tasks'].env, {
    OPTIMIA_PORT: '1234',
    OPTIMIA_PROJECT: id,
    OPTIMIA_TOKEN: 't'
  });
  assert.equal(reg.runtime('000000000000'), null);
  reg.dispose();
});

test('runtime: what a project emits is tagged with its id', (t) => {
  const dir = mkTmpDir('reg-bc');
  t.after(() => rmTmpDir(dir));
  const sent = [];
  const reg = makeRegistry(sent);
  const { id } = reg.register(dir);
  const rt = reg.runtime(id);
  assert.equal(rt.handleWsMessage({ type: 'stop_chat', chatId: 'c1' }, { send() {} }), undefined);
  assert.deepEqual(sent, [{ type: 'chat_stopped', chatId: 'c1', projectId: id }]);
  assert.equal(rt.handleWsMessage({ type: 'desconocido' }, { send() {} }), false);
  reg.dispose();
});
