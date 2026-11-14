'use strict';

const { test, expect } = require('@playwright/test');
const { claudeCalls, argAfter, trackErrors, openProject, waitForChatReady } = require('./helpers');

test('cada etapa usa el modelo de su agente, y el modelo se puede cambiar por proyecto', async ({ page }) => {
  const errors = trackErrors(page);
  await openProject(page);

  // Ajustes > Agentes: el Planificador pasa de opus a haiku solo en este proyecto
  await page.locator('#settings-button').click();
  await page.locator('.settings-nav-item[data-pane="agents"]').click();
  const planner = page.locator('.agent-card[data-agent="planner"]');
  await expect(planner).toBeVisible();
  await planner.getByLabel('Modelo de Planificador').selectOption('haiku');
  await planner.getByRole('button', { name: 'Guardar' }).click();
  await expect(planner.locator('.wb-badge', { hasText: 'ajustado: project' })).toBeVisible();
  await page.locator('#settings-close').click();

  // Tarea de codigo: plan (Planificador) -> implement (Implementador) -> verify (Verificador)
  await page.locator('#chat-kind-select').selectOption('coding');
  await page.locator('#chat-input').fill('Anadir un boton de exportar');
  await page.locator('#chat-input').press('Enter');

  const card = page.locator('.task-card', { hasText: 'Anadir un boton de exportar' });
  await expect(card).toHaveClass(/ready/, { timeout: 30_000 });
  await expect(card.locator('.agent-chip')).toHaveText([
    'Planificador · haiku',
    'Implementador · sonnet',
    'Verificador · sonnet'
  ]);
  await expect(card.locator('.verification')).toHaveText('Verificación superada');

  const stageCalls = claudeCalls().filter((c) => c.cwd.includes('/.optimia/worktrees/'));
  const models = stageCalls.map((c) => argAfter(c.args, '--model'));
  expect(models.slice(-3)).toEqual(['haiku', 'sonnet', 'sonnet']);
  const prompts = stageCalls.slice(-3).map((c) => argAfter(c.args, '--append-system-prompt'));
  expect(prompts[0]).toContain('## Tu rol: Planificador');
  expect(prompts[2]).toContain('## Tu rol: Verificador');
  expect(errors).toEqual([]);
});

test('un agente propio aparece en el selector de modo y ejecuta su tarea de una etapa', async ({ page }) => {
  const errors = trackErrors(page);
  await openProject(page);
  await page.locator('#settings-button').click();
  await page.locator('.settings-nav-item[data-pane="agents"]').click();
  await page.getByLabel('Nombre del agente').fill('Revisor de accesibilidad');
  await page.getByLabel('Descripción del agente').fill('Revisa contraste y etiquetas');
  await page.getByLabel('Prompt del agente').fill('Revisa la accesibilidad (WCAG).');
  await page.getByRole('button', { name: 'Crear agente' }).click();
  const card = page.locator('.agent-card[data-agent="revisor-de-accesibilidad"]');
  await expect(card).toBeVisible();
  await card.getByLabel('Modelo de Revisor de accesibilidad').selectOption('opus');
  await card.getByRole('button', { name: 'Guardar' }).click();
  await page.locator('#settings-close').click();

  await page.reload();
  await waitForChatReady(page);
  await page.locator('#chat-kind-select').selectOption('custom:revisor-de-accesibilidad');
  await page.locator('#chat-input').fill('Revisar el formulario de alta');
  await page.locator('#chat-input').press('Enter');
  const task = page.locator('.task-card', { hasText: 'Revisar el formulario de alta' });
  await expect(task).toHaveClass(/ready/, { timeout: 20_000 });
  await expect(task.locator('.agent-chip')).toHaveText(['Revisor de accesibilidad · opus']);
  await expect(task).toContainText('Informe entregado');
  const last = claudeCalls().pop();
  expect(argAfter(last.args, '--model')).toBe('opus');
  expect(argAfter(last.args, '--append-system-prompt')).toContain('Revisa la accesibilidad (WCAG).');
  expect(errors).toEqual([]);
});
