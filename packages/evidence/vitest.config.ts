import { defineConfig } from 'vitest/config';
import { alias } from '../../vitest.alias';

export default defineConfig({
  resolve: { alias },
  test: { name: 'evidence', environment: 'node', include: ['test/**/*.test.ts'] },
});
