import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: 'midi-editor.spec.ts',
  timeout: 90000,
  expect: { timeout: 15000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:8898',
    viewport: { width: 1536, height: 1100 },
    headless: true,
    launchOptions: {
      executablePath: '/usr/bin/chromium',
      args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
    },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    cwd: resolve(import.meta.dirname, '..'),
    command: 'node dist/server/main.js',
    url: 'http://127.0.0.1:8898/api/health',
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      NODE_ENV: 'test',
      STUDIO_DEMO: '1',
      STUDIO_PORT: '8898',
      STUDIO_ORIGIN: 'http://127.0.0.1:8898',
      STUDIO_DATA_DIR: resolve('../../work/e2e/midi-data'),
    },
  },
});
