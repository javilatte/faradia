'use strict';

const { test, expect } = require('@playwright/test');
const { trackErrors, openProject } = require('./helpers');

test('layered settings: global settings reach the repo and the repo can have its own', async ({ page, request }) => {
  const errors = trackErrors(page);
  await openProject(page);
  await page.locator('#settings-button').click();
  await page.locator('.settings-nav-item[data-pane="instructions"]').click();

  // All repos: the shared workflow
  await page.locator('#settings-scope [data-scope="global"]').click();
  await page.locator('#setting-instructions').fill('Commits en Conventional Commits.');
  await page.locator('#setting-instructions').blur();
  await expect(page.locator('#settings-save-status')).toHaveText('Guardado para todos los repos');

  // Only this repo: the shared ones are shown and the repo's own are added
  await page.locator('#settings-scope [data-scope="project"]').click();
  await expect(page.locator('#instructions-inherited')).toBeVisible();
  await expect(page.locator('#instructions-inherited .inherited-text')).toHaveText('Commits en Conventional Commits.');
  await page.locator('#setting-instructions').fill('Tests con node:test.');
  await page.locator('#setting-instructions').blur();
  await expect(page.locator('#settings-save-status')).toHaveText('Guardado solo para este repo');

  // A repo's own value, and inheriting it again
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
