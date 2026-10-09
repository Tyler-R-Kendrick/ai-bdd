import type { JudgeVerdict } from '@ai-bdd/contracts';

/** In-memory verdict reuse cache: byte-identical inputs only (R-K19). */
export interface JudgeCache {
  get(key: string): JudgeVerdict | undefined;
  put(key: string, verdict: JudgeVerdict): void;
  size(): number;
}

export function createJudgeCache(): JudgeCache {
  const entries = new Map<string, JudgeVerdict>();
  return {
    get: (key) => entries.get(key),
    put: (key, verdict) => {
      entries.set(key, verdict);
    },
    size: () => entries.size,
  };
}
