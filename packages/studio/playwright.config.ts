import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  timeout: 45000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:8877',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    headless: true,
    launchOptions: {
      ...(process.env.STUDIO_CHROMIUM_PATH
        ? { executablePath: process.env.STUDIO_CHROMIUM_PATH }
        : existsSync('/usr/bin/chromium')
          ? { executablePath: '/usr/bin/chromium' }
          : {}),
      args: ['--no-sandbox'],
    },
  },
  webServer: {
    command: 'node dist/server/main.js',
    url: 'http://127.0.0.1:8877/api/health',
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
    env: {
      NODE_ENV: 'test',
      STUDIO_DEMO: '1',
      STUDIO_PORT: '8877',
      STUDIO_ORIGIN: 'http://127.0.0.1:8877',
      STUDIO_DATA_DIR: resolve('../../work/e2e/studio-data'),
    },
  },
});
