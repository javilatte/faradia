'use strict';

const { test, expect } = require('@playwright/test');
const { trackErrors, openProject } = require('./helpers');

test('ajustes por capas: lo global llega al repo y el repo puede tener lo suyo', async ({ page, request }) => {
  const errors = trackErrors(page);
  await openProject(page);
  await page.locator('#settings-button').click();
  await page.locator('.settings-nav-item[data-pane="instructions"]').click();

  // Todos los repos: el flujo de trabajo común
  await page.locator('#settings-scope [data-scope="global"]').click();
  await page.locator('#setting-instructions').fill('Commits en Conventional Commits.');
  await page.locator('#setting-instructions').blur();
  await expect(page.locator('#settings-save-status')).toHaveText('Guardado para todos los repos');

  // Solo este repo: se ven las comunes y se añaden las propias
  await page.locator('#settings-scope [data-scope="project"]').click();
  await expect(page.locator('#instructions-inherited')).toBeVisible();
  await expect(page.locator('#instructions-inherited .inherited-text')).toHaveText('Commits en Conventional Commits.');
  await page.locator('#setting-instructions').fill('Tests con node:test.');
  await page.locator('#setting-instructions').blur();
  await expect(page.locator('#settings-save-status')).toHaveText('Guardado solo para este repo');

  // Un valor propio del repo, y volver a heredarlo
  await page.locator('.settings-nav-item[data-pane="claude"]').click();
  await page.locator('#setting-claude-effort').selectOption('low');
  const origin = page.locator('#setting-claude-effort ~ .field-origin');
  await expect(origin).toContainText('Propio de este repo');
  await origin.getByRole('button', { name: 'Restablecer' }).click();
  await expect(origin).toHaveText('Igual que en todos los repos');

  const res = await request.get('/api/settings', { headers: { 'X-Optimia-Token': 'e2e-token' } });
  const s = await res.json();
  expect(s.preferences.globalInstructions).toBe('Commits en Conventional Commits.');
  expect(s.preferences.projectInstructions).toBe('Tests con node:test.');
  expect(s.layers.overrides).toEqual([]);
  expect(errors).toEqual([]);
});
