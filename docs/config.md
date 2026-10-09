# Configuration

`ai-bdd.config.ts` (TypeScript) or `ai-bdd.config.json` (validated by
`packages/contracts/schemas/config-keys.json` plus the per-key schemas).

```ts
import { defineConfig } from '@ai-bdd/core';
import { playwright } from '@ai-bdd/driver-playwright';
import { cua } from '@ai-bdd/driver-cua';
import { e2e } from '@ai-bdd/driver-e2e';
import { aiSdkModels } from '@ai-bdd/models';
import { gateway } from 'ai';

export default defineConfig({
  specs: ['specs/**/*.spec.md', 'features/**/*.feature'],
  concepts: ['specs/**/*.cpt'],
  bindings: ['bindings/**/*.ts'],
  drivers: {
    web: playwright({ browser: 'chromium', baseURL: 'http://localhost:3000', headless: true }),
    mobile: e2e({ config: './e2e.config.ts', target: 'ios' }),
    desktop: cua({ app: 'com.example.Billing', mode: 'mcp', backgroundOnly: false }),
  },
  defaultDriver: 'web',
  models: aiSdkModels({
    act: gateway('openai/gpt-5-mini'),
    judge: gateway('anthropic/claude-sonnet-4.5'),
    extract: gateway('openai/gpt-5-mini'),
    embed: gateway.textEmbeddingModel('openai/text-embedding-3-small'),
  }),
  context: 'Plans are called tiers. The workspace is the billing account.',
  resolution: { threshold: 0.85, margin: 0.1, allowAgentSetup: false, semantic: { enabled: true, guards: {} } },
  kinds: {},
  assertions: { mode: 'auto', requireDeterministic: false, checkGen: { maxAttempts: 3 } },
  judge: { passThreshold: 0.8, failThreshold: 0.3, samples: 3, maxSpread: 0.5, vision: true, maxTreeChars: 20000 },
  grounding: { threshold: 0.6, margin: 0.1 },
  agent: { maxActions: 20, maxModelCalls: 15 },
  cache: { mode: 'read-write', dir: '.ai-bdd/cache', invalidation: ['effect-verify'] },
  evidence: {
    dir: '.ai-bdd/runs',
    video: 'retain-on-failure',
    requireSettled: true,
    settle: { quietMs: 300, intervalMs: 100, timeoutMs: 5000, pixelTolerance: 0.001 },
    signing: { keyEnv: 'AI_BDD_SIGNING_KEY' },
  },
  secrets: { adminPassword: { env: 'ADMIN_PASSWORD' } },
  policy: { allowHosts: ['localhost', '127.0.0.1'], denyVerbs: [], cua: { allowApps: ['com.example.Billing'] } },
  concurrency: { scenarios: 4 },
  daemon: { host: '127.0.0.1', port: 0 },
  hooks: { visualGate: undefined },
  reporters: ['json', 'junit', 'markdown', 'cucumber-messages'],
  prices: {},
});
```

Model ids in this example are placeholders: nothing in the test suite depends on them.

## JSON configuration

Non-TypeScript users configure the daemon with package references:

```json
{
  "specs": ["specs/**/*.spec.md"],
  "drivers": { "web": { "use": "@ai-bdd/driver-playwright", "options": { "browser": "chromium", "baseURL": "http://localhost:3000" } } },
  "defaultDriver": "web",
  "models": {
    "act": { "use": "@ai-bdd/models/ai-sdk", "options": { "model": "openai/gpt-5-mini" } },
    "judge": { "use": "@ai-bdd/models/ai-sdk", "options": { "model": "anthropic/claude-sonnet-4.5" } },
    "extract": { "use": "@ai-bdd/models/ai-sdk", "options": { "model": "openai/gpt-5-mini" } },
    "embed": { "use": "@ai-bdd/models/ai-sdk", "options": { "model": "openai/text-embedding-3-small" } }
  },
  "reporters": ["json", "markdown"]
}
```

Unknown keys are rejected (`CONFIG_UNKNOWN_KEY`); invalid values are `CONFIG_INVALID`.

## Defaults that change in CI

With `CI=true`:

| Setting | Value |
| --- | --- |
| `cache.mode` | `read-only` |
| lockfile | `--frozen` |
| cache strictness | `--strict-cache` |

## Environment variables

| Variable | Meaning |
| --- | --- |
| `CI` | switches the defaults above |
| `AI_BDD_FAKE` | swaps in the deterministic fake driver and fake models |
| `AI_BDD_SIGNING_KEY` | PKCS8 PEM used to sign the evidence manifest |
| `AI_BDD_LIVE`, `AI_BDD_LIVE_E2E`, `AI_BDD_LIVE_CUA` | opt in to live model / e2e / Cua tests |
| `FC_RUNS` | property-test run count (default 200) |
| `UPDATE_GOLDEN` | rewrite golden files |

## Output

```
.ai-bdd/report.json           the RunReport
.ai-bdd/junit.xml             JUnit XML
.ai-bdd/summary.md            markdown summary (cache + judge stats, cost)
.ai-bdd/messages.ndjson       Cucumber Messages
.ai-bdd/runs/<runId>/         evidence (manifest.jsonl, manifest.json, artifacts/)
.ai-bdd/cache/                act, check, judge, embeddings
.ai-bdd/sessions/*.json       live session ledger
.ai-bdd/calibration/judgments.jsonl
.ai-bdd/daemon.json           daemon URL + token (mode 0600)
ai-bdd.lock.json              committed resolution lockfile
```

## TypeScript configs

`ai-bdd.config.ts` is loaded with a dynamic `import()`; Node 22.18+/24 strips types natively
(`process.features.typescript === 'strip'`, verified in
[the log](verification-log.md#v15--native-typescript-config-loading)). Only erasable TypeScript
syntax is allowed in a config file — no enums, namespaces or parameter properties. On older
runtimes the CLI reports `CONFIG_TS_UNSUPPORTED` and asks for a `.js` or `.json` config.
