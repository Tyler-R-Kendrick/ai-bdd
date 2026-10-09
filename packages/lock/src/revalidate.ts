import { canonicalJson, toJsonValue, type BindingSet, type LockEntry, type Resolution } from '@ai-bdd/contracts';
import type { SemanticResolver } from '@ai-bdd/semantic';

export type RevalidationStatus = 'unchanged' | 'revalidated' | 'changed';

export interface RevalidationResult {
  status: RevalidationStatus;
  entry: LockEntry;
}

function winnerBindingId(resolution: Resolution): string | null {
  switch (resolution.type) {
    case 'exact':
    case 'semantic':
      return resolution.bindingId;
    default:
      return null;
  }
}

/**
 * Compare the resolution *decision* only: winner, guards (captured by the
 * resolution type/reason), threshold and margin. The ranked candidate list is
 * intentionally ignored so that adding an unrelated binding does not count as
 * a change (R-K6).
 */
function sameOutcome(a: Resolution, b: Resolution): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case 'exact':
      return b.type === 'exact' && a.bindingId === b.bindingId && a.bindingHash === b.bindingHash && canonicalJson(toJsonValue(a.params)) === canonicalJson(toJsonValue(b.params));
    case 'semantic':
      return (
        b.type === 'semantic' &&
        a.bindingId === b.bindingId &&
        a.bindingHash === b.bindingHash &&
        a.score === b.score &&
        a.margin === b.margin &&
        canonicalJson(toJsonValue(a.params)) === canonicalJson(toJsonValue(b.params))
      );
    case 'agent':
      return b.type === 'agent' && a.mode === b.mode && a.reason === b.reason;
    case 'ambiguous':
      return b.type === 'ambiguous' && a.reason === b.reason;
    case 'unbound':
      return b.type === 'unbound' && a.reason === b.reason;
    default:
      return false;
  }
}

/**
 * Incremental revalidation (R-K6). When the binding set hash is unchanged the
 * entry is `unchanged`. Otherwise the winner must still exist and the semantic
 * stage must reproduce the same decision; only then is the entry marked
 * `revalidated`, otherwise it is `changed`.
 *
 * The semantic resolver caches embeddings by binding hash, so only new or
 * changed bindings are re-embedded.
 */
export async function revalidate(
  entry: LockEntry,
  set: BindingSet,
  semantic: SemanticResolver,
): Promise<RevalidationResult> {
  if (entry.bindingSetHash === set.hash) return { status: 'unchanged', entry };

  const winnerId = winnerBindingId(entry.resolution);
  if (winnerId !== null && !set.bindings.some((binding) => binding.id === winnerId)) {
    return { status: 'changed', entry };
  }

  const fresh = await semantic.resolve({ text: entry.stepText, kind: entry.kind }, set);
  const next: Resolution =
    fresh ?? { type: 'agent', mode: entry.kind === 'assertion' ? 'assert' : 'act', reason: 'no-match' };

  if (!sameOutcome(entry.resolution, next)) return { status: 'changed', entry };

  return { status: 'revalidated', entry: { ...entry, bindingSetHash: set.hash, revalidated: true } };
}
