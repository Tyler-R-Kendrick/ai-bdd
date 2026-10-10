import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@ai-bdd\/sdk\/contracts$/, replacement: r('./packages/sdk/src/contracts/index.ts') },
      { find: /^@ai-bdd\/sdk$/, replacement: r('./packages/sdk/src/index.ts') },
      { find: /^@ai-bdd\/testing$/, replacement: r('./packages/testing/src/index.ts') },
      { find: /^@ai-bdd\/driver-playwright$/, replacement: r('./packages/driver-playwright/src/index.ts') },
      { find: /^@ai-bdd\/models-ai-sdk$/, replacement: r('./packages/models-ai-sdk/src/index.ts') },
      { find: /^@ai-bdd\/playwright-test$/, replacement: r('./packages/playwright-test/src/index.ts') },
    ],
  },
  test: {
    projects: [
      { extends: true, test: { name: 'unit', include: ['packages/*/test/**/*.test.ts'] } },
      { extends: true, test: { name: 'acceptance', include: ['tests/acceptance/**/*.test.ts'], testTimeout: 180_000, hookTimeout: 60_000 } },
      { extends: true, test: { name: 'adversarial', include: ['tests/adversarial/**/*.test.ts'], testTimeout: 180_000 } },
    ],
  },
});
