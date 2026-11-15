'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { e2eTmp, trackErrors } = require('./helpers');

const demo = () => path.join(e2eTmp(), 'repos', 'demo');
const git = (...args) => execFileSync('git', args, { cwd: demo(), stdio: 'pipe' });

test('the timeline collects changes, commits and the watchlist live', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?token=e2e-token#/timeline');
  await expect(page.locator('.view-timeline h2')).toHaveText('Timeline');

  fs.writeFileSync(path.join(demo(), 'notas.md'), 'tl\n');
  const files = page.locator('.tl-entry.kind-files', { hasText: 'notas.md' });
  await expect(files).toBeVisible({ timeout: 10_000 });

  fs.writeFileSync(path.join(demo(), '.env'), 'TOKEN=1\n');
  await expect(page.locator('.tl-entry.kind-watch', { hasText: '.env' })).toContainText('creado', { timeout: 10_000 });

  git('add', 'notas.md');
  git('commit', '-q', '-m', 'docs: notas del timeline');
  const commit = page.locator('.tl-entry.kind-commit', { hasText: 'docs: notas del timeline' });
  await expect(commit).toBeVisible({ timeout: 10_000 });

  // Filtering by kind leaves only commits
  await page.locator('.tl-chip', { hasText: 'Ficheros' }).click();
  await expect(page.locator('.tl-entry.kind-files')).toHaveCount(0);

  // From the commit to the diff
  await commit.locator('.tl-commit').click();
  await expect(page).toHaveURL(/#\/changes/);
  await expect(page.locator('.commit-chip')).toContainText('docs: notas del timeline');
  await expect(page.locator('.changes-file', { hasText: 'notas.md' })).toBeVisible();
  await expect(page.locator('.diff-scroll .dl-add')).toContainText(['tl']);
  await page.getByRole('button', { name: 'Volver al árbol de trabajo' }).click();
  await expect(page.locator('.commit-chip')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the commit history opens any commit of the repo', async ({ page }) => {
  await page.goto('/?token=e2e-token#/timeline');
  const first = page.locator('.tl-commit-item').filter({ hasText: 'init' });
  await expect(first).toBeVisible();
  await first.click();
  await expect(page.locator('.changes-file', { hasText: 'README.md' })).toBeVisible();
});
