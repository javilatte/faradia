'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Temporary folder of this run: serve.js writes it to a fixed file per port.
function e2eTmp(port = 47321) {
  return fs.readFileSync(path.join(os.tmpdir(), `optimia-e2e-current-${port}.txt`), 'utf8').trim();
}

// Calls recorded by the fake claude.
function claudeCalls() {
  const file = path.join(e2eTmp(), 'claude-calls.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((c) => c.args.includes('-p'));
}

function argAfter(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

function trackErrors(page) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

async function openProject(page) {
  await page.goto('/?token=e2e-token');
  await waitForChatReady(page);
}

// The composer ignores Enter until there is a connection and an active chat (in a new repo the
// first chat is created asynchronously).
async function waitForChatReady(page) {
  const { expect } = require('@playwright/test');
  await expect(page.locator('#connection-status')).toHaveAttribute('title', 'Conectado', { timeout: 10_000 });
  await expect(page.locator('#chat-tabs .chat-tab.active')).toHaveCount(1, { timeout: 10_000 });
}

module.exports = { e2eTmp, claudeCalls, argAfter, trackErrors, openProject, waitForChatReady };
