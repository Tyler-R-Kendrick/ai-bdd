import { defineConfig } from '@playwright/test';

// The page is only the browser surface: ai-bdd's own config supplies baseURL, policy and models.
export default defineConfig({
  testDir: '.',
  testMatch: 'ai-bdd.spec.ts',
  // A first (characterization) run calls models and runs a confirm run, so allow more than the 30 s default.
  timeout: 180_000,
  fullyParallel: true,
  retries: 0,
  workers: process.env.AI_BDD_PW_WORKERS === undefined ? 2 : Number(process.env.AI_BDD_PW_WORKERS),
  reporter: [
    ['list'],
    ...(process.env.PW_JSON_OUTPUT === undefined ? [] : [['json', { outputFile: process.env.PW_JSON_OUTPUT }] as const]),
  ],
  outputDir: process.env.PW_OUTPUT_DIR ?? 'test-results',
  use: { headless: true },
});
