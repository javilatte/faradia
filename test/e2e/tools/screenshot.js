'use strict';

// Development tool: starts Faradia as in the e2e tests and saves screenshots.
//   node test/e2e/tools/screenshot.js <output-dir> [route#view ...]
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('@playwright/test');

(async () => {
  const out = process.argv[2] || '.';
  const routes = process.argv.slice(3).length ? process.argv.slice(3) : ['/'];
  const server = spawn('node', [path.join(__dirname, '..', 'serve.js')], {
    env: { ...process.env, E2E_PORT: '47399' },
    stdio: 'ignore'
  });
  await new Promise((r) => setTimeout(r, 1500));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1360, height: 820 } });
  await page.goto('http://127.0.0.1:47399/?token=e2e-token');
  for (const [i, route] of routes.entries()) {
    await page.goto(`http://127.0.0.1:47399${route}`);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(out, `shot-${i}.png`) });
  }
  await browser.close();
  server.kill();
})();
