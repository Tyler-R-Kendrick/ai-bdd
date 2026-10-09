import { defineConfig } from 'vitest/config';
import { alias } from '../../vitest.alias';

export default defineConfig({
  resolve: { alias },
  test: {
    name: 'cache',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
