import { describe, expect, it } from 'vitest';
import { JACCARD_THRESHOLD, jaccard, reconcile, tokenize, type Matchable } from '../../src/plan/match.ts';

const STOPWORDS = [
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'as', 'is', 'are', 'was', 'were',
  'be', 'been', 'being', 'it', 'its', 'this', 'that', 'these', 'those', 'then', 'than', 'so', 'if', 'when', 'given', 'user', 'they',
  'their', 'he', 'she', 'his', 'her', 'can', 'will', 'should', 'must', 'may', 'has', 'have', 'had', 'do', 'does', 'not', 'no',
];

function m(fingerprint: string, titleNorm: string, tokens: readonly string[]): Matchable {
  return { fingerprint, titleNorm, tokens: new Set(tokens) };
}

/** `n` distinct tokens `prefix0..prefix(n-1)`. */
function toks(prefix: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`);
}

function pairsOf(map: Map<number, number>): [number, number][] {
  return [...map.entries()].sort((x, y) => x[0] - y[0]);
}

describe('tokenize', () => {
  it('drops every stopword, one at a time', () => {
    expect(STOPWORDS).toHaveLength(54);
    for (const w of STOPWORDS) {
      expect([...tokenize(w)], w).toEqual([]);
      expect([...tokenize(w.toUpperCase())], w).toEqual([]);
      expect([...tokenize(`${w} zebra`)], w).toEqual(['zebra']);
    }
  });

  it('keeps words that merely contain or resemble a stopword', () => {
    expect([...tokenize('theme android another items')]).toEqual(['theme', 'android', 'another', 'items']);
  });

  it('splits on everything that is not a letter or digit and lowercases', () => {
    expect([...tokenize('Abc 123, def! ghi-jkl_mno (x9)')]).toEqual(['abc', '123', 'def', 'ghi', 'jkl', 'mno', 'x9']);
  });

  it('treats digits and non-latin letters as word characters', () => {
    expect([...tokenize('Привет мир 42 日本語')]).toEqual(['привет', 'мир', '42', '日本語']);
  });

  it('does not produce empty or punctuation-only tokens', () => {
    expect([...tokenize('  ,.;  --  ')]).toEqual([]);
    expect([...tokenize('')]).toEqual([]);
  });

  it('unions the tokens of several texts, once each', () => {
    expect([...tokenize('red fish', 'blue fish', 'the')]).toEqual(['red', 'fish', 'blue']);
  });

  it('normalizes typographic quotes before splitting', () => {
    expect([...tokenize('it’s Bob’s')]).toEqual(['s', 'bob']);
  });
});

describe('jaccard', () => {
  it('is 0 for two empty sets (not NaN)', () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
  });

  it('is 0 when one side is empty', () => {
    expect(jaccard(new Set(['a']), new Set())).toBe(0);
    expect(jaccard(new Set(), new Set(['a']))).toBe(0);
  });

  it('is intersection over union', () => {
    expect(jaccard(new Set(['a', 'b', 'c']), new Set(['a', 'b', 'c', 'd', 'e']))).toBe(0.6);
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3, 12);
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0);
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(1);
  });
});

describe('reconcile', () => {
  it('has a threshold of 0.6', () => {
    expect(JACCARD_THRESHOLD).toBe(0.6);
  });

  it('returns an empty map for no drafts or no previous items', () => {
    expect(reconcile([], [m('x', 'x', ['a'])]).size).toBe(0);
    expect(reconcile([m('x', 'x', ['a'])], []).size).toBe(0);
  });

  it('matches equal fingerprints even when titles and tokens differ', () => {
    const r = reconcile([m('fp', 'one', ['a'])], [m('other', 'other', ['z']), m('fp', 'two', ['b'])]);
    expect(pairsOf(r)).toEqual([[0, 1]]);
  });

  it('matches by fingerprint at every position', () => {
    const drafts = [m('f0', 't0', ['a']), m('f1', 't1', ['b']), m('f2', 't2', ['c'])];
    const prevs = [m('f2', 'u2', ['x']), m('f0', 'u0', ['y']), m('f1', 'u1', ['z'])];
    expect(pairsOf(reconcile(drafts, prevs))).toEqual([[0, 1], [1, 2], [2, 0]]);
  });

  it('uses each previous item at most once for equal fingerprints (first draft wins)', () => {
    const r = reconcile([m('fp', 'a', ['a']), m('fp', 'b', ['b'])], [m('fp', 'c', ['c'])]);
    expect(pairsOf(r)).toEqual([[0, 0]]);
  });

  it('pairs duplicate fingerprints in order', () => {
    const r = reconcile([m('fp', 'a', ['a']), m('fp', 'b', ['b'])], [m('fp', 'c', ['c']), m('fp', 'd', ['d'])]);
    expect(pairsOf(r)).toEqual([[0, 0], [1, 1]]);
  });

  it('matches equal normalized titles when fingerprints differ', () => {
    const r = reconcile([m('f1', 'same title', ['a'])], [m('f2', 'other', ['z']), m('f3', 'same title', ['b'])]);
    expect(pairsOf(r)).toEqual([[0, 1]]);
  });

  it('uses each previous item at most once for equal titles', () => {
    const r = reconcile([m('f1', 't', ['a']), m('f2', 't', ['b'])], [m('f3', 't', ['c'])]);
    expect(pairsOf(r)).toEqual([[0, 0]]);
  });

  it('does not let the title pass re-match a draft that the fingerprint pass already matched', () => {
    const r = reconcile([m('fp', 't', ['a'])], [m('fp', 'x', ['b']), m('other', 't', ['c'])]);
    expect(pairsOf(r)).toEqual([[0, 0]]);
  });

  it('does not let a previous item matched by fingerprint be taken again by title', () => {
    const r = reconcile([m('fp', 'zzz', ['a']), m('f2', 't', ['b'])], [m('fp', 't', ['c'])]);
    expect(pairsOf(r)).toEqual([[0, 0]]);
  });

  it('prefers fingerprint over title: a title twin does not steal the fingerprint partner', () => {
    const r = reconcile([m('fp', 't', ['a'])], [m('zz', 't', ['b']), m('fp', 'other', ['c'])]);
    expect(pairsOf(r)).toEqual([[0, 1]]);
  });

  it('matches by Jaccard exactly at the threshold (3/5 = 0.6)', () => {
    const r = reconcile([m('f1', 'a', ['a', 'b', 'c'])], [m('f2', 'b', ['a', 'b', 'c', 'd', 'e'])]);
    expect(pairsOf(r)).toEqual([[0, 0]]);
  });

  it('does not match just below the threshold (5/9)', () => {
    const r = reconcile([m('f1', 'a', toks('t', 5))], [m('f2', 'b', [...toks('t', 5), ...toks('u', 4)])]);
    expect(r.size).toBe(0);
  });

  it('does not match disjoint or empty token sets', () => {
    expect(reconcile([m('f1', 'a', ['a'])], [m('f2', 'b', ['b'])]).size).toBe(0);
    expect(reconcile([m('f1', 'a', [])], [m('f2', 'b', [])]).size).toBe(0);
  });

  it('Jaccard matching prefers the highest similarity, wherever it appears', () => {
    const d = [m('d', 'd', toks('t', 5))];
    const at06 = m('p0', 'p0', toks('t', 3)); // 3/5 = 0.6
    const at1 = m('p1', 'p1', toks('t', 5)); // 1
    expect(pairsOf(reconcile(d, [at06, at1]))).toEqual([[0, 1]]);
    expect(pairsOf(reconcile(d, [at1, at06]))).toEqual([[0, 0]]);
  });

  it('on equal similarity the earlier previous item wins', () => {
    const d = [m('d', 'd', toks('t', 3))];
    const p = [m('p0', 'p0', toks('t', 3)), m('p1', 'p1', toks('t', 3))];
    expect(pairsOf(reconcile(d, p))).toEqual([[0, 0]]);
  });

  it('on equal similarity and previous item the earlier draft wins', () => {
    const d = [m('d0', 'd0', toks('t', 3)), m('d1', 'd1', toks('t', 3))];
    const p = [m('p0', 'p0', toks('t', 3))];
    expect(pairsOf(reconcile(d, p))).toEqual([[0, 0]]);
  });

  it('similarity outranks previous order, previous order outranks draft order', () => {
    const t = toks('t', 5);
    const d = [m('d0', 'd0', t), m('d1', 'd1', t.slice(0, 3))];
    const p = [m('p0', 'p0', t.slice(0, 3)), m('p1', 'p1', t)];
    // pairs: (d0,p0)=0.6 (d0,p1)=1 (d1,p0)=1 (d1,p1)=0.6 -> both 1.0 pairs are disjoint, both are taken.
    expect(pairsOf(reconcile(d, p))).toEqual([[0, 1], [1, 0]]);
  });

  it('an item taken by a higher-similarity pair is not reused by a lower one', () => {
    const t = toks('t', 5);
    const d = [m('d0', 'd0', t), m('d1', 'd1', t.slice(0, 3))];
    const p = [m('p0', 'p0', t), m('p1', 'p1', t.slice(0, 3))];
    expect(pairsOf(reconcile(d, p))).toEqual([[0, 0], [1, 1]]);
  });

  it('one draft with two candidate previous items takes only the best one', () => {
    const t = toks('t', 5);
    const d = [m('d0', 'd0', t)];
    const p = [m('p0', 'p0', t.slice(0, 4)), m('p1', 'p1', t)];
    const r = reconcile(d, p);
    expect(pairsOf(r)).toEqual([[0, 1]]);
    expect(r.size).toBe(1);
  });

  it('a lower-similarity draft cannot take a previous item already used by the best pair', () => {
    const t = toks('t', 5);
    const d = [m('d0', 'd0', t.slice(0, 3)), m('d1', 'd1', t)];
    const p = [m('p0', 'p0', t)];
    // (d0,p0)=0.6, (d1,p0)=1 -> d1 takes p0, d0 stays unmatched.
    expect(pairsOf(reconcile(d, p))).toEqual([[1, 0]]);
  });

  it('Jaccard only considers drafts and previous items left over by the exact passes', () => {
    const t = toks('t', 3);
    const d = [m('fp', 'x', t), m('d1', 'd1', t)];
    const p = [m('fp', 'y', toks('z', 3)), m('p1', 'p1', t)];
    expect(pairsOf(reconcile(d, p))).toEqual([[0, 0], [1, 1]]);
  });

  it('a previous item matched by title is excluded from Jaccard matching', () => {
    const t = toks('t', 3);
    const d = [m('d0', 'title', toks('z', 3)), m('d1', 'd1', t)];
    const p = [m('p0', 'title', t)];
    expect(pairsOf(reconcile(d, p))).toEqual([[0, 0]]);
  });
});
