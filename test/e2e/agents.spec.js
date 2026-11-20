'use strict';

const { test, expect } = require('@playwright/test');
const { claudeCalls, argAfter, trackErrors, openProject, waitForChatReady } = require('./helpers');

test("each stage uses its agent's model, and the model can be changed per repo", async ({ page }) => {
  const errors = trackErrors(page);
  await openProject(page);

  // Settings > Agents: the Planner goes from opus to haiku in this repo only
  await page.locator('#settings-button').click();
  await page.locator('.settings-nav-item[data-pane="agents"]').click();
  // Only this repo: the change does not affect the others
  await page.locator('#settings-scope [data-scope="project"]').click();
  const planner = page.locator('.agent-card[data-agent="planner"]');
  await expect(planner).toBeVisible();
  await planner.getByLabel('Modelo de Planificador').selectOption('haiku');
  await expect(planner.locator('.wb-badge', { hasText: 'cambiado en este repo' })).toBeVisible();
  await page.locator('#settings-close').click();

  // Coding task: plan (Planner) -> implement (Implementer) -> verify (Verifier)
  await page.locator('#chat-kind-select').selectOption('coding');
  await page.locator('#chat-input').fill('Anadir un boton de exportar');
  await page.locator('#chat-input').press('Enter');

  const card = page.locator('.task-card', { hasText: 'Anadir un boton de exportar' });
  await expect(card).toHaveClass(/ready/, { timeout: 30_000 });
  await expect(card.locator('.pipeline-step strong')).toHaveText([
    'Planificación',
    'Implementación',
    'Comentarios',
    'Verificación'
  ]);
  await expect(card.locator('.pipeline-step small')).toHaveText([
    'Planificador · haiku',
    'Implementador · sonnet',
    'Cazacomentarios · sonnet',
    'Verificador · sonnet'
  ]);
  await expect(card.locator('.pipeline-step.done')).toHaveCount(4);
  await expect(card.locator('.verification-line')).toHaveText('✓ Verificación superada');

  const stageCalls = claudeCalls().filter((c) => c.cwd.includes('/faradia/worktrees/'));
  const models = stageCalls.map((c) => argAfter(c.args, '--model'));
  expect(models.slice(-4)).toEqual(['haiku', 'sonnet', 'sonnet', 'sonnet']);
  const prompts = stageCalls.slice(-4).map((c) => argAfter(c.args, '--append-system-prompt'));
  expect(prompts[0]).toContain('## Tu rol: Planificador');
  expect(prompts[0]).toContain('### Foundational Thinking');
  expect(prompts[2]).toContain('## Método: Comment Sicko');
  expect(prompts[3]).toContain('## Tu rol: Verificador');
  expect(prompts[3]).toContain('### Prove It Works');
  expect(errors).toEqual([]);
});

test('a custom agent shows in the mode selector and runs its single-stage task', async ({ page }) => {
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
  await page.locator('#settings-close').click();

  await page.reload();
  await waitForChatReady(page);
  await page.locator('#chat-kind-select').selectOption('custom:revisor-de-accesibilidad');
  await page.locator('#chat-input').fill('Revisar el formulario de alta');
  await page.locator('#chat-input').press('Enter');
  const task = page.locator('.task-card', { hasText: 'Revisar el formulario de alta' });
  await expect(task).toHaveClass(/ready/, { timeout: 20_000 });
  await expect(task.locator('.pipeline-step small')).toHaveText(['Revisor de accesibilidad · opus']);
  await expect(task).toContainText('Informe entregado');
  // The task's stage ran in its worktree (the report then goes to the wiki with another session).
  const last = claudeCalls()
    .filter((c) => c.cwd.includes('/faradia/worktrees/'))
    .pop();
  expect(argAfter(last.args, '--model')).toBe('opus');
  expect(argAfter(last.args, '--append-system-prompt')).toContain('Revisa la accesibilidad (WCAG).');
  expect(errors).toEqual([]);
});

