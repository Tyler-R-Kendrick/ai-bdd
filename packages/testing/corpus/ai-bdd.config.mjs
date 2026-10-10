// The Acme demo project's REAL config: a Playwright browser driver and AI SDK models, plugged in through the ordinary
// `drivers` / `models` keys. To drive Acme with a different engine (a driver built on Cua Driver, a browser-use driver), swap the
// `web` entry for any package that exports `createDriverFactory(options)`; nothing else changes.
//
//   export AI_GATEWAY_API_KEY=...            # or the key your model provider's AI SDK package reads
//   export ACME_ADMIN_PASSWORD=...           # value of the adminPassword secret
//   ai-bdd compile && ai-bdd run
//
// Tests never edit this file: they generate `ai-bdd.config.test.mjs` with `writeTestConfig` from `@ai-bdd/testing`, which
// extends this config and plugs deterministic test doubles in through the same keys. `.corpus-options.json` (optional,
// written by the test harness) overrides individual settings.
import { readFileSync } from 'node:fs';
import { defineConfig } from '@ai-bdd/sdk';
import { acmeFixtures } from '@ai-bdd/testing';

function readOptions() {
  try {
    return JSON.parse(readFileSync(new URL('./.corpus-options.json', import.meta.url), 'utf8'));
  } catch {
    return {};
  }
}

const { fixtures = true, ...overrides } = readOptions();
const model = process.env.AI_BDD_MODEL ?? 'anthropic/claude-sonnet-5.5';

export default defineConfig({
  docs: ['docs/**/*.md'],
  baseURL: process.env.ACME_URL ?? 'http://localhost:4173',
  fixtures: fixtures ? acmeFixtures : [],
  secrets: { adminPassword: { env: 'ACME_ADMIN_PASSWORD' } },
  context:
    'Acme is a small SaaS web application. Its pages are Billing (plan, invoice preview, upgrade and downgrade), Todos, Checkout (shipping and billing address forms), Login, Release notes and a slow Reports page.',
  drivers: { web: { use: '@ai-bdd/driver-playwright', options: { browser: 'chromium', headless: true } } },
  defaultDriver: 'web',
  models: {
    use: '@ai-bdd/models-ai-sdk',
    options: {
      extract: model,
      act: model,
      checkgen: model,
      judge: process.env.AI_BDD_JUDGE_MODEL ?? model,
    },
  },
  ...overrides,
});
