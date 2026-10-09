import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts', 'fixtures/*/vitest.config.ts', 'plugins/js/*/vitest.config.ts', 'test/adversarial/vitest.config.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: ['default'],
  },
});
