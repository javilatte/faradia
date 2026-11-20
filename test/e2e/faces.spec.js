'use strict';

const { test, expect } = require('@playwright/test');
const { trackErrors, openProject } = require('./helpers');

const SHOTS = process.env.FARADIA_FACE_SHOTS;

test('each agent shows its face on the task card, doing what the task does', async ({ page }) => {
  const errors = trackErrors(page);
  await openProject(page);
  await page.locator('#chat-kind-select').selectOption('coding');
  await page.locator('#chat-input').fill('Exportar el informe a CSV [e2e:lento]');
  await page.locator('#chat-input').press('Enter');

  const card = page.locator('.task-card', { hasText: 'Exportar el informe a CSV' });
  const face = card.locator('.task-head faradia-face');
  // The Planner plans: its own skin, waiting while it works.
  await expect(face).toHaveAttribute('skin', '1002');
  await expect(face).toHaveAttribute('data-state', /thinking|working/);
  if (SHOTS) await card.screenshot({ path: `${SHOTS}/face-working.png` });
  // The Verifier checks the work.
  await expect(face).toHaveAttribute('skin', '1007', { timeout: 30_000 });
  await expect(face).toHaveAttribute('data-state', 'reviewing');
  if (SHOTS) await card.screenshot({ path: `${SHOTS}/face-reviewing.png` });
  // Ready: it smiles.
  await expect(card).toHaveClass(/ready/, { timeout: 30_000 });
  await expect(face).toHaveAttribute('data-state', 'done');
  await page.waitForTimeout(600);
  if (SHOTS)
    await page
      .locator('#col-ready-to-test, .task-card.ready')
      .first()
      .screenshot({ path: `${SHOTS}/face-done.png` });
  expect(errors).toEqual([]);
});

test('an agent can change its face, and Settings › Apariencia turns the faces off', async ({ page }) => {
  const errors = trackErrors(page);
  await openProject(page);
  await page.locator('#settings-button').click();
  await page.locator('.settings-nav-item[data-pane="agents"]').click();
  const planner = page.locator('.agent-card[data-agent="planner"]');
  await expect(planner.locator('.agent-face-btn faradia-face')).toHaveAttribute('skin', '1002');
  await planner.getByLabel('Cambiar la cara de Planificador').click();
  if (SHOTS) {
    await page.waitForTimeout(800);
    await planner.screenshot({ path: `${SHOTS}/face-picker.png` });
  }
  await planner.locator('.face-choice[title="Piel 1503"]').click();
  await expect(page.locator('.agent-card[data-agent="planner"] .agent-face-btn faradia-face')).toHaveAttribute(
    'skin',
    '1503'
  );

  await page.locator('.settings-nav-item[data-pane="appearance"]').click();
  await page.getByLabel('Caras de los agentes').uncheck();
  await page.locator('#settings-close').click();
  await page.locator('#chat-kind-select').selectOption('coding');
  await page.locator('#chat-input').fill('Tarea sin caras');
  await page.locator('#chat-input').press('Enter');
  const card = page.locator('.task-card', { hasText: 'Tarea sin caras' });
  await expect(card).toHaveClass(/ready/, { timeout: 30_000 });
  await expect(card.locator('faradia-face')).toHaveCount(0);

  // Back on, for the other tests (settings are shared by the run).
  await page.locator('#settings-button').click();
  await page.locator('.settings-nav-item[data-pane="appearance"]').click();
  await page.getByLabel('Caras de los agentes').check();
  expect(errors).toEqual([]);
});
