import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';
export default defineConfig({
  ...base,
  testMatch: '**/audio-editor.spec.ts',
  webServer: undefined,
  outputDir:'/tmp/studio-audio-playwright-results',
  use: { ...base.use, baseURL: 'http://127.0.0.1:8891' },
  reporter: [['list']],
});
