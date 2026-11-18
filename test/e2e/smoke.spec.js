'use strict';

const { test, expect } = require('@playwright/test');
const { waitForChatReady, openProject } = require('./helpers');

// Collects uncaught page errors so every test can assert the UI loaded cleanly.
function trackErrors(page) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

test('the project view loads without errors and connects', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?token=e2e-token');
  await expect(page.locator('#connection-status')).toHaveAttribute('title', 'Conectado', { timeout: 10_000 });
  await expect(page.locator('#chat-input')).toBeVisible();
  expect(errors).toEqual([]);
});

test("the chat sends a message and shows the agent's answer", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?token=e2e-token');
  await waitForChatReady(page);
  await page.locator('#chat-kind-select').selectOption('chat');
  await page.locator('#chat-input').fill('hola agente');
  await page.locator('#chat-input').press('Enter');
  await expect(page.locator('#chat-log')).toContainText('Respuesta simulada a: hola agente', { timeout: 15_000 });
  expect(errors).toEqual([]);
});

test('the chat takes attachments: a small text file goes inline in the message', async ({ page }) => {
  const fs = require('fs');
  const path = require('path');
  const { e2eTmp } = require('./helpers');
  await openProject(page);
  await page.locator('#chat-kind-select').selectOption('chat');
  await page.locator('#attach-input').setInputFiles({
    name: 'notas.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Precio con IVA: 121 €')
  });
  await expect(page.locator('#chat-attachments .attachment-file.ready')).toContainText('notas.txt');
  await page.locator('#chat-input').fill('Resume el adjunto');
  await page.locator('#chat-input').press('Enter');
  await expect(page.locator('#chat-log .msg.user .msg-files')).toContainText('notas.txt');
  await expect(page.locator('#chat-log')).toContainText('Respuesta simulada a: Resume el adjunto', { timeout: 15_000 });
  const sent = fs
    .readFileSync(path.join(e2eTmp(), 'claude-calls-messages.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l).text)
    .pop();
  expect(sent).toContain('notas.txt (texto, 5 palabras, 1 KB): su contenido va debajo.');
  expect(sent).toContain('Precio con IVA: 121 €');
});

test('a command that needs permission is asked in the chat, not in the terminal', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?token=e2e-token');
  await waitForChatReady(page);
  await page.locator('#chat-kind-select').selectOption('chat');
  await page.locator('#chat-input').fill('[e2e:permiso] lista los ficheros');
  await page.locator('#chat-input').press('Enter');
  const card = page.locator('.permission-card').last();
  await expect(card).toContainText('El agente quiere ejecutar un comando', { timeout: 15_000 });
  await expect(card.locator('pre')).toHaveText('ls -1 && rm -rf /tmp/e2e-tmp');
  await card.getByRole('button', { name: 'Permitir', exact: true }).click();
  await expect(card).toContainText('Permitido');
  await expect(card.locator('.permission-actions')).toHaveCount(0);
  await expect(page.locator('#chat-log')).toContainText('Comando permitido: hay 2 ficheros.', { timeout: 10_000 });
  await expect(page.locator('.terminal-modal')).toBeHidden();

  // Denied: the agent gets the answer and goes on.
  await page.locator('#chat-input').fill('[e2e:permiso] otra vez');
  await page.locator('#chat-input').press('Enter');
  const second = page.locator('.permission-card').last();
  await expect(second.locator('.permission-actions')).toBeVisible({ timeout: 15_000 });
  await second.getByRole('button', { name: 'Denegar' }).click();
  await expect(second).toContainText('Denegado');
  await expect(page.locator('#chat-log')).toContainText('No me dejaste ejecutarlo.', { timeout: 10_000 });
  expect(errors).toEqual([]);
});
