import { describe, expect, it } from 'vitest';
import { seededRandom } from '@ai-bdd/testing';

const draw = (seed: number | string, n = 8): number[] => {
  const r = seededRandom(seed);
  return Array.from({ length: n }, () => r.next());
};

describe('seededRandom', () => {
  it('is deterministic by seed, and a number and its string spelling are the same seed', () => {
    expect(draw(42)).toEqual(draw(42));
    expect(draw(42)).toEqual(draw('42'));
    expect(draw('abc')).toEqual(draw('abc'));
    expect(seededRandom(42).seed).toBe('42');
  });

  it('different seeds give different sequences, including neighbouring small seeds', () => {
    const firsts = new Set([0, 1, 2, 3, 4, 5, 6, 7].map((s) => draw(s, 1)[0]));
    expect(firsts.size).toBe(8);
    expect(draw(1)).not.toEqual(draw(2));
    expect(draw('a')).not.toEqual(draw('b'));
  });

  it('next() stays in [0, 1) and is roughly uniform', () => {
    const r = seededRandom('uniform');
    const buckets = new Array<number>(10).fill(0);
    for (let i = 0; i < 5000; i += 1) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      buckets[Math.floor(v * 10)] = (buckets[Math.floor(v * 10)] ?? 0) + 1;
    }
    for (const b of buckets) expect(b).toBeGreaterThan(380);
  });

  it('int() is bounded and returns 0 for a non-positive bound; range() is inclusive on both ends', () => {
    const r = seededRandom(7);
    const seen = new Set<number>();
    for (let i = 0; i < 400; i += 1) seen.add(r.int(5));
    expect([...seen].sort()).toEqual([0, 1, 2, 3, 4]);
    expect(r.int(0)).toBe(0);
    expect(r.int(-3)).toBe(0);
    const ranged = new Set<number>();
    for (let i = 0; i < 400; i += 1) ranged.add(r.range(3, 6));
    expect([...ranged].sort()).toEqual([3, 4, 5, 6]);
  });

  it('chance(0) never and chance(1) always hold, and every call consumes exactly one draw', () => {
    const a = seededRandom('c');
    const b = seededRandom('c');
    for (let i = 0; i < 50; i += 1) {
      expect(a.chance(0)).toBe(false);
      expect(a.chance(1)).toBe(true);
      b.next();
      b.next();
    }
    expect(a.next()).toBe(b.next());
    expect(seededRandom(1).chance(-5)).toBe(false);
    expect(seededRandom(1).chance(7)).toBe(true);
  });

  it('pick() chooses from the list and throws on an empty one', () => {
    const r = seededRandom('pick');
    const items = ['a', 'b', 'c'];
    const got = new Set(Array.from({ length: 100 }, () => r.pick(items)));
    expect([...got].sort()).toEqual(['a', 'b', 'c']);
    expect(() => r.pick([])).toThrow(RangeError);
  });

  it('shuffle() returns a permutation, leaves the input alone and is reproducible', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const copy = [...input];
    const out = seededRandom('s').shuffle(input);
    expect(input).toEqual(copy);
    expect([...out].sort((a, b) => a - b)).toEqual(copy);
    expect(seededRandom('s').shuffle(input)).toEqual(out);
    expect(seededRandom('t').shuffle(input)).not.toEqual(out);
    expect(seededRandom('s').shuffle([])).toEqual([]);
    expect(seededRandom('s').shuffle(['only'])).toEqual(['only']);
  });

  it('fork() is deterministic per label, independent of the parent and of sibling forks', () => {
    const parent = seededRandom('root');
    const before = draw('root', 3);
    const f1 = parent.fork('one');
    const f2 = parent.fork('two');
    expect(f1.seed).toBe('root/one');
    const a = [f1.next(), f1.next()];
    const again = seededRandom('root').fork('one');
    expect([again.next(), again.next()]).toEqual(a);
    expect(seededRandom('root').fork('one').fork('x').seed).toBe('root/one/x');
    expect(f2.next()).not.toBe(a[0]);
    expect([parent.next(), parent.next(), parent.next()]).toEqual(before);
  });
});
