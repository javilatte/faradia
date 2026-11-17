'use strict';
/* global window */

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

test('the launch project shows up in the "Mi espacio" workbench', async ({ page }) => {
  await page.goto('/?token=e2e-token');
  await expect(page.locator('#wb-select')).toContainText('Mi espacio');
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

  // Opening a repo puts its id in the URL (?p=<id>)
  await page.locator('#repo-list .repo-item', { hasText: 'api' }).click();
  await expect(page).toHaveURL(/\?p=[a-f0-9]{12}/);
  await expect(page.locator('#project-label')).toHaveText('api');
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

test('switching repos is instant: no reload, each repo keeps its chat and draft, back goes to the previous one', async ({
  page
}) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  const root = path.join(reposDir(), 'switch');
  makeRepo(path.join(root, 'uno'));
  makeRepo(path.join(root, 'dos'));

  await page.goto('/?token=e2e-token');
  await page.locator('#wb-manage').click();
  await page.getByLabel('Nombre del nuevo workbench').fill('Cambio rápido');
  await page.getByRole('button', { name: 'Crear' }).click();
  await expect(page.locator('#wb-manager .settings-content-header')).toContainText('Cambio rápido');
  await page.getByLabel('Carpeta donde buscar').fill(root);
  await page.getByRole('button', { name: 'Buscar' }).click();
  await page.getByRole('button', { name: /Añadir los seleccionados/ }).click();
  await expect(page.locator('.wb-repos')).toContainText('dos');
  // Activating a workbench the open repo is not in opens one of its repos
  await page.getByRole('button', { name: 'Activar' }).click();
  await page.locator('.wb-close').click();
  await expect(page.locator('#project-label')).toHaveText(/^(uno|dos)$/);
  await page.locator('#repo-list .repo-item', { hasText: 'uno' }).click();
  await expect(page.locator('#project-label')).toHaveText('uno');
  await waitForChatReady(page);

  // A marker in the page survives the switch: there was no reload.
  await page.evaluate(() => (window.__noReload = true));
  await page.locator('#chat-input').fill('borrador de uno');
  await page.locator('#repo-list .repo-item', { hasText: 'dos' }).click();
  await expect(page.locator('#project-label')).toHaveText('dos');
  await expect(page.locator('#repo-list .repo-item.active')).toContainText('dos');
  await expect(page.locator('#chat-input')).toHaveValue('');
  expect(await page.evaluate(() => window.__noReload)).toBe(true);
  await waitForChatReady(page);
  await page.locator('#chat-kind-select').selectOption('chat');
  await page.locator('#chat-input').fill('hola desde dos');
  await page.locator('#chat-input').press('Enter');
  await expect(page.locator('#chat-log')).toContainText('Respuesta simulada a: hola desde dos', { timeout: 15_000 });

  // Back to "uno": its draft is there and the chat of "dos" is not.
  await page.goBack();
  await expect(page.locator('#project-label')).toHaveText('uno');
  await expect(page.locator('#chat-input')).toHaveValue('borrador de uno');
  await expect(page.locator('#chat-log')).not.toContainText('hola desde dos');
  expect(await page.evaluate(() => window.__noReload)).toBe(true);

  // Another workbench and back: the workbench reopens the repo used last in it.
  const pickWorkbench = async (name) =>
    page
      .locator('#wb-select')
      .selectOption(await page.locator('#wb-select option', { hasText: name }).getAttribute('value'));
  await pickWorkbench('Mi espacio');
  await expect(page.locator('#project-label')).toHaveText('demo');
  await pickWorkbench('Cambio rápido');
  await expect(page.locator('#project-label')).toHaveText('uno');

  // A link with ?p= keeps the repo after the token is exchanged for the cookie.
  const projectId = new URL(page.url()).searchParams.get('p');
  await page.goto(`/?token=e2e-token&p=${projectId}`);
  await expect(page).toHaveURL(new RegExp(`\\?p=${projectId}$`));
  await expect(page.locator('#project-label')).toHaveText('uno');
  expect(errors).toEqual([]);
});

test('a folder that is not a git repo: declined it is not added, accepted optimia creates the repo', async ({
  page
}) => {
  const plain = path.join(reposDir(), 'no-git');
  fs.mkdirSync(plain, { recursive: true });
  fs.writeFileSync(path.join(plain, 'notas.txt'), 'hola\n');
  await page.goto('/?token=e2e-token');
  await page.locator('#wb-manage').click();

  page.once('dialog', (d) => d.dismiss());
  await page.getByLabel('Ruta del repo').fill(plain);
  await page.getByRole('button', { name: 'Añadir', exact: true }).click();
  await expect(page.locator('.toast')).toContainText('la carpeta no es un repo git');
  expect(fs.existsSync(path.join(plain, '.git'))).toBe(false);

  let asked = '';
  page.once('dialog', (d) => {
    asked = d.message();
    d.accept();
  });
  await page.getByRole('button', { name: 'Añadir', exact: true }).click();
  await expect(page.locator('.wb-repos')).toContainText('no-git');
  expect(asked).toContain('¿Crear el repo ahí?');
  expect(fs.existsSync(path.join(plain, '.git'))).toBe(true);
  // An empty first commit, so tasks can branch off it; the user's files are left untouched.
  expect(execFileSync('git', ['log', '--format=%s'], { cwd: plain, encoding: 'utf8' }).trim()).toBe(
    'chore: initial commit'
  );
  expect(execFileSync('git', ['status', '--porcelain'], { cwd: plain, encoding: 'utf8' })).toContain('notas.txt');
});
