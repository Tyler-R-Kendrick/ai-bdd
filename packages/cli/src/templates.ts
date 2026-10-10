/** Templates written by `ai-bdd init` (§5.3). Model ids are examples only. */

export const CONFIG_TS_TEMPLATE = `import { defineConfig } from '@ai-bdd/sdk';
import { playwright } from '@ai-bdd/driver-playwright';
import { aiSdkModels } from '@ai-bdd/models-ai-sdk';
import { anthropic } from '@ai-sdk/anthropic';

export default defineConfig({
  docs: ['docs/**/*.md'],
  baseURL: 'http://localhost:3000',
  drivers: { web: playwright({ browser: 'chromium', headless: true }) },
  defaultDriver: 'web',
  models: aiSdkModels({
    extract: anthropic('claude-sonnet-5-5'),
    act: anthropic('claude-sonnet-5-5'),
    checkgen: anthropic('claude-sonnet-5-5'),
    judge: anthropic('claude-opus-5-5'),
  }),
  context: 'Describe your app vocabulary here.',
  secrets: { adminPassword: { env: 'ADMIN_PASSWORD' } },
});
`;

export const CONFIG_JSON_TEMPLATE = `${JSON.stringify(
  {
    docs: ['docs/**/*.md'],
    baseURL: 'http://localhost:3000',
    drivers: {
      web: { use: '@ai-bdd/driver-playwright', options: { browser: 'chromium', headless: true } },
    },
    defaultDriver: 'web',
    models: {
      use: '@ai-bdd/models-ai-sdk',
      options: {
        extract: 'anthropic/claude-sonnet-5.5',
        act: 'anthropic/claude-sonnet-5.5',
        checkgen: 'anthropic/claude-sonnet-5.5',
        judge: 'anthropic/claude-opus-5.5',
      },
    },
    context: 'Describe your app vocabulary here.',
    secrets: { adminPassword: { env: 'ADMIN_PASSWORD' } },
  },
  null,
  2,
)}\n`;

export const EXAMPLE_DOC = `# Example product requirements

This document is a starting point. ai-bdd turns plain markdown like this into
executable acceptance tests: run \`ai-bdd compile\`, review the plan with
\`ai-bdd show\`, then run \`ai-bdd run\`.

## Signing in

A registered user can sign in with an email address and a password. After
signing in, the user sees a greeting that includes their name on the dashboard.

Signing in with a wrong password shows the error message "Invalid credentials"
and keeps the user on the sign-in page.
`;

export const GITIGNORE_ENTRIES = ['.ai-bdd/runs/', '.ai-bdd/cache/'] as const;

export const CONFIG_FILE_NAMES = ['ai-bdd.config.ts', 'ai-bdd.config.mjs', 'ai-bdd.config.js', 'ai-bdd.config.json'] as const;
