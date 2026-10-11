import { defineConfig } from 'vitest/config';
import base from './vitest.config.ts';

/**
 * The tests Stryker runs against a mutation target (see scripts/mutation.mjs). `MUTATION_TESTS` is a comma separated list of test
 * files or globs; only those are collected, which keeps every mutant's run short. The base configuration's projects are not used
 * (they would bring their own `include` and run every unit test for every mutant); only its module aliases are.
 */
const include = (process.env['MUTATION_TESTS'] ?? 'packages/*/test/**/*.test.ts').split(',').map((s) => s.trim());

/**
 * Tests that assert on elapsed time (ReDoS and linear-time guards, "finishes within a CPU budget") are left out: a mutant can be
 * legitimately slower or faster, and the machine running hundreds of mutants in parallel is not the machine those budgets were
 * measured on. A mutant that really blows up is still caught: it makes the whole run exceed Stryker's per-mutant timeout.
 */
const TIMING_TESTS = /ReDoS|linear|CPU budget|(?:finish(?:es)?|completes?) in under|stays? fast|terminates quickly|within a CPU/i;

export default defineConfig({
  resolve: base.resolve,
  test: {
    include,
    testNamePattern: new RegExp(`^(?!.*(?:${TIMING_TESTS.source})).*$`, 'i'),
    testTimeout: 120_000,
    hookTimeout: 60_000,
    coverage: { enabled: false },
  },
});
