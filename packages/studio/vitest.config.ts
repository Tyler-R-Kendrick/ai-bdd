import { defineConfig } from 'vitest/config';
export default defineConfig({
  resolve: { conditions: ['source', 'node'] },
  test: {
    include: ['tests/**/*.test.ts', 'verification/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'forks',
    maxWorkers: 2,
    fileParallelism: false,
    env: { DO_NOT_TRACK: '1', SCARF_NO_ANALYTICS: 'true' },
  },
});
