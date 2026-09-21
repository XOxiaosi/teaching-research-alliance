import { defineConfig } from '@playwright/test';
if (process.env.ALLIANCE_SYNTHETIC_E2E !== '1') throw new Error('Set ALLIANCE_SYNTHETIC_E2E=1 and use a disposable local dev-demo database.');
const baseURL = process.env.ALLIANCE_WEB_URL ?? 'http://127.0.0.1:5174';
if (!['127.0.0.1','localhost'].includes(new URL(baseURL).hostname)) throw new Error('LOCAL_SYNTHETIC_SERVER_REQUIRED');
export default defineConfig({
  testDir: './e2e', timeout: 90000, workers: 1, fullyParallel: false,
  use: { baseURL, channel: 'chrome', headless: true, viewport: {width:1440,height:1000}, screenshot:'only-on-failure', trace:'retain-on-failure' },
  reporter: [['list']],
});
