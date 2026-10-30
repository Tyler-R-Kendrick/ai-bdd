import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: 'artifact-lifecycle-ui.spec.ts',
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    ['json', { outputFile: 'work/archive-browser-report.json' }],
  ],
  use: {
    viewport: { width: 1440, height: 1000 },
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      ...(process.env.STUDIO_CHROMIUM_PATH
        ? { executablePath: process.env.STUDIO_CHROMIUM_PATH }
        : {}),
      args: ['--no-sandbox'],
    },
  },
});
