'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Carpeta temporal de esta ejecucion: serve.js la anota en un fichero fijo por puerto.
function e2eTmp(port = 47321) {
  return fs.readFileSync(path.join(os.tmpdir(), `optimia-e2e-current-${port}.txt`), 'utf8').trim();
}

// Llamadas registradas por el claude simulado.
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

// El compositor ignora Enter hasta que hay conexion y un chat activo (en un repo
// nuevo el primer chat se crea de forma asincrona).
async function waitForChatReady(page) {
  const { expect } = require('@playwright/test');
  await expect(page.locator('#connection-status')).toHaveAttribute('title', 'Conectado', { timeout: 10_000 });
  await expect(page.locator('#chat-tabs .chat-tab.active')).toHaveCount(1, { timeout: 10_000 });
}

module.exports = { e2eTmp, claudeCalls, argAfter, trackErrors, openProject, waitForChatReady };
