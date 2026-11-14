'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { e2eTmp, trackErrors } = require('./helpers');

const demo = () => path.join(e2eTmp(), 'repos', 'demo');

test('el dashboard refleja en vivo un cambio hecho fuera de optimia', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?token=e2e-token#/dashboard');
  const card = page.locator('.dash-card', { hasText: 'demo' });
  await expect(card).toBeVisible();
  await expect(card.locator('.dash-branch')).toHaveText('main');

  fs.writeFileSync(path.join(demo(), 'README.md'), '# demo\n\nlinea nueva desde fuera\n');
  await expect(card).toContainText('1 modificados', { timeout: 10_000 });
  await expect(card.locator('.dash-lines .add')).toHaveText('+2');
  // Otros tests comparten el repo y dejan ficheros nuevos: basta con que README.md este entre ellos.
  await expect(card.locator('.dash-file', { hasText: 'README.md' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('el visor de cambios muestra el diff y se actualiza solo', async ({ page }) => {
  const errors = trackErrors(page);
  fs.writeFileSync(path.join(demo(), 'README.md'), '# demo\n\nprimera version\n');
  await page.goto('/?token=e2e-token#/dashboard');
  await page.locator('.dash-card', { hasText: 'demo' }).getByRole('button', { name: 'Cambios' }).click();
  await expect(page).toHaveURL(/#\/changes/);
  const diff = page.locator('.diff-scroll');
  await expect(diff.locator('.dl-add')).toContainText(['primera version']);

  // El cambio llega sin recargar
  fs.writeFileSync(path.join(demo(), 'README.md'), '# demo\n\nsegunda version\n');
  await expect(diff.locator('.dl-add')).toContainText(['segunda version'], { timeout: 10_000 });

  // Lado a lado y fichero entero
  await page.getByRole('button', { name: 'Lado a lado' }).click();
  await expect(page.locator('.dl-row').first()).toBeVisible();
  await page.getByRole('button', { name: 'Fichero entero' }).click();
  await expect(diff).toContainText('# demo');
  await expect(page.locator('.diff-ruler .ruler-mark').first()).toBeAttached();

  // Fichero nuevo sin seguimiento: aparece en la lista con todo anadido
  fs.writeFileSync(path.join(demo(), 'nuevo.txt'), 'hola\n');
  await page.locator('.changes-file', { hasText: 'nuevo.txt' }).click({ timeout: 10_000 });
  await expect(diff.locator('.dl-add')).toContainText(['hola']);
  expect(errors).toEqual([]);
});
