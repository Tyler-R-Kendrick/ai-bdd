// @ts-nocheck
import { AiBddError, type ChatModel, type ModelPurpose, type ModelSet, type Usage } from '../contracts/index.ts';

export const PURPOSES: readonly ModelPurpose[] = ['extract', 'act', 'checkgen', 'judge'];

export const zeroUsage = (): Usage => ({ modelCalls: 0, inputTokens: 0, outputTokens: 0 });

export function addUsage(a: Usage, b: Usage): Usage {
  return { modelCalls: a.modelCalls + b.modelCalls, inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
}

export function subUsage(a: Usage, b: Usage): Usage {
  return { modelCalls: a.modelCalls - b.modelCalls, inputTokens: a.inputTokens - b.inputTokens, outputTokens: a.outputTokens - b.outputTokens };
}

export interface MeterSnapshot {
  byPurpose: Record<ModelPurpose, Usage>;
  /** Number of model calls that failed with MODEL_UNAVAILABLE. */
  unavailable: number;
  costUsd: number;
}

export interface UsageDelta {
  total: Usage;
  byPurpose: Record<ModelPurpose, Usage>;
  unavailable: number;
  costUsd: number;
}

export interface UsageMeter {
  /** The decorated model set: every `generate` call is counted per purpose. */
  readonly models: ModelSet;
  snapshot(): MeterSnapshot;
  /** Usage accumulated since `since`. */
  since(since: MeterSnapshot): UsageDelta;
  readonly pricesConfigured: boolean;
}

const emptyByPurpose = (): Record<ModelPurpose, Usage> => ({ extract: zeroUsage(), act: zeroUsage(), checkgen: zeroUsage(), judge: zeroUsage() });

/** A model that refuses to run: used when `config.models` is absent, so replay-only runs still work. */
function missingModel(purpose: ModelPurpose): ChatModel {
  return {
    id: `unconfigured:${purpose}`,
    generate: () => Promise.reject(new AiBddError('CONFIG_INVALID', `No model configured for purpose "${purpose}" (set "models" in the ai-bdd config)`)),
  };
}

/** Wrap a ModelSet with a usage-counting decorator per purpose. Never mutates the inputs. */
export function createUsageMeter(
  models: ModelSet | undefined,
  prices: Record<string, { inputPerMTok: number; outputPerMTok: number }>,
): UsageMeter {
  const byPurpose = emptyByPurpose();
  let unavailable = 0;
  let costUsd = 0;

  const wrap = (purpose: ModelPurpose, inner: ChatModel): ChatModel => ({
    id: inner.id,
    async generate(req) {
      const u = byPurpose[purpose];
      u.modelCalls += 1;
      try {
        const res = await inner.generate(req);
        u.inputTokens += res.usage.inputTokens;
        u.outputTokens += res.usage.outputTokens;
        const price = prices[res.modelId] ?? prices[inner.id];
        if (price !== undefined) costUsd += (res.usage.inputTokens / 1e6) * price.inputPerMTok + (res.usage.outputTokens / 1e6) * price.outputPerMTok;
        return res;
      } catch (err) {
        if (err instanceof AiBddError && err.code === 'MODEL_UNAVAILABLE') unavailable += 1;
        throw err;
      }
    },
  });

  const decorated: ModelSet = {
    extract: wrap('extract', models?.extract ?? missingModel('extract')),
    act: wrap('act', models?.act ?? missingModel('act')),
    checkgen: wrap('checkgen', models?.checkgen ?? missingModel('checkgen')),
    judge: wrap('judge', models?.judge ?? missingModel('judge')),
  };

  const snapshot = (): MeterSnapshot => ({
    byPurpose: { extract: { ...byPurpose.extract }, act: { ...byPurpose.act }, checkgen: { ...byPurpose.checkgen }, judge: { ...byPurpose.judge } },
    unavailable,
    costUsd,
  });

  return {
    models: decorated,
    snapshot,
    since(since) {
      const now = snapshot();
      const delta = emptyByPurpose();
      let total = zeroUsage();
      for (const p of PURPOSES) {
        delta[p] = subUsage(now.byPurpose[p], since.byPurpose[p]);
        total = addUsage(total, delta[p]);
      }
      return { total, byPurpose: delta, unavailable: now.unavailable - since.unavailable, costUsd: now.costUsd - since.costUsd };
    },
    pricesConfigured: Object.keys(prices).length > 0,
  };
}
