'use strict';
/* global window */ // addInitScript and evaluate run inside the browser

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { e2eTmp, trackErrors } = require('./helpers');

const demo = () => path.join(e2eTmp(), 'repos', 'demo');
// Fake secret built in pieces: this file does not contain one literally.
const FAKE_GITHUB_TOKEN = 'ghp_' + 'x'.repeat(36);

// Replaces the notifications API with one that only records them (permission granted).
async function captureNotifications(page) {
  await page.addInitScript(() => {
    window.__notifications = [];
    class FakeNotification {
      static permission = 'granted';
      static requestPermission = async () => 'granted';
      constructor(title, opts) {
        window.__notifications.push({ title, body: opts?.body });
      }
    }
    window.Notification = FakeNotification;
  });
}

test('a secret in a committable file shows up on the dashboard and notifies', async ({ page }) => {
  const errors = trackErrors(page);
  await captureNotifications(page);
  await page.goto('/?token=e2e-token#/dashboard');
  await expect(page.locator('.dash-card', { hasText: 'demo' })).toBeVisible();

  fs.writeFileSync(path.join(demo(), 'config.js'), `module.exports = { token: '${FAKE_GITHUB_TOKEN}' };\n`);
  const panel = page.locator('.dash-signals');
  await expect(panel).toContainText('Posible token de GitHub en config.js:1', { timeout: 10_000 });
  await expect(panel).not.toContainText(FAKE_GITHUB_TOKEN);
  await expect
    .poll(() => page.evaluate(() => window.__notifications.map((n) => n.body).join('\n')))
    .toContain('config.js:1');

  // A key git does NOT ignore: exposed sensitive file signal and secret signal
  fs.writeFileSync(path.join(demo(), 'deploy.key'), `TOKEN=${FAKE_GITHUB_TOKEN}\n`);
  await expect(panel).toContainText('deploy.key (git NO lo ignora: se commitearía)', { timeout: 10_000 });
  await expect(panel).toContainText('Posible token de GitHub en deploy.key:1');

  // Ignored by git: still sensitive, but its content is not scanned
  fs.writeFileSync(path.join(demo(), '.gitignore'), 'secretos.pem\n');
  fs.writeFileSync(path.join(demo(), 'secretos.pem'), `TOKEN=${FAKE_GITHUB_TOKEN}\n`);
  await expect(panel).toContainText('Ha cambiado un fichero sensible: secretos.pem', { timeout: 10_000 });
  await expect(panel).not.toContainText('secretos.pem (git NO');
  await expect(panel).not.toContainText('Posible token de GitHub en secretos.pem');
  fs.rmSync(path.join(demo(), 'deploy.key'));
  fs.rmSync(path.join(demo(), 'config.js'));
  expect(errors).toEqual([]);
});

test('Settings > Signals and watchlist: rules, thresholds and watchlist', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?token=e2e-token');
  await page.locator('#settings-button').click();
  await page.locator('.settings-nav-item[data-pane="monitor"]').click();
  await expect(page.locator('#settings-overlay .settings-footer')).toBeHidden();
  await page.getByLabel('Notificar Cambios en tests').check();
  await expect(page.locator('.toast').last()).toContainText('Guardado');
  const area = page.getByLabel('Patrones de la lista de vigilancia');
  await expect(area).toHaveValue(/\.env/);
  await area.fill('.env\nbuild/**\n');
  await page.getByRole('button', { name: 'Guardar lista' }).click();
  await expect(page.locator('.toast').last()).toContainText('Lista de vigilancia guardada');

  // The new rule applies: a file in build/ (ignored by git) is watched
  fs.appendFileSync(path.join(demo(), '.gitignore'), 'build/\n');
  fs.mkdirSync(path.join(demo(), 'build'), { recursive: true });
  await page.locator('#settings-close').click();
  await page.goto('/?token=e2e-token#/timeline');
  fs.writeFileSync(path.join(demo(), 'build', 'out.js'), 'x');
  await expect(page.locator('.tl-entry.kind-watch', { hasText: 'build/out.js' })).toBeVisible({ timeout: 10_000 });
  expect(errors).toEqual([]);
});

test('the glance window shows one line per repo and updates live', async ({ page }) => {
  await page.goto('/?token=e2e-token');
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.locator('#glance-button').click()]);
  await expect(popup.locator('.glance-line', { hasText: 'demo' })).toBeVisible();
  fs.writeFileSync(path.join(demo(), 'README.md'), '# demo\ncambio para el vistazo\n');
  await expect(popup.locator('.glance-line', { hasText: 'demo' })).toContainText('+', { timeout: 10_000 });
});
