import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';
export default defineConfig({
  ...base,
  webServer: undefined,
  testMatch: 'findings-ui.spec.ts',
  retries: 0,
  reporter: 'list',
  outputDir: '../../work/findings-browser-output',
});
