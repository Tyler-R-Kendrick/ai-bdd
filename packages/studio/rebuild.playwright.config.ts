import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';
export default defineConfig({
  ...base,
  testMatch: '**/rebuild-ui.spec.ts',
  webServer: [],
  workers: 1,
  retries: 0,
  timeout: 60000,
  reporter: [['list']],
});
