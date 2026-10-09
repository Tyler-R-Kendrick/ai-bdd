import { defineConfig } from 'vitest/config';
import { alias } from '../../vitest.alias';

export default defineConfig({
  resolve: { alias },
  test: { name: 'adversarial', environment: 'node', include: ['*.test.ts'], testTimeout: 180_000 },
});
