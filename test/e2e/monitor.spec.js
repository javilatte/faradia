'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { e2eTmp, trackErrors } = require('./helpers');

const demo = () => path.join(e2eTmp(), 'repos', 'demo');

test('the dashboard reflects live a change made outside optimia', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?token=e2e-token#/dashboard');
  const card = page.locator('.dash-card', { hasText: 'demo' });
  await expect(card).toBeVisible();
  await expect(card.locator('.dash-branch')).toHaveText('main');

  fs.writeFileSync(path.join(demo(), 'README.md'), '# demo\n\nlinea nueva desde fuera\n');
  await expect(card).toContainText('1 modificados', { timeout: 10_000 });
  await expect(card.locator('.dash-lines .add')).toHaveText('+2');
  // Other tests share the repo and leave new files around: it is enough that README.md is among
  // them.
  await expect(card.locator('.dash-file', { hasText: 'README.md' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('the changes viewer shows the diff and refreshes by itself', async ({ page }) => {
  const errors = trackErrors(page);
  fs.writeFileSync(path.join(demo(), 'README.md'), '# demo\n\nprimera version\n');
  await page.goto('/?token=e2e-token#/dashboard');
  await page.locator('.dash-card', { hasText: 'demo' }).getByRole('button', { name: 'Cambios' }).click();
  await expect(page).toHaveURL(/#\/changes/);
  const diff = page.locator('.diff-scroll');
  await expect(diff.locator('.dl-add')).toContainText(['primera version']);

  // The change arrives without reloading
  fs.writeFileSync(path.join(demo(), 'README.md'), '# demo\n\nsegunda version\n');
  await expect(diff.locator('.dl-add')).toContainText(['segunda version'], { timeout: 10_000 });

  // Side by side and whole file
  await page.getByRole('button', { name: 'Lado a lado' }).click();
  await expect(page.locator('.dl-row').first()).toBeVisible();
  await page.getByRole('button', { name: 'Fichero entero' }).click();
  await expect(diff).toContainText('# demo');
  await expect(page.locator('.diff-ruler .ruler-mark').first()).toBeAttached();

  // New untracked file: listed with everything added
  fs.writeFileSync(path.join(demo(), 'nuevo.txt'), 'hola\n');
  await page.locator('.changes-file', { hasText: 'nuevo.txt' }).click({ timeout: 10_000 });
  await expect(diff.locator('.dl-add')).toContainText(['hola']);
  expect(errors).toEqual([]);
});
