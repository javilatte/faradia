'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { e2eTmp, trackErrors, openProject } = require('./helpers');

const project = () => path.join(e2eTmp(), 'repos', 'demo');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

function ghCalls() {
  const file = path.join(e2eTmp(), 'gh-calls.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function readyTask(page, title) {
  await page.locator('#chat-kind-select').selectOption('coding');
  await page.locator('#chat-input').fill(title);
  await page.locator('#chat-input').press('Enter');
  const card = page.locator('.task-card', { hasText: title });
  await expect(card).toHaveClass(/ready/, { timeout: 30_000 });
  return card;
}

test('without a remote, a committed task is merged locally', async ({ page }) => {
  const errors = trackErrors(page);
  await openProject(page);
  const card = await readyTask(page, 'Tarea sin remoto');
  await card.getByRole('button', { name: 'Commit', exact: true }).click();
  await expect(card).toContainText('Este repo no tiene remoto');
  await expect(card.getByRole('button', { name: 'Fusionar en main' })).toBeVisible();
  await expect(card.getByRole('tab', { name: 'Pull request' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('with a GitHub remote: PR and Jira descriptions are drafted by the agent and the PR is opened with gh', async ({
  page
}) => {
  const errors = trackErrors(page);
  // A GitHub-looking origin whose pushes land in a local bare repo.
  const bare = path.join(e2eTmp(), 'origin.git');
  git(e2eTmp(), 'init', '-q', '--bare', '-b', 'main', bare);
  git(project(), 'remote', 'add', 'origin', 'https://github.com/acme/demo.git');
  git(project(), 'config', `url.${bare}.insteadOf`, 'https://github.com/acme/demo.git');
  git(project(), 'push', '-q', 'origin', 'main');
  try {
    await openProject(page);
    const card = await readyTask(page, 'Tarea con PR');
    // Before the commit the PR can already be drafted; creating it waits for the commit.
    await expect(card.getByRole('tab', { name: 'Pull request' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Crear PR' })).toBeDisabled();
    await expect(card).toContainText('se crea después del commit');
    await card.getByRole('button', { name: 'Commit', exact: true }).click();
    await expect(card.getByRole('tab', { name: 'Pull request' })).toHaveAttribute('aria-selected', 'true');
    // With a remote the PR is the main way out; merging locally (no PR, no push) stays possible.
    await expect(card.getByRole('button', { name: 'Fusionar en main' })).not.toHaveClass(/primary/);
    await expect(card.getByRole('button', { name: 'Dejar en su rama' })).toBeVisible();

    // PR: title and description from the describe stage (the notes steer what to leave out).
    await card.getByLabel('Indicaciones para la descripción').fill('no menciones la migración');
    await card.getByRole('button', { name: 'Redactar con IA' }).click();
    await expect(card.getByLabel('Título de la PR')).toHaveValue('feat: cambio simulado', { timeout: 15_000 });
    await expect(card.getByLabel('Descripción de la PR')).toHaveValue(/## Cambios/);
    await expect(card.locator('.pipeline-step strong').last()).toHaveText('Descripción');

    // Jira: its own text; the PR draft stays.
    await card.getByRole('tab', { name: 'Jira' }).click();
    await card.getByRole('button', { name: 'Redactar con IA' }).click();
    await expect(card.getByLabel('Comentario para Jira')).toHaveValue(/Comentario para Jira simulado/, {
      timeout: 15_000
    });
    await card.getByRole('tab', { name: 'Pull request' }).click();
    await card.getByLabel('Título de la PR').fill('feat: título editado');

    await card.getByRole('button', { name: 'Crear PR' }).click();
    await expect(card.getByRole('button', { name: 'Ver PR' })).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText('PR abierta');

    const branch = /Rama: (\S+)/.exec(await card.innerText())[1];
    expect(git(bare, 'branch', '--list', branch)).toContain(branch);
    const create = ghCalls().find((c) => c.args[0] === 'pr' && c.args[1] === 'create');
    expect(create.args).toEqual(expect.arrayContaining(['--base', 'main', '--title', 'feat: título editado']));
    expect(create.input).toContain('## Cambios');
    expect(errors).toEqual([]);
  } finally {
    git(project(), 'remote', 'remove', 'origin');
  }
});
