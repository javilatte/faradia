'use strict';

const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { trackErrors, openProject, e2eTmp } = require('./helpers');
const { version } = require('../../package.json');

const stateFile = () => path.join(e2eTmp(), 'home', '.config', 'faradia', 'state.json');

test("after an update the what's new tour shows once, steps through, and Esc closes it for good", async ({ page }) => {
  const errors = trackErrors(page);
  const state = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  // As if the last version seen were the previous one.
  fs.writeFileSync(stateFile(), JSON.stringify({ ...state, tourSeen: '2.4.0' }));
  try {
    await openProject(page);
    const tour = page.locator('.tour-sheet');
    await expect(tour).toContainText(`Novedades de Faradia ${version}`);
    // The name change comes first: whoever updates learns it at once.
    await expect(tour).toContainText('optimia ahora es Faradia');
    await tour.getByRole('button', { name: 'Siguiente' }).click();
    await expect(tour).toContainText('npm i -g faradia');
    await page.keyboard.press('ArrowLeft');
    await expect(tour).toContainText('optimia ahora es Faradia');
    await page.keyboard.press('Escape');
    await expect(tour).toBeHidden();
    await expect.poll(() => JSON.parse(fs.readFileSync(stateFile(), 'utf8')).tourSeen).toBe(version);
    await page.reload();
    await expect(page.locator('#chat-input')).toBeVisible();
    await expect(page.locator('.tour-sheet')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    fs.writeFileSync(stateFile(), JSON.stringify({ ...state, tourSeen: version }));
  }
});
