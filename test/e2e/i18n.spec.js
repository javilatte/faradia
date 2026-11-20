'use strict';
/* global localStorage */

const { test, expect } = require('@playwright/test');
// The shared helper expects the Spanish "Conectado".
async function waitForChatReady(page) {
  await expect(page.locator('#connection-status')).toHaveAttribute('title', /^(Conectado|Connected)$/, {
    timeout: 10_000
  });
  await expect(page.locator('#chat-tabs .chat-tab.active')).toHaveCount(1, { timeout: 10_000 });
}

test.describe('in an English browser', () => {
  test.use({ locale: 'en-US' });

  test('the interface follows the browser, and Settings can switch it to Spanish', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/?token=e2e-token');
    await waitForChatReady(page);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('#main-nav')).toContainText('Chat & agents');
    await expect(page.locator('#send-button')).toHaveText('Send');
    await expect(page.locator('#chat-input')).toHaveAttribute('placeholder', 'Send a message or drop files');

    await page.locator('#settings-button').click();
    await page.locator('.settings-nav-item[data-pane="appearance"]').click();
    await expect(page.locator('label[for="setting-ui-language"]')).toHaveText('Language');
    await page.locator('#setting-ui-language').selectOption('es');
    await page.waitForLoadState('load');
    await waitForChatReady(page);
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    await expect(page.locator('#send-button')).toHaveText('Enviar');
    // Back to automatic, for the other tests.
    await page.evaluate(() => localStorage.removeItem('faradia:lang'));
    expect(errors).toEqual([]);
  });
});
