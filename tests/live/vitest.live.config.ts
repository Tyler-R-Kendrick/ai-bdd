// Opt-in live-model smoke tests. Not part of `pnpm test` (the root vitest projects do not include tests/live).
//
//   AI_BDD_LIVE=1 AI_GATEWAY_API_KEY=... pnpm exec vitest run -c tests/live/vitest.live.config.ts
//
// Provider credentials: any of AI_GATEWAY_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY (what the AI SDK resolves for the
// model ids). Model ids: AI_BDD_LIVE_MODEL (default anthropic/claude-sonnet-5.5), AI_BDD_LIVE_JUDGE_MODEL (default: same).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@ai-bdd\/sdk\/contracts$/, replacement: r('../../packages/sdk/src/contracts/index.ts') },
      { find: /^@ai-bdd\/sdk$/, replacement: r('../../packages/sdk/src/index.ts') },
      { find: /^@ai-bdd\/testing$/, replacement: r('../../packages/testing/src/index.ts') },
      { find: /^@ai-bdd\/driver-playwright$/, replacement: r('../../packages/driver-playwright/src/index.ts') },
      { find: /^@ai-bdd\/models-ai-sdk$/, replacement: r('../../packages/models-ai-sdk/src/index.ts') },
      { find: /^@ai-bdd\/playwright-test$/, replacement: r('../../packages/playwright-test/src/index.ts') },
    ],
  },
  test: { name: 'live', include: ['tests/live/**/*.test.ts'], root: r('../../'), testTimeout: 600_000, hookTimeout: 60_000 },
});
