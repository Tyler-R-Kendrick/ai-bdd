import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string, file = 'index'): string =>
  fileURLToPath(new URL(`../../../packages/${name}/src/${file}.ts`, import.meta.url));

/** Self-contained aliases: the plugin config must not depend on repo-relative imports. */
const alias: Record<string, string> = {
  '@ai-bdd/models/fake': pkg('models', 'fake'),
  '@ai-bdd/contracts': pkg('contracts'),
  '@ai-bdd/runtime': pkg('runtime'),
  '@ai-bdd/daemon': pkg('daemon'),
  '@ai-bdd/models': pkg('models'),
  '@ai-bdd/driver-fake': pkg('driver-fake'),
  '@ai-bdd/evidence': pkg('evidence'),
  '@ai-bdd/judge': pkg('judge'),
  '@ai-bdd/assert': pkg('assert'),
  '@ai-bdd/act': pkg('act'),
  '@ai-bdd/cache': pkg('cache'),
  '@ai-bdd/lock': pkg('lock'),
  '@ai-bdd/registry': pkg('registry'),
  '@ai-bdd/semantic': pkg('semantic'),
  '@ai-bdd/spec-directives': pkg('spec-directives'),
  '@ai-bdd/spec-gauge': pkg('spec-gauge'),
  '@ai-bdd/spec-gherkin': pkg('spec-gherkin'),
  '@ai-bdd/cucumber': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
};

export default defineConfig({
  resolve: { alias },
  test: { name: 'cucumber-plugin', environment: 'node', include: ['test/**/*.test.ts'], testTimeout: 120_000 },
});
