import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: 'account-planner.browser.ts',
  workers: 1,
  timeout: 30000,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:8906',
    viewport: { width: 1100, height: 800 },
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
    cwd: resolve(import.meta.dirname, '..'),
    command:
      'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 8906 --strictPort',
    url: 'http://127.0.0.1:8906/tests/fixtures/account-planner.html',
    reuseExistingServer: false,
    timeout: 60000,
  },
});
