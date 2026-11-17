'use strict';

const { test, expect } = require('@playwright/test');
const { trackErrors, openProject } = require('./helpers');

test('wiki: create pages linked with [[...]], follow a link, search and see the map', async ({ page }) => {
  const errors = trackErrors(page);
  await openProject(page);
  await page.locator('#main-nav [data-view="wiki"]').click();
  await expect(page.locator('.wiki-tree')).toContainText('demo');

  // A new page from the UI, written in the editor.
  page.once('dialog', (d) => d.accept('guias/despliegue'));
  await page.getByRole('button', { name: 'Nueva página…' }).click();
  const editor = page.locator('.wiki-editor');
  await expect(editor).toBeVisible();
  await editor.fill('# Despliegue\n\nSe publica con npm. Ver [[Arquitectura]].\n');
  await page.getByRole('button', { name: 'Guardar' }).click();
  await expect(page.locator('.wiki-body')).toContainText('Se publica con npm');
  // A link to a page that does not exist yet is marked as such.
  await expect(page.locator('.wiki-body a.wiki-missing')).toHaveText('Arquitectura');

  // The index links to it; following the link opens it, and it lists its backlinks.
  await page.locator('.wiki-tree').getByRole('button', { name: 'demo' }).click();
  await page.getByRole('button', { name: 'Editar' }).click();
  await page.locator('.wiki-editor').fill('# demo\n\n- [[Despliegue]]\n');
  await page.getByRole('button', { name: 'Guardar' }).click();
  await page.locator('.wiki-body').getByRole('link', { name: 'Despliegue' }).click();
  await expect(page.locator('.wiki-page-actions')).toContainText('guias/despliegue.md');
  await expect(page.locator('.wiki-backlinks')).toContainText('index.md');

  await page.getByLabel('Buscar en la wiki').fill('npm');
  await expect(page.locator('.wiki-result').first()).toContainText('Despliegue');
  await page.getByLabel('Buscar en la wiki').fill('');

  await page.getByRole('button', { name: 'Mapa' }).click();
  await expect(page.locator('.wiki-map .wiki-node')).toHaveCount(2);
  await expect(page.locator('.wiki-map .wiki-edge')).toHaveCount(1);

  // The personal wiki is another one.
  await page.getByRole('button', { name: 'Personal' }).click();
  await expect(page.locator('.wiki-count')).toContainText('Wiki personal');
  expect(errors).toEqual([]);
});
