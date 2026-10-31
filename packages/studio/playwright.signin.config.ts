import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';

// This lane checks the shipped sign-in screen and its navigation boundary only.
// OAuth identities and sessions are exercised by the separate server/flow tests.
export default defineConfig({
  ...base,
  testMatch: '**/github-login.spec.ts',
  use: { ...base.use, baseURL: 'http://127.0.0.1:8896' },
  webServer: {
    command:
      'node node_modules/vite/bin/vite.js --config vite.signin.config.ts --host 127.0.0.1 --port 8896 --strictPort',
    url: 'http://127.0.0.1:8896',
    reuseExistingServer: false,
    timeout: 60000,
  },
});
