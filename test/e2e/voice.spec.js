'use strict';

const { test, expect } = require('@playwright/test');
const { trackErrors, openProject } = require('./helpers');

// Chromium's fake microphone plays a beep, so the recording is not silent.
test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }
});

const TOKEN = { 'X-Faradia-Token': 'e2e-token' };

async function setVoice(request, voice) {
  const res = await request.patch('/api/settings', { headers: TOKEN, data: { scope: 'global', voice } });
  expect(res.ok()).toBeTruthy();
}

test.afterEach(async ({ request }) => {
  await setVoice(request, { enabled: true, engine: 'auto', model: 'auto', language: 'es-en' });
});

async function dictate(page, ms = 1200) {
  const mic = page.locator('#voice-button');
  await mic.click();
  await expect(mic).toHaveAttribute('data-state', 'recording');
  await expect(page.locator('#voice-status')).toContainText('Escuchando');
  await page.waitForTimeout(ms);
  await mic.click();
}

test('dictation with Whisper in the browser fills the message box and never sends it', async ({ page, request }) => {
  const errors = trackErrors(page);
  await setVoice(request, { engine: 'browser' });
  // The real worker downloads the model from Hugging Face; this one answers like it, offline.
  await page.route('**/js/project/voice-worker.js', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      // Like the real one: the page is cross-origin isolated (COEP), so a worker without it is blocked.
      headers: { 'Cross-Origin-Embedder-Policy': 'credentialless' },
      body: `self.onmessage = async ({ data }) => {
        self.postMessage({ type: 'progress', id: data.id, model: 'small', loaded: 40, total: 100 });
        await new Promise((r) => setTimeout(r, 400));
        const ok = data.audio instanceof Float32Array && data.audio.length > 8000;
        self.postMessage({ type: 'result', id: data.id, model: 'small', text: ok ? ' [Música]\\n Revisa el ' + data.model + ' en ' + data.languages.join('/') + '. ' : '' });
      };`
    })
  );
  await openProject(page);
  const box = page.locator('#chat-input');
  const sentBefore = await page.locator('#chat-log .msg.user').count();
  await box.fill('Por favor:');
  await dictate(page);
  await expect(page.locator('#voice-status')).toContainText(
    'Descargando el modelo de voz (250 MB, solo la primera vez)… 40 %'
  );
  await expect(box).toHaveValue('Por favor: Revisa el auto en es/en.');
  await expect(page.locator('#voice-button')).toHaveAttribute('data-state', 'idle');
  await expect(page.locator('#voice-status')).toBeHidden();
  await expect(box).toBeFocused();
  await expect(page.locator('#send-button')).toBeEnabled();

  // The second time the model is already in the browser: it is prepared, not downloaded.
  await dictate(page, 800);
  await expect(page.locator('#voice-status')).toContainText('Preparando el modelo de voz… 40 %');
  await expect(box).toHaveValue('Por favor: Revisa el auto en es/en. Revisa el auto en es/en.');
  await expect(page.locator('#chat-log .msg.user')).toHaveCount(sentBefore);
  expect(errors).toEqual([]);
});

test('Esc cancels a dictation without touching the message box', async ({ page, request }) => {
  await setVoice(request, { engine: 'browser' });
  await openProject(page);
  const box = page.locator('#chat-input');
  await box.fill('Sin cambios');
  await page.locator('#voice-button').click();
  await expect(page.locator('#voice-button')).toHaveAttribute('data-state', 'recording');
  await page.keyboard.press('Escape');
  await expect(page.locator('#voice-button')).toHaveAttribute('data-state', 'idle');
  await expect(page.locator('#voice-status')).toBeHidden();
  await expect(box).toHaveValue('Sin cambios');
});

test('Settings › Dictado picks the model and the language, and can hide the button', async ({ page, request }) => {
  const errors = trackErrors(page);
  await page.route('**/js/project/voice-worker.js', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      // Like the real one: the page is cross-origin isolated (COEP), so a worker without it is blocked.
      headers: { 'Cross-Origin-Embedder-Policy': 'credentialless' },
      body: `self.onmessage = ({ data }) => self.postMessage({ type: 'result', id: data.id, text: data.model + ' ' + data.languages });`
    })
  );
  await openProject(page);
  await page.locator('#settings-button').click();
  await page.locator('.settings-nav-item[data-pane="voice"]').click();
  await expect(page.locator('#setting-voice-enabled')).toBeChecked();
  await expect(page.locator('#setting-voice-model')).toHaveValue('auto');
  await expect(page.locator('#setting-voice-language')).toHaveValue('es-en');
  await expect(page.locator('#setting-voice-engine')).toHaveValue('auto');
  await page.locator('#setting-voice-engine').selectOption('browser');
  await page.locator('#setting-voice-model').selectOption('small');
  await expect(page.locator('#settings-save-status')).toHaveText('Guardado para todos los repos');
  await page.locator('#setting-voice-language').selectOption('detect');
  await expect
    .poll(async () => (await (await request.get('/api/settings', { headers: TOKEN })).json()).voice)
    .toEqual({ enabled: true, engine: 'browser', model: 'small', language: 'detect' });

  await page.locator('#setting-voice-enabled').uncheck();
  await expect(page.locator('#setting-voice-model')).toBeHidden();
  await expect(page.locator('#voice-button')).toBeHidden();
  await page.locator('#setting-voice-enabled').check();
  await expect(page.locator('#voice-button')).toBeVisible();
  await page.locator('#settings-close').click();

  await dictate(page, 800);
  await expect(page.locator('#chat-input')).toHaveValue('small null');
  expect(errors).toEqual([]);
});

test("without a GPU in the browser, Faradia's own engine transcribes", async ({ page, request }) => {
  const errors = trackErrors(page);
  // Headless Chromium has no WebGPU: "auto" goes to the engine (a fake transformers.js in the tests).
  await page.route('**/js/project/voice-worker.js', (route) => route.abort());
  await setVoice(request, { engine: 'auto', model: 'auto', language: 'es-en' });
  await openProject(page);
  const box = page.locator('#chat-input');
  await box.fill('');
  await dictate(page, 1000);
  await expect(box).toHaveValue(/^Dictado (es|en) (turbo|small) \d{4,}$/);
  await expect(page.locator('#voice-status')).toBeHidden();
  const status = await (await request.get('/api/voice/status', { headers: TOKEN })).json();
  expect(status).toMatchObject({ installed: true, installing: false, error: null });
  expect(errors).toEqual([]);
});
