import { raceAbort } from '../util/index.ts';
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

/**
 * A token count a model reported, as the run report can hold it (a non-negative integer). A custom model can return anything, so
 * a count that is not a finite number of 0 or more is refused with MODEL_OUTPUT_INVALID, and a fractional one is rounded up.
 */
function tokenCount(purpose: ModelPurpose, modelId: string, field: 'inputTokens' | 'outputTokens', value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new AiBddError('MODEL_OUTPUT_INVALID', `the ${purpose} model "${modelId}" reported ${field} = ${String(value)}; a token count is a finite number of 0 or more`, {
      details: { purpose, field, value: String(value) },
    });
  }
  return Math.ceil(value);
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
        // A model call that never returns must not outlive an abort (adapters honor `signal`; custom models may not).
        const raw = await raceAbort(inner.generate(req), req.signal, `${purpose} model call`);
        // The counts reach the run report through this meter and through the callers' own step usage: both get the checked ones.
        const usage = {
          inputTokens: tokenCount(purpose, inner.id, 'inputTokens', (raw.usage as Partial<typeof raw.usage> | undefined)?.inputTokens),
          outputTokens: tokenCount(purpose, inner.id, 'outputTokens', (raw.usage as Partial<typeof raw.usage> | undefined)?.outputTokens),
        };
        const res = { ...raw, usage };
        u.inputTokens += usage.inputTokens;
        u.outputTokens += usage.outputTokens;
        const price = prices[res.modelId] ?? prices[inner.id];
        if (price !== undefined) costUsd += (usage.inputTokens / 1e6) * price.inputPerMTok + (usage.outputTokens / 1e6) * price.outputPerMTok;
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
