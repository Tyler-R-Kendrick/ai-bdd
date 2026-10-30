import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: 'video-editor.spec.ts',
  timeout: 90000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:8894',
    viewport: { width: 1440, height: 1000 },
    headless: true,
    launchOptions: {
      executablePath: '/usr/bin/chromium',
      args: ['--no-sandbox'],
    },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    cwd: resolve(import.meta.dirname, '..'),
    command: 'node dist/server/main.js',
    url: 'http://127.0.0.1:8894/api/health',
    reuseExistingServer: false,
    timeout: 30000,
    env: {
      NODE_ENV: 'test',
      STUDIO_DEMO: '1',
      STUDIO_PORT: '8894',
      STUDIO_ORIGIN: 'http://127.0.0.1:8894',
      STUDIO_DATA_DIR: resolve('../../work/e2e/video-data'),
    },
  },
});
