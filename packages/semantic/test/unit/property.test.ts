import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalJson, toJsonValue, type BindingDescriptor, type Resolution } from '@ai-bdd/contracts';
import { createSemanticResolver } from '../../src/index.js';
import { createExactEmbedder, createExtractorModel } from '../helpers/fakes.js';
import { bindingSetOf, desc } from '../helpers/sets.js';

const STEP = 'alpha beta gamma';

function unit(cos: number): number[] {
  return [cos, Math.sqrt(Math.max(0, 1 - cos * cos))];
}

const DESCRIPTORS: BindingDescriptor[] = [
  desc({ id: 'a', pattern: 'binding a text', kind: 'action' }),
  desc({ id: 'b', pattern: 'binding b text', kind: 'action' }),
  desc({ id: 'c', pattern: 'binding c text', kind: 'action' }),
  desc({ id: 'd', pattern: 'binding d text', kind: 'any' }),
];

async function resolveWith(descriptors: BindingDescriptor[]): Promise<Resolution | null> {
  const resolver = createSemanticResolver({
    embedder: createExactEmbedder({
      [STEP]: [1, 0],
      'binding a text': unit(0.95),
      'binding b text': unit(0.5),
      'binding c text': unit(0.3),
      'binding d text': unit(0.1),
    }),
    extractor: createExtractorModel({}),
    config: { threshold: 0.85, margin: 0.1, embedCacheDir: mkdtempSync(join(tmpdir(), 'semantic-prop-')) },
  });
  return resolver.resolve({ text: STEP, kind: 'action' }, bindingSetOf(descriptors));
}

describe('order independence (R-K5a-e)', () => {
  it('shuffling the binding order never changes the semantic result', async () => {
    const expected = canonicalJson(toJsonValue(await resolveWith(DESCRIPTORS)));
    await fc.assert(
      fc.asyncProperty(
        fc.shuffledSubarray(DESCRIPTORS, { minLength: DESCRIPTORS.length, maxLength: DESCRIPTORS.length }),
        async (shuffled) => {
          const result = await resolveWith(shuffled);
          expect(canonicalJson(toJsonValue(result))).toBe(expected);
        },
      ),
      { numRuns: 40 },
    );
  });

  it('the binding set hash is independent of binding order', () => {
    const forward = bindingSetOf(DESCRIPTORS).hash;
    const backward = bindingSetOf([...DESCRIPTORS].reverse()).hash;
    expect(forward).toBe(backward);
  });
});
