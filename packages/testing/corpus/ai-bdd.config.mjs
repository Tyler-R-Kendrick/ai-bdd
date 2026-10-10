// Config used by the acceptance tests (tests/acceptance) and by the README quickstart (`AI_BDD_FAKE=1`).
// Drivers and models are registered by the harness: tests pass them to createEngine, and the CLI's AI_BDD_FAKE=1 mode
// injects the fake driver and fake models. `.corpus-options.json` (optional, written by the test harness) overrides
// individual settings; it exists so spawned CLI processes can be configured without editing this file.
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

export default defineConfig({
  docs: ['docs/**/*.md'],
  baseURL: process.env.ACME_URL ?? 'http://localhost:4173',
  fixtures: fixtures ? acmeFixtures : [],
  secrets: { adminPassword: { env: 'ACME_ADMIN_PASSWORD' } },
  context:
    'Acme is a small SaaS web application. Its pages are Billing (plan, invoice preview, upgrade and downgrade), Todos, Checkout (shipping and billing address forms), Login, Release notes and a slow Reports page.',
  ...overrides,
});
