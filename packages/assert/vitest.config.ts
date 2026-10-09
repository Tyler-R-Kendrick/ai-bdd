import { defineConfig } from 'vitest/config';
import { alias } from '../../vitest.alias';

export default defineConfig({
  resolve: { alias },
  test: { name: 'assert', environment: 'node', include: ['test/**/*.test.ts'] },
});
