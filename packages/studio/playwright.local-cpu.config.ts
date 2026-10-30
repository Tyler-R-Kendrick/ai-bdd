import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';
export default defineConfig({
  ...base,
  testMatch: '**/local-cpu-ui.spec.ts',
  webServer: undefined,
  timeout: 90000,
  retries: 0,
  use: { ...base.use, baseURL: 'http://127.0.0.1:8891' },
});
