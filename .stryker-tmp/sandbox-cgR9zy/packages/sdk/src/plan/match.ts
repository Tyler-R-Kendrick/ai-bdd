// @ts-nocheck
import { normalizeForQuote } from '../util/index.ts';

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'as', 'is', 'are', 'was', 'were',
  'be', 'been', 'being', 'it', 'its', 'this', 'that', 'these', 'those', 'then', 'than', 'so', 'if', 'when', 'given', 'user', 'they',
  'their', 'he', 'she', 'his', 'her', 'can', 'will', 'should', 'must', 'may', 'has', 'have', 'had', 'do', 'does', 'not', 'no',
]);

/** Lowercased word tokens with stopwords removed. */
export function tokenize(...texts: string[]): Set<string> {
  const out = new Set<string>();
  for (const text of texts) {
    for (const m of normalizeForQuote(text).matchAll(/[\p{L}\p{N}]+/gu)) {
      const t = m[0];
      if (!STOPWORDS.has(t)) out.add(t);
    }
  }
  return out;
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

export interface Matchable {
  fingerprint: string;
  /** `normalizeForQuote(title)` */
  titleNorm: string;
  tokens: ReadonlySet<string>;
}

export const JACCARD_THRESHOLD = 0.6;

/**
 * Greedy reconciliation of drafts against previous items (§8.4 step 4).
 * Priority: equal fingerprint, then equal normalized title, then token Jaccard >= 0.6 (highest first, ties by previous order, then draft order).
 * Returns draftIndex -> prevIndex. Pure and order-deterministic.
 */
export function reconcile(drafts: readonly Matchable[], prevs: readonly Matchable[]): Map<number, number> {
  const result = new Map<number, number>();
  const used = new Set<number>();
  const pass = (key: (m: Matchable) => string): void => {
    for (let d = 0; d < drafts.length; d += 1) {
      if (result.has(d)) continue;
      const dk = key(drafts[d] as Matchable);
      for (let p = 0; p < prevs.length; p += 1) {
        if (used.has(p) || key(prevs[p] as Matchable) !== dk) continue;
        result.set(d, p);
        used.add(p);
        break;
      }
    }
  };
  pass((m) => m.fingerprint);
  pass((m) => m.titleNorm);
  const pairs: { d: number; p: number; sim: number }[] = [];
  for (let d = 0; d < drafts.length; d += 1) {
    if (result.has(d)) continue;
    for (let p = 0; p < prevs.length; p += 1) {
      if (used.has(p)) continue;
      const sim = jaccard((drafts[d] as Matchable).tokens, (prevs[p] as Matchable).tokens);
      if (sim >= JACCARD_THRESHOLD) pairs.push({ d, p, sim });
    }
  }
  pairs.sort((x, y) => y.sim - x.sim || x.p - y.p || x.d - y.d);
  for (const { d, p } of pairs) {
    if (result.has(d) || used.has(p)) continue;
    result.set(d, p);
    used.add(p);
  }
  return result;
}
