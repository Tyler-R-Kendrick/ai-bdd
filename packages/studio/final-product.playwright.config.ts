import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';
/** These full-application tests create their own ephemeral listeners; never reserve/reuse the shared8877 baseline server. */
export default defineConfig({
  ...base,
  testMatch: '**/final-product.spec.ts',
  webServer: [],
  retries: 0,
  reporter: [['list']],
});