test('a forbidden action does not stop the stage: the agent goes on and the card records it', async ({
  page,
  request
}) => {
  const errors = trackErrors(page);
  await openProject(page);
  await page.locator('#chat-kind-select').selectOption('coding');
  await page.locator('#chat-input').fill('Limpiar temporales [e2e:denegar]');
  await page.locator('#chat-input').press('Enter');
  const card = page.locator('.task-card', { hasText: 'Limpiar temporales' });
  await expect(card).toHaveClass(/ready/, { timeout: 30_000 });
  await expect(card.locator('.pipeline-step.done')).toHaveCount(4);
  const tasks = await (await request.get('/api/tasks', { headers: { 'X-Faradia-Token': 'e2e-token' } })).json();
  const task = tasks.find((t) => t.title.startsWith('Limpiar temporales'));
  expect(task.blockedCommands.map((b) => b.command)).toEqual(['rm -rf /tmp/e2e-basura']);
  expect(task.error).toBeNull();
  // The activity feed tells the story: each stage, the command it tried, the denial, the stage end.
  await card.getByRole('button', { name: 'Ver actividad del agente' }).click();
  const feed = card.locator('.activity-feed.full');
  await expect(feed.locator('.act-stage')).toHaveCount(4);
  // The forbidden command in the implementation, then the verifier's tests.
  await expect(feed.locator('.act-tool.tool-bash .act-detail')).toHaveText(['rm -rf /tmp/e2e-basura', 'npm test']);
  await expect(feed.locator('.act-blocked')).toContainText('Bloqueado por seguridad: Bash');
  await expect(feed.locator('.act-end')).toHaveCount(4);
  expect(errors).toEqual([]);
});

test('@ in the message box calls any agent, ECC ones included, as a single-stage task', async ({ page }) => {
  const errors = trackErrors(page);
  await openProject(page);
  await page.locator('#chat-input').fill('@code-rev');
  const suggestion = page.locator('#skill-suggest .skill-suggest-item', { hasText: '@ecc-code-reviewer' });
  await expect(suggestion).toBeVisible();
  await expect(suggestion).toContainText('ECC');
  await suggestion.click();
  await expect(page.locator('#chat-kind-select')).toHaveValue('custom:ecc-code-reviewer');
  await expect(page.locator('#chat-input')).toHaveValue('');
  await page.locator('#chat-input').fill('Revisar el módulo de pagos');
  await page.locator('#chat-input').press('Enter');
  const task = page.locator('.task-card', { hasText: 'Revisar el módulo de pagos' });
  await expect(task).toHaveClass(/ready/, { timeout: 20_000 });
  await expect(task.locator('.pipeline-step small')).toHaveText(['code-reviewer (ECC) · sonnet']);
  // Turned on by calling it: it now has its place in the mode selector.
  await expect(page.locator('#chat-kind-select optgroup[label="Agentes de ECC"] option')).toContainText([
    'code-reviewer (ECC)'
  ]);
  await page.locator('#chat-kind-select').selectOption('chat');
  expect(errors).toEqual([]);
});

test('a task removed from the board goes to the archive, which keeps it for the chosen time', async ({
  page,
  request
}) => {
  const headers = { 'X-Faradia-Token': 'e2e-token' };
  const created = await (
    await request.post('/api/tasks', {
      headers,
      data: { title: 'Tarea para el archivo', type: 'audit', instruction: 'Revisa algo' }
    })
  ).json();
  await expect
    .poll(
      async () =>
        (await (await request.get('/api/tasks', { headers })).json()).find((t) => t.id === created.id)?.status,
      {
        timeout: 20_000
      }
    )
    .toBe('ready_to_test');
  expect((await request.delete(`/api/tasks/${created.id}`, { headers })).ok()).toBeTruthy();

  await page.goto('/?token=e2e-token');
  await page.getByRole('button', { name: 'Archivo', exact: true }).click();
  const sheet = page.locator('.archive-sheet');
  await expect(sheet).toContainText('Tarea para el archivo');
  await expect(sheet.locator('.archive-outcome').first()).toHaveText('Informe');
  await sheet.locator('summary', { hasText: 'Tarea para el archivo' }).click();
  await expect(sheet).toContainText('Revisa algo');
  await sheet.locator('#archive-retention').selectOption('7');
  await expect
    .poll(async () => (await (await request.get('/api/tasks-archive', { headers })).json()).retentionDays)
    .toBe(7);
  await sheet.getByRole('button', { name: 'Listo' }).click();
  await expect(sheet).toHaveCount(0);
});
