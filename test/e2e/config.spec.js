'use strict';

/* global DataTransfer, DragEvent, document -- used inside page.evaluate (browser context) */
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { trackErrors, openProject, e2eTmp } = require('./helpers');

const HEADERS = { 'X-Optimia-Token': 'e2e-token' };
const configDir = () => path.join(e2eTmp(), 'home', '.config', 'optimia');

// Drops a file on the window the way a browser does when dragging from the desktop.
async function dropFile(page, name, content) {
  await page.evaluate(
    ([name, content]) => {
      const dt = new DataTransfer();
      dt.items.add(new File([content], name, { type: 'application/json' }));
      for (const type of ['dragover', 'drop']) {
        document.body.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
      }
    },
    [name, content]
  );
}

test('first run: import the configuration from the welcome sheet, export it, and drop it back', async ({
  page,
  request
}) => {
  const errors = trackErrors(page);
  // Keep whatever earlier specs left, to restore it at the end.
  const original = await (await request.get('/api/config/export?secrets=1', { headers: HEADERS })).json();

  const mine = {
    ...original,
    settings: { ...original.settings, preferences: { instructions: 'Mi flujo: Conventional Commits.', noGo: [] } },
    agents: [{ id: 'traductor', content: '---\nname: Traductor\naccess: read\n---\nTraduce al inglés.\n' }]
  };
  const file = path.join(e2eTmp(), 'optimia-config-test.json');
  fs.writeFileSync(file, JSON.stringify(mine));

  // A fresh machine: no global settings, no global agents and no "welcomed" mark.
  fs.rmSync(path.join(configDir(), 'state.json'), { force: true });
  fs.rmSync(path.join(configDir(), 'settings.json'), { force: true });
  for (const name of fs.existsSync(path.join(configDir(), 'agents'))
    ? fs.readdirSync(path.join(configDir(), 'agents'))
    : []) {
    if (name.endsWith('.md')) fs.rmSync(path.join(configDir(), 'agents', name));
  }
  await openProject(page);
  const welcome = page.locator('.welcome-sheet');
  await expect(welcome).toContainText('Bienvenido a optimia 2');

  const chooser = page.waitForEvent('filechooser');
  await welcome.getByRole('button', { name: 'Elegir fichero…' }).click();
  await (await chooser).setFiles(file);
  const preview = page.locator('.import-sheet');
  await expect(preview).toContainText('Instrucciones para todos los repos');
  await expect(preview).toContainText('Traductor');
  // Importing reloads the page by itself: wait for that reload, not just for the current load.
  await Promise.all([page.waitForEvent('load'), preview.getByRole('button', { name: 'Importar' }).click()]);
  await expect(page.locator('.welcome-sheet')).toHaveCount(0);

  let s = await (await request.get('/api/settings', { headers: HEADERS })).json();
  expect(s.preferences.globalInstructions).toBe('Mi flujo: Conventional Commits.');
  const exported = await (await request.get('/api/config/export', { headers: HEADERS })).json();
  expect(exported.agents.map((a) => a.id)).toEqual(['traductor']);

  // Dropping the original back onto the window restores it (after a preview).
  await openProject(page);
  // The drop handler is bound by a module that may still be loading on a slow machine: drop again
  // until the preview shows.
  const sheet = page.locator('.import-sheet');
  await expect(async () => {
    if (!(await sheet.isVisible())) await dropFile(page, 'optimia-config-original.json', JSON.stringify(original));
    await expect(sheet).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20_000 });
  await sheet.getByRole('button', { name: 'Importar' }).click();
  await page.waitForLoadState('load');
  s = await (await request.get('/api/settings', { headers: HEADERS })).json();
  expect(s.preferences.globalInstructions).toBe(original.settings.preferences.instructions);
  expect(errors).toEqual([]);
});

test('a non-optimia JSON file is rejected with a clear message', async ({ page }) => {
  await openProject(page);
  await dropFile(page, 'package.json', JSON.stringify({ name: 'x' }));
  await expect(page.locator('.toast').last()).toContainText('no es un fichero de configuración de optimia');
  await expect(page.locator('.import-sheet')).toHaveCount(0);
});

test('a newer version shows a notice in the toolbar with how to update', async ({ page }) => {
  await page.route('**/api/update*', (route) =>
    route.fulfill({
      json: {
        current: '2.0.0',
        latest: '2.1.0',
        updateAvailable: true,
        installCommand: 'npm install -g @javilatte/optimia@latest',
        releaseUrl: 'https://github.com/javilatte/optimia/releases/tag/v2.1.0'
      }
    })
  );
  await openProject(page);
  const pill = page.locator('#update-button');
  await expect(pill).toBeVisible();
  await expect(pill).toHaveText('optimia 2.1.0');
  await pill.click();
  const sheet = page.locator('.sheet');
  await expect(sheet).toContainText('optimia 2.1.0 está disponible');
  await expect(sheet.locator('.update-command')).toHaveText('npm install -g @javilatte/optimia@latest');
  await sheet.getByRole('button', { name: 'Ahora no' }).click();
  await expect(pill).toBeHidden();
});
