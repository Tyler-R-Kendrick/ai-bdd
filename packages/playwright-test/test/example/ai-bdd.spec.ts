import { test } from '@playwright/test';
import { registerAiBddScenarios } from '@ai-bdd/playwright-test';

// Plans are committed JSON (`ai-bdd compile`), read synchronously while Playwright collects tests.
// The environment variables let the repository's own tests point this example at a temporary project;
// in your project, `registerAiBddScenarios({ test })` is all you need.
const list = (value: string | undefined): string[] | undefined =>
  value === undefined || value === '' ? undefined : value.split(',').map((s) => s.trim());

registerAiBddScenarios({
  test,
  configPath: process.env.AI_BDD_CONFIG,
  planDir: process.env.AI_BDD_PLAN_DIR,
  filter: {
    ...(list(process.env.AI_BDD_SELECTORS) === undefined ? {} : { selectors: list(process.env.AI_BDD_SELECTORS) }),
    ...(list(process.env.AI_BDD_TAGS) === undefined ? {} : { tags: list(process.env.AI_BDD_TAGS) }),
    ...(process.env.AI_BDD_GREP === undefined ? {} : { grep: process.env.AI_BDD_GREP }),
  },
  failOnHealed: process.env.AI_BDD_FAIL_ON_HEALED === '1',
});
