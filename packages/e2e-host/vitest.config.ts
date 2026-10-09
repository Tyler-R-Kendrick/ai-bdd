import { defineConfig } from 'vitest/config';
import { alias } from '../../vitest.alias';

export default defineConfig({
  resolve: { alias },
  test: { name: 'e2e-host', environment: 'node', include: ['test/**/*.test.ts'] },
});
