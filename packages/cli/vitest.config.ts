import { defineConfig } from 'vitest/config';
import { alias } from '../../vitest.alias';

export default defineConfig({
  resolve: { alias },
  test: { name: 'cli', environment: 'node', include: ['test/**/*.test.ts'], testTimeout: 120_000 },
});
