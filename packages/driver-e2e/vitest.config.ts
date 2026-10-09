import { defineConfig } from 'vitest/config';
import { alias } from '../../vitest.alias';

export default defineConfig({
  resolve: { alias },
  test: { name: 'driver-e2e', environment: 'node', include: ['test/**/*.test.ts'] },
});
