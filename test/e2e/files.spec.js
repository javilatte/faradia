'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { e2eTmp, trackErrors } = require('./helpers');

const demo = () => path.join(e2eTmp(), 'repos', 'demo');
// PNG de 1x1 pixel
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

test.beforeEach(() => {
  fs.mkdirSync(path.join(demo(), 'docs'), { recursive: true });
  fs.writeFileSync(path.join(demo(), 'docs', 'guia.md'), '# Guia\n\nTexto **importante**.\n');
  fs.writeFileSync(path.join(demo(), 'docs', 'logo.png'), PNG);
});

test('explorar, previsualizar markdown e imagen, y copiar la ruta', async ({ page, context }) => {
  const errors = trackErrors(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/?token=e2e-token#/files');
  await page.locator('.fx-node', { hasText: 'docs' }).click();
  await page.locator('.fx-node', { hasText: 'guia.md' }).click();
  await expect(page.locator('.fx-md')).toContainText('importante');
  await page.getByRole('button', { name: 'Copiar ruta' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('docs/guia.md');

  await page.locator('.fx-node', { hasText: 'logo.png' }).click();
  const img = page.locator('img.fx-media');
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el) => el.naturalWidth)).toBe(1);

  // El arbol recuerda lo plegado al volver
  await page.reload();
  await expect(page.locator('.fx-node', { hasText: 'guia.md' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('renombrar, borrar con deshacer, papelera y portapapeles', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?token=e2e-token#/files');
  await page.locator('.fx-node', { hasText: 'docs' }).click();
  await page.locator('.fx-node', { hasText: 'guia.md' }).click();

  page.once('dialog', (d) => d.accept('manual.md'));
  await page.getByRole('button', { name: 'Renombrar' }).click();
  await expect(page.locator('.fx-node', { hasText: 'manual.md' })).toBeVisible();
  expect(fs.existsSync(path.join(demo(), 'docs', 'manual.md'))).toBe(true);

  // Borrar y deshacer desde el aviso
  await page.getByRole('button', { name: 'Borrar' }).click();
  await expect(page.locator('.fx-node', { hasText: 'manual.md' })).toHaveCount(0);
  expect(fs.existsSync(path.join(demo(), 'docs', 'manual.md'))).toBe(false);
  await page.locator('.toast', { hasText: 'papelera' }).getByRole('button', { name: 'Deshacer' }).click();
  await expect(page.locator('.fx-node', { hasText: 'manual.md' })).toBeVisible();

  // Borrar y restaurar desde la papelera
  await page.locator('.fx-node', { hasText: 'manual.md' }).click();
  await page.getByRole('button', { name: 'Borrar' }).click();
  await page.getByRole('button', { name: 'Papelera' }).click();
  await page.locator('#fx-trash li', { hasText: 'manual.md' }).getByRole('button', { name: 'Restaurar' }).click();
  await expect(page.locator('.fx-node', { hasText: 'manual.md' })).toBeVisible();

  // Copiar al portapapeles y pegar en la raiz
  await page.locator('.fx-node', { hasText: 'manual.md' }).click();
  await page.getByRole('button', { name: 'Copiar', exact: true }).click();
  await expect(page.locator('.fx-clipboard')).toContainText('docs/manual.md');
  await page.locator('.fx-node', { hasText: 'README.md' }).click();
  await page
    .locator('.fx-clipboard')
    .getByRole('button', { name: /Pegar en la raíz/ })
    .click();
  await expect.poll(() => fs.existsSync(path.join(demo(), 'manual.md'))).toBe(true);
  expect(errors).toEqual([]);
});

test('los ficheros en bruto se sirven con Range y sin poder ejecutar scripts', async ({ page, request }) => {
  await page.goto('/?token=e2e-token');
  const { projects, defaultProjectId } = await page.evaluate(() => fetch('/api/projects').then((r) => r.json()));
  expect(projects.length).toBeGreaterThan(0);
  fs.writeFileSync(
    path.join(demo(), 'x.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
  );
  const headers = { 'X-Optimia-Token': 'e2e-token' };
  const svg = await request.get(`/api/fs/raw?projectId=${defaultProjectId}&path=x.svg`, { headers });
  expect(svg.headers()['content-security-policy']).toContain('sandbox');
  const partial = await request.get(`/api/fs/raw?projectId=${defaultProjectId}&path=docs/logo.png`, {
    headers: { ...headers, Range: 'bytes=0-3' }
  });
  expect(partial.status()).toBe(206);
  expect((await partial.body()).length).toBe(4);
  const escape = await request.get(`/api/fs/raw?projectId=${defaultProjectId}&path=../../etc/passwd`, { headers });
  expect(escape.status()).toBe(400);
});
