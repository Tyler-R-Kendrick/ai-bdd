/** A small, dependency-free seeded PRNG (xmur3 string hash into sfc32). Same seed, same sequence, on every platform. */
export interface SeededRandom {
  /** The seed as given (numbers are stringified), so a failure can print it and a rerun can replay it. */
  readonly seed: string;
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [0, maxExclusive). Returns 0 for a non-positive bound. */
  int(maxExclusive: number): number;
  /** Uniform integer in [min, max] (both inclusive). */
  range(min: number, max: number): number;
  /** True with probability `p` (clamped to [0, 1]). Always consumes one draw, so the sequence does not depend on `p`. */
  chance(p: number): boolean;
  /** A uniformly chosen element. Throws on an empty list. */
  pick<T>(items: readonly T[]): T;
  /** A new array in Fisher-Yates order; the input is not modified. */
  shuffle<T>(items: readonly T[]): T[];
  /** An independent generator derived from this seed and `label`; drawing from it never moves this generator. */
  fork(label: string): SeededRandom;
}

function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i += 1) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

function sfc32(a: number, b: number, c: number, d: number): () => number {
  return () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

export function seededRandom(seed: number | string): SeededRandom {
  const text = String(seed);
  const hash = xmur3(`ai-bdd-chaos:${text}`);
  const raw = sfc32(hash(), hash(), hash(), hash());
  for (let i = 0; i < 12; i += 1) raw(); // warm up: short seeds otherwise correlate in the first draws
  const rng: SeededRandom = {
    seed: text,
    next: raw,
    int(maxExclusive) {
      return maxExclusive > 0 ? Math.floor(raw() * Math.floor(maxExclusive)) : 0;
    },
    range(min, max) {
      return min + rng.int(max - min + 1);
    },
    chance(p) {
      const draw = raw();
      return draw < Math.min(1, Math.max(0, p));
    },
    pick(items) {
      if (items.length === 0) throw new RangeError('seededRandom.pick: empty list');
      return items[rng.int(items.length)] as (typeof items)[number];
    },
    shuffle(items) {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = rng.int(i + 1);
        [out[i], out[j]] = [out[j] as (typeof out)[number], out[i] as (typeof out)[number]];
      }
      return out;
    },
    fork(label) {
      return seededRandom(`${text}/${label}`);
    },
  };
  return rng;
}
