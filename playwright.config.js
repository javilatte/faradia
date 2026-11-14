'use strict';

const { defineConfig, devices } = require('@playwright/test');

const PORT = 47321;

module.exports = defineConfig({
  testDir: 'test/e2e',
  testMatch: '**/*.spec.js',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure'
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node test/e2e/serve.js',
    // Sin token la API responde 401; la pagina estatica basta para saber que arranco.
    url: `http://127.0.0.1:${PORT}/`,
    env: { E2E_PORT: String(PORT) },
    reuseExistingServer: false,
    timeout: 20_000
  }
});
