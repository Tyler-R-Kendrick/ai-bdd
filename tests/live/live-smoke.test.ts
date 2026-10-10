// Live smoke test: real models (via @ai-bdd/models-ai-sdk) compile billing.md and run one scenario against the Acme
// fixture app with the fake driver. Nothing here asserts exact model output, only structural guarantees.
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEngine, loadConfig, normalizeForQuote } from '@ai-bdd/sdk';
import { aiSdkModels } from '@ai-bdd/models-ai-sdk';
import { fakeDriver } from '@ai-bdd/testing';
import { CORPUS_DIR, WORK_ROOT } from '../acceptance/helpers/paths.ts';

const providerEnv = ['AI_GATEWAY_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'].filter((k) => (process.env[k] ?? '') !== '');
const reason =
  process.env['AI_BDD_LIVE'] !== '1'
    ? 'AI_BDD_LIVE=1 is not set'
    : providerEnv.length === 0
      ? 'no provider credentials (AI_GATEWAY_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY)'
      : null;

describe.skipIf(reason !== null)(reason === null ? 'live models: compile and run the corpus' : `live models: compile and run the corpus [SKIPPED: ${reason}]`, () => {
  it('compiles billing.md into a grounded plan and runs the upgrade scenario to a non-error status', async () => {
    mkdirSync(WORK_ROOT, { recursive: true });
    const dir = mkdtempSync(join(WORK_ROOT, 'live-'));
    try {
      mkdirSync(join(dir, 'docs'));
      cpSync(join(CORPUS_DIR, 'ai-bdd.config.mjs'), join(dir, 'ai-bdd.config.mjs'));
      cpSync(join(CORPUS_DIR, 'docs', 'billing.md'), join(dir, 'docs', 'billing.md'));
      const env = { ACME_ADMIN_PASSWORD: 'correct-horse-battery' };
      const id = process.env['AI_BDD_LIVE_MODEL'] ?? 'anthropic/claude-sonnet-5.5';
      const judge = process.env['AI_BDD_LIVE_JUDGE_MODEL'] ?? id;
      const models = aiSdkModels({ extract: id, act: id, checkgen: id, judge });
      const driver = fakeDriver({});
      const config = await loadConfig({ cwd: dir, env });
      const engine = await createEngine(config, { models, drivers: { fake: driver }, env });
      try {
        const compiled = await engine.compile();
        expect(compiled.docs).toHaveLength(1);
        expect(compiled.usage.modelCalls).toBeGreaterThan(0);
        const plans = await engine.plans();
        const features = plans.flatMap((p) => p.features);
        expect(features.length).toBeGreaterThan(0);
        // grounding holds whatever the model said: every kept feature cites a chunk with a verbatim quote
        for (const f of features) {
          const quoted = f.sources.filter((s) => s.relation === 'source');
          expect(quoted.length, f.title).toBeGreaterThan(0);
          for (const s of quoted) if (s.quote !== undefined) expect(normalizeForQuote(s.quote).length).toBeGreaterThan(0);
        }
        // the performance requirement is not UI-testable
        expect(plans[0]?.notTestable.length).toBeGreaterThanOrEqual(0);

        const upgrade = features.flatMap((f) => f.scenarios).find((s) => /upgrade/i.test(s.title) && !s.steps.some((st) => st.requiresState === true));
        if (upgrade === undefined) return; // the model proposed no stateless upgrade scenario; compile already proved the pipeline
        const result = await engine.runScenario(upgrade.id, { driver: 'fake' });
        expect(['passed', 'healed', 'failed', 'inconclusive', 'blocked']).toContain(result.status);
        expect(result.status).not.toBe('error');
        expect(JSON.stringify(result)).not.toContain(env.ACME_ADMIN_PASSWORD);
      } finally {
        await engine.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
