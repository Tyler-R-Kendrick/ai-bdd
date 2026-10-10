import { test } from '@playwright/test';
import { registerAiBddScenarios } from '@ai-bdd/playwright-test';

// Plans are committed JSON (`ai-bdd compile`), read synchronously while Playwright collects tests.
// The environment variables let the repository's own tests point this example at a temporary project;
// in your project, `registerAiBddScenarios({ test })` is all you need.
const env = process.env;
const list = (value: string | undefined): string[] => (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);

registerAiBddScenarios({
  test,
  configPath: env.AI_BDD_CONFIG,
  planDir: env.AI_BDD_PLAN_DIR,
  filter: { selectors: list(env.AI_BDD_SELECTORS), tags: list(env.AI_BDD_TAGS), grep: env.AI_BDD_GREP ?? '' },
  failOnHealed: env.AI_BDD_FAIL_ON_HEALED === '1',
});
