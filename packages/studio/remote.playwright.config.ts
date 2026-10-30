import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';
export default defineConfig({
  ...base,
  testMatch: '**/remote-agent-ui.spec.ts',
  webServer: undefined,
  outputDir: '/tmp/studio-remote-playwright-results',
  reporter: [['list']],
  use: { ...base.use, baseURL: 'http://127.0.0.1:8896' },
});
