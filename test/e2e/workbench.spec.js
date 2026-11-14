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

test('el proyecto de arranque aparece en el workbench "Por defecto"', async ({ page }) => {
  await page.goto('/?token=e2e-token');
  await expect(page.locator('#wb-select')).toContainText('Por defecto');
  await expect(page.locator('#repo-select')).toContainText('demo');
  await expect(page.locator('#main-nav')).toContainText('Proyecto');
});

test('crear un workbench, buscar repos en una carpeta y cambiar de proyecto', async ({ page }) => {
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
  await page.getByRole('button', { name: /Anadir los seleccionados/ }).click();
  await expect(page.locator('.wb-repos')).toContainText('api');
  await expect(page.locator('.wb-repos')).toContainText('app');

  await page.getByRole('button', { name: 'Activar' }).click();
  await page.locator('.wb-close').click();
  await expect(page.locator('#wb-select')).toHaveValue(/.+/);
  await expect(page.locator('#wb-select option:checked')).toContainText('Clientes');

  // Cambiar de repo recarga la vista de proyecto con ?p=<id> del nuevo repo
  await page.locator('#repo-select').selectOption({ label: 'api' });
  await expect(page).toHaveURL(/\?p=[a-f0-9]{12}/);
  await waitForChatReady(page);
  await page.locator('#chat-kind-select').selectOption('chat');
  await page.locator('#chat-input').fill('hola desde api');
  await page.locator('#chat-input').press('Enter');
  await expect(page.locator('#chat-log')).toContainText('Respuesta simulada a: hola desde api', { timeout: 15_000 });
  // El chat de este repo se guarda en su propia carpeta .optimia, excluida de git en local
  expect(fs.existsSync(path.join(root, 'api', '.optimia', 'chats.json'))).toBe(true);
  expect(fs.readFileSync(path.join(root, 'api', '.git', 'info', 'exclude'), 'utf8')).toContain('/.optimia');
  expect(errors).toEqual([]);
});
