import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from '@ai-bdd/contracts';

/** On-disk embedding cache: `<sha256(modelId+text)>.f32`, little-endian Float32. */
export interface EmbeddingCache {
  readonly dir: string;
  pathFor(modelId: string, text: string): string;
  get(modelId: string, text: string): Float32Array | null;
  put(modelId: string, text: string, vector: Float32Array): void;
}

function encode(vector: Float32Array): Buffer {
  const buffer = Buffer.allocUnsafe(vector.length * 4);
  for (let index = 0; index < vector.length; index += 1) buffer.writeFloatLE(vector[index] ?? 0, index * 4);
  return buffer;
}

function decode(buffer: Buffer): Float32Array {
  const length = Math.floor(buffer.length / 4);
  const vector = new Float32Array(length);
  for (let index = 0; index < length; index += 1) vector[index] = buffer.readFloatLE(index * 4);
  return vector;
}

let tempCounter = 0;

/** Create a cache rooted at `dir`. Files are named sha256(modelId + text).f32. */
export function createEmbeddingCache(dir: string): EmbeddingCache {
  const cache: EmbeddingCache = {
    dir,
    pathFor(modelId: string, text: string): string {
      return join(dir, `${sha256Hex(modelId + text)}.f32`);
    },
    get(modelId: string, text: string): Float32Array | null {
      try {
        return decode(readFileSync(cache.pathFor(modelId, text)));
      } catch {
        return null;
      }
    },
    put(modelId: string, text: string, vector: Float32Array): void {
      mkdirSync(dir, { recursive: true });
      const target = cache.pathFor(modelId, text);
      const temp = `${target}.${process.pid}.${tempCounter}.tmp`;
      tempCounter += 1;
      writeFileSync(temp, encode(vector));
      try {
        renameSync(temp, target);
      } catch (error) {
        try {
          unlinkSync(temp);
        } catch {
          // ignore: the temp file is best-effort cleanup only
        }
        throw error;
      }
    },
  };
  return cache;
}

/** L2-normalize a vector; a zero vector normalizes to all zeros. */
export function l2Normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum);
  const out = new Float32Array(vector.length);
  if (norm === 0) return out;
  for (let index = 0; index < vector.length; index += 1) out[index] = (vector[index] ?? 0) / norm;
  return out;
}

/** Cosine similarity of two L2-normalized vectors equals their dot product. */
export function dot(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length);
  let sum = 0;
  for (let index = 0; index < length; index += 1) sum += (a[index] ?? 0) * (b[index] ?? 0);
  return sum;
}
