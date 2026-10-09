import type { KindClass, KindSource } from '@ai-bdd/contracts';

/**
 * Map the fine-grained `kindSource` to the dialect-independent kind class used
 * in the lock key (R-K7). `prefix` and `default` are both inferences.
 */
export function kindClassOf(kindSource: KindSource): KindClass {
  switch (kindSource) {
    case 'directive':
      return 'directive';
    case 'keyword':
      return 'explicit-keyword';
    case 'binding':
      return 'declared-binding';
    case 'prefix':
    case 'default':
      return 'inferred';
    default:
      return 'inferred';
  }
}
