import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@ai-bdd/contracts';
import { createEmbeddingCache, dot, l2Normalize } from '../../src/index.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'semantic-cache-'));
}

describe('embedding cache', () => {
  it('stores sha256(modelId+text).f32 and round-trips little-endian Float32', () => {
    const dir = tempDir();
    const cache = createEmbeddingCache(dir);
    const vector = l2Normalize(new Float32Array([3, 4]));
    cache.put('model-1', 'hello', vector);

    const expected = join(dir, `${sha256Hex('model-1hello')}.f32`);
    expect(cache.pathFor('model-1', 'hello')).toBe(expected);
    expect(readFileSync(expected).length).toBe(8);

    const loaded = cache.get('model-1', 'hello');
    expect(loaded).not.toBeNull();
    expect(Array.from(loaded as Float32Array)).toEqual(Array.from(vector));
  });

  it('returns null for a missing entry', () => {
    expect(createEmbeddingCache(tempDir()).get('model', 'absent')).toBeNull();
  });
});

describe('vector math', () => {
  it('l2-normalizes and keeps zero vectors zero', () => {
    expect(Array.from(l2Normalize(new Float32Array([0, 5])))).toEqual([0, 1]);
    expect(Array.from(l2Normalize(new Float32Array([0, 0])))).toEqual([0, 0]);
  });

  it('cosine of normalized vectors is the dot product', () => {
    const a = l2Normalize(new Float32Array([1, 0]));
    const b = l2Normalize(new Float32Array([1, 1]));
    expect(dot(a, b)).toBeCloseTo(Math.SQRT1_2, 6);
  });
});
