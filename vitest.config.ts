import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** Per-package floors (percent). Measured on the unit suite; see scripts/coverage-report.mjs for the current table. */
const floor = (lines: number, branches: number, functions: number) => ({ lines, branches, functions });
const COVERAGE_FLOORS = {
  'packages/sdk/src/**': floor(98, 90, 98),
  'packages/cli/src/**': floor(99, 98, 99),
  'packages/driver-cua/src/**': floor(99, 95, 93),
  'packages/driver-playwright/src/**': floor(98, 90, 84),
  'packages/models-ai-sdk/src/**': floor(99, 99, 99),
  'packages/playwright-test/src/**': floor(99, 99, 99),
  'packages/testing/src/**': floor(99, 91, 99),
  'packages/verify/src/**': floor(95, 85, 95),
};

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@ai-bdd\/sdk\/contracts$/, replacement: r('./packages/sdk/src/contracts/index.ts') },
      { find: /^@ai-bdd\/sdk$/, replacement: r('./packages/sdk/src/index.ts') },
      { find: /^@ai-bdd\/testing$/, replacement: r('./packages/testing/src/index.ts') },
      { find: /^@ai-bdd\/verify$/, replacement: r('./packages/verify/src/index.ts') },
      { find: /^@ai-bdd\/driver-cua$/, replacement: r('./packages/driver-cua/src/index.ts') },
      { find: /^@ai-bdd\/driver-playwright$/, replacement: r('./packages/driver-playwright/src/index.ts') },
      { find: /^@ai-bdd\/models-ai-sdk$/, replacement: r('./packages/models-ai-sdk/src/index.ts') },
      { find: /^@ai-bdd\/playwright-test$/, replacement: r('./packages/playwright-test/src/index.ts') },
    ],
  },
  test: {
    // `pnpm coverage` (unit tests, V8). Thresholds are floors per package: raise them when coverage rises, never lower them.
    // packages/cli/src/bin.ts is a five-line entry shim that only subprocess tests execute.
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.d.ts', 'packages/cli/src/bin.ts'],
      reporter: ['text-summary', 'json-summary', 'json', 'lcov'],
      reportsDirectory: 'coverage',
      reportOnFailure: true,
      thresholds: COVERAGE_FLOORS,
    },
    projects: [
      { extends: true, test: { name: 'unit', include: ['packages/*/test/**/*.test.ts'] } },
      { extends: true, test: { name: 'acceptance', include: ['tests/acceptance/**/*.test.ts'], testTimeout: 180_000, hookTimeout: 60_000 } },
      { extends: true, test: { name: 'adversarial', include: ['tests/adversarial/**/*.test.ts'], testTimeout: 180_000 } },
      // Property-based and fuzz tests (fast-check). FC_RUNS raises the number of cases; a failing seed is printed and replayable with FC_SEED.
      { extends: true, test: { name: 'fuzz', include: ['tests/fuzz/**/*.test.ts'], testTimeout: 300_000 } },
      // Fault injection: crashing drivers, failing models, hostile file systems, killed processes.
      { extends: true, test: { name: 'chaos', include: ['tests/chaos/**/*.test.ts'], testTimeout: 180_000, hookTimeout: 60_000 } },
    ],
  },
});
