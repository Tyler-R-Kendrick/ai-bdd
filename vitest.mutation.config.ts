import { defineConfig } from 'vitest/config';
import base from './vitest.config.ts';

/**
 * The tests Stryker runs against a mutation target (see scripts/mutation.mjs). `MUTATION_TESTS` is a comma separated list of test
 * files or globs; only those are collected, which keeps every mutant's run short. The base configuration's projects are not used
 * (they would bring their own `include` and run every unit test for every mutant); only its module aliases are.
 */
const include = (process.env['MUTATION_TESTS'] ?? 'packages/*/test/**/*.test.ts').split(',').map((s) => s.trim());

export default defineConfig({
  resolve: base.resolve,
  test: {
    include,
    testTimeout: 120_000,
    hookTimeout: 60_000,
    coverage: { enabled: false },
  },
});
