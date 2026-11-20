'use strict';

const { test, expect } = require('@playwright/test');
const { trackErrors, openProject } = require('./helpers');

const SHOTS = process.env.FARADIA_FACE_SHOTS;

test('each agent shows its face on the task card, doing what its stage does', async ({ page }) => {
  const errors = trackErrors(page);
  await openProject(page);
  await page.locator('#chat-kind-select').selectOption('coding');
  await page.locator('#chat-input').fill('Exportar el informe a CSV [e2e:lento]');
  await page.locator('#chat-input').press('Enter');

  const card = page.locator('.task-card', { hasText: 'Exportar el informe a CSV' });
  const face = card.locator('.task-head .agent-face');
  // The Planner plans: it thinks.
  await expect(face).toHaveAttribute('title', 'Planificador');
  await expect(face.locator('.aa-avatar')).toHaveClass(/aa-thinking/);
  if (SHOTS) await card.screenshot({ path: `${SHOTS}/face-thinking.png` });
  // The Implementer works.
  await expect(face).toHaveAttribute('title', 'Implementador', { timeout: 30_000 });
  await expect(face.locator('.aa-avatar')).toHaveClass(/aa-working/);
  if (SHOTS) await card.screenshot({ path: `${SHOTS}/face-working.png` });
  // The Verifier reads the work.
  await expect(face).toHaveAttribute('title', 'Verificador', { timeout: 30_000 });
  await expect(face.locator('.aa-avatar')).toHaveClass(/aa-reading/);
  if (SHOTS) await card.screenshot({ path: `${SHOTS}/face-reviewing.png` });
  // Ready: it smiles.
  await expect(card).toHaveClass(/ready/, { timeout: 30_000 });
  await expect(face.locator('.aa-avatar')).toHaveClass(/aa-happy/);
  if (SHOTS) await card.screenshot({ path: `${SHOTS}/face-done.png` });
  expect(errors).toEqual([]);
});

test('an agent can change its face, and Settings › Apariencia turns the faces off', async ({ page }) => {
  const errors = trackErrors(page);
  await openProject(page);
  await page.locator('#settings-button').click();
  await page.locator('.settings-nav-item[data-pane="agents"]').click();
  const planner = () => page.locator('.agent-card[data-agent="planner"]');
  await expect(planner().locator('.agent-face-btn .aa-avatar')).toBeVisible();
  await planner().getByLabel('Cambiar la cara de Planificador').click();
  await planner().getByLabel('Forma: Hexágono').click();
  await expect(planner().getByLabel('Forma: Hexágono')).toHaveAttribute('aria-pressed', 'true');
  await planner().getByLabel('Color: Arcilla').click();
  await expect(planner().getByLabel('Color: Arcilla')).toHaveAttribute('aria-pressed', 'true');
  if (SHOTS) {
    await page.waitForTimeout(600);
    await planner().screenshot({ path: `${SHOTS}/face-picker.png` });
  }

  // Its face is back to the built-in one with the rest of its settings.
  await planner().getByRole('button', { name: 'Restablecer' }).click();
  await expect(planner().locator('.wb-badge', { hasText: 'todos los repos' })).toHaveCount(0);

  await page.locator('.settings-nav-item[data-pane="appearance"]').click();
  await page.getByLabel('Caras de los agentes').uncheck();
  await page.locator('#settings-close').click();
  await page.locator('#chat-kind-select').selectOption('coding');
  await page.locator('#chat-input').fill('Tarea sin caras');
  await page.locator('#chat-input').press('Enter');
  const card = page.locator('.task-card', { hasText: 'Tarea sin caras' });
  await expect(card).toHaveClass(/ready/, { timeout: 30_000 });
  await expect(card.locator('.agent-face')).toHaveCount(0);

  // Back on, for the other tests (settings are shared by the run).
  await page.locator('#settings-button').click();
  await page.locator('.settings-nav-item[data-pane="appearance"]').click();
  await page.getByLabel('Caras de los agentes').check();
  expect(errors).toEqual([]);
});
