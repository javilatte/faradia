'use strict';

const { test, expect } = require('@playwright/test');
const { claudeCalls, argAfter, trackErrors, openProject } = require('./helpers');

const API = { headers: { 'X-Optimia-Token': 'e2e-token' } };

test('the verification shows the evidence optimia saw, and an OK the tests contradict is not trusted', async ({
  page
}) => {
  const errors = trackErrors(page);
  await openProject(page);
  await page.locator('#chat-kind-select').selectOption('coding');
  await page.locator('#chat-input').fill('Exportar a CSV');
  await page.locator('#chat-input').press('Enter');
  const card = page.locator('.task-card', { hasText: 'Exportar a CSV' });
  await expect(card).toHaveClass(/ready/, { timeout: 30_000 });
  await expect(card.locator('.verification-line')).toHaveText('✓ Verificación superada');
  const evidence = card.locator('.evidence');
  await expect(evidence.locator('summary').first()).toHaveText('Evidencia: 1 comprobación');
  await evidence.locator('summary').first().click();
  const check = evidence.locator('.evidence-check');
  await expect(check.locator('code')).toHaveText('npm test');
  await expect(check).toHaveClass(/ok/);
  await check.locator('summary').click();
  await expect(check.locator('pre')).toHaveText('12 passing');

  // The tests fail but the agent says OK: optimia goes by what ran.
  await page.locator('#chat-kind-select').selectOption('coding');
  await page.locator('#chat-input').fill('Importar desde CSV [e2e:verifica-mal]');
  await page.locator('#chat-input').press('Enter');
  const bad = page.locator('.task-card', { hasText: 'Importar desde CSV' });
  await expect(bad).toHaveClass(/ready/, { timeout: 30_000 });
  await expect(bad.locator('.verification')).toHaveClass(/unverified/);
  await expect(bad.locator('.verification summary').first()).toContainText('no respalda el «OK» del agente');
  await bad.locator('.verification summary').first().click();
  await expect(bad.locator('.verification-reason')).toContainText('npm test');
  await expect(bad.locator('.evidence > summary')).toHaveText('Evidencia: 1 comprobación (1 con fallos)');
  await expect(bad.locator('.pipeline-step.unverified')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('a constraint a comment defended becomes a correction task that ends with its check', async ({
  page,
  request
}) => {
  const errors = trackErrors(page);
  await openProject(page);
  await page.locator('#chat-kind-select').selectOption('coding');
  await page.locator('#chat-input').fill('Registrar los accesos [e2e:propuesta]');
  await page.locator('#chat-input').press('Enter');
  const card = page.locator('.task-card', { hasText: 'Registrar los accesos' });
  await expect(card).toHaveClass(/ready/, { timeout: 30_000 });
  const proposal = card.locator('.rule-proposal');
  await expect(proposal).toContainText('no usar console.log en src → regla de lint no-console');

  // "Crear corrección" fills the message box in Corrección mode; nothing is sent on its own.
  await proposal.getByRole('button', { name: 'Crear corrección' }).click();
  await expect(page.locator('#chat-kind-select')).toHaveValue('correction');
  await expect(page.locator('#chat-input')).toHaveValue(/^no usar console\.log en src/);
  const before = (await (await request.get('/api/tasks', API)).json()).length;
  expect((await (await request.get('/api/tasks', API)).json()).length).toBe(before);
  await page.locator('#chat-input').press('Enter');

  const correction = page.locator('.task-card', { hasText: 'no usar console.log en src' }).filter({
    has: page.locator('.task-type-badge.type-correction')
  });
  await expect(correction).toHaveClass(/ready/, { timeout: 30_000 });
  await expect(correction.locator('.pipeline-step strong')).toHaveText(['Corrección', 'Verificación']);
  await expect(correction.locator('.correction-chip')).toContainText('Comprobación: regla de lint');
  await expect(correction.locator('.correction-chip')).toContainText('no-console en src');
  // Its report is the correction (with its proof), not the verification after it.
  await expect(correction.locator('.task-output')).toContainText('probada contra el error real');

  const call = claudeCalls()
    .filter((c) => c.cwd.includes('/.optimia/worktrees/'))
    .find((c) => (argAfter(c.args, '--append-system-prompt') || '').includes('## Tu rol: Corrector'));
  expect(call).toBeTruthy();
  expect(argAfter(call.args, '--append-system-prompt')).toContain('### Encode Lessons in Structure');
  expect(errors).toEqual([]);
});

test('"Evitar que se repita…" starts a correction from a finished task', async ({ page }) => {
  const errors = trackErrors(page);
  await openProject(page);
  await page.locator('#chat-kind-select').selectOption('coding');
  await page.locator('#chat-input').fill('Cambiar el color del botón');
  await page.locator('#chat-input').press('Enter');
  const card = page.locator('.task-card', { hasText: 'Cambiar el color del botón' });
  await expect(card).toHaveClass(/ready/, { timeout: 30_000 });
  await card.getByRole('button', { name: 'Evitar que se repita…' }).click();
  await expect(page.locator('#chat-kind-select')).toHaveValue('correction');
  await expect(page.locator('#chat-input')).toHaveValue(
    'En la tarea «Cambiar el color del botón» el agente se equivocó: '
  );
  await expect(page.locator('#chat-input')).toBeFocused();
  expect(errors).toEqual([]);
});

test('Settings › Agents: principles can be turned off for everyone or changed per agent', async ({ page }) => {
  const errors = trackErrors(page);
  await openProject(page);
  await page.locator('#settings-button').click();
  await page.locator('.settings-nav-item[data-pane="agents"]').click();
  const verifier = page.locator('.agent-card[data-agent="verifier"]');
  await expect(verifier.locator('.agent-principles-head')).toContainText(
    'Principios: Explain the number, Prove it works, Test behavior not implementation'
  );
  await verifier.getByRole('button', { name: 'Elegir…' }).click();
  await verifier.getByLabel('Fix root causes').check();
  await expect(verifier.locator('.agent-principles-head')).toContainText('Fix root causes');
  await verifier.getByLabel('Fix root causes').uncheck();
  await expect(verifier.locator('.agent-principles-head')).not.toContainText('Fix root causes');

  await page.locator('#principles-enabled').uncheck();
  await expect(verifier.locator('.agent-principles')).toHaveClass(/off/);
  await page.locator('#principles-enabled').check();
  await expect(verifier.locator('.agent-principles')).not.toHaveClass(/off/);
  // Leave the verifier as it came (this run's settings are shared by the specs).
  await page.locator('#settings-close').click();
  expect(errors).toEqual([]);
});
