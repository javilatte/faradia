'use strict';

const { test, expect } = require('@playwright/test');
const { waitForChatReady } = require('./helpers');

// Collects uncaught page errors so every test can assert the UI loaded cleanly.
function trackErrors(page) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

test('la vista de proyecto carga sin errores y conecta', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?token=e2e-token');
  await expect(page.locator('#connection-status')).toHaveAttribute('title', 'Conectado', { timeout: 10_000 });
  await expect(page.locator('#chat-input')).toBeVisible();
  expect(errors).toEqual([]);
});

test('el chat envia un mensaje y muestra la respuesta del agente', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?token=e2e-token');
  await waitForChatReady(page);
  await page.locator('#chat-kind-select').selectOption('chat');
  await page.locator('#chat-input').fill('hola agente');
  await page.locator('#chat-input').press('Enter');
  await expect(page.locator('#chat-log')).toContainText('Respuesta simulada a: hola agente', { timeout: 15_000 });
  expect(errors).toEqual([]);
});
