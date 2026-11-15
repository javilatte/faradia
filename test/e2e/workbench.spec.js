'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { e2eTmp, waitForChatReady } = require('./helpers');

const reposDir = () => path.join(e2eTmp(), 'repos');

function makeRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
}

test('the launch project shows up in the "Por defecto" workbench', async ({ page }) => {
  await page.goto('/?token=e2e-token');
  await expect(page.locator('#wb-select')).toContainText('Por defecto');
  await expect(page.locator('#repo-list .repo-item.active')).toContainText('demo');
  await expect(page.locator('#main-nav')).toContainText('Chat y agentes');
  await expect(page.locator('#view-title')).toHaveText('Chat y agentes');
});

test('create a workbench, search repos in a folder and switch project', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  const root = reposDir();
  makeRepo(path.join(root, 'api'));
  makeRepo(path.join(root, 'web', 'app'));

  await page.goto('/?token=e2e-token');
  await page.locator('#wb-manage').click();
  await page.getByLabel('Nombre del nuevo workbench').fill('Clientes');
  await page.getByRole('button', { name: 'Crear' }).click();
  await expect(page.locator('.wb-list')).toContainText('Clientes');

  await page.getByLabel('Carpeta donde buscar').fill(root);
  await page.getByRole('button', { name: 'Buscar' }).click();
  await expect(page.locator('.wb-scan-list')).toContainText(path.join(root, 'web', 'app'));
  await page.getByRole('button', { name: /Añadir los seleccionados/ }).click();
  await expect(page.locator('.wb-repos')).toContainText('api');
  await expect(page.locator('.wb-repos')).toContainText('app');

  await page.getByRole('button', { name: 'Activar' }).click();
  await page.locator('.wb-close').click();
  await expect(page.locator('#wb-select')).toHaveValue(/.+/);
  await expect(page.locator('#wb-select option:checked')).toContainText('Clientes');

  // Switching repos reloads the project view with ?p=<id> of the new repo
  await page.locator('#repo-list .repo-item', { hasText: 'api' }).click();
  await expect(page).toHaveURL(/\?p=[a-f0-9]{12}/);
  await waitForChatReady(page);
  await page.locator('#chat-kind-select').selectOption('chat');
  await page.locator('#chat-input').fill('hola desde api');
  await page.locator('#chat-input').press('Enter');
  await expect(page.locator('#chat-log')).toContainText('Respuesta simulada a: hola desde api', { timeout: 15_000 });
  // This repo's chat is stored in its own .optimia folder, excluded from git locally
  expect(fs.existsSync(path.join(root, 'api', '.optimia', 'chats.json'))).toBe(true);
  expect(fs.readFileSync(path.join(root, 'api', '.git', 'info', 'exclude'), 'utf8')).toContain('/.optimia');
  expect(errors).toEqual([]);
});
