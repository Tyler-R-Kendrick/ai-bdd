import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { unifiedDiff } from '@ai-bdd/verify';
import { cpuMs, hostileString, params } from './helpers.ts';

/**
 * unifiedDiff(verified, received) prints `-` lines (only in `verified`), `+` lines (only in `received`) and ` ` context lines.
 * It has no line numbers: `...` stands for an unknown number of skipped unchanged lines, and the first and last hunks may be
 * preceded or followed by skipped lines. The patch helper below applies such a patch to `verified` and returns every `received`
 * it could mean; the diff is correct when `received` is among them.
 */

const BIG = 1_000_000;

/** Patch with no elisions: applying it is deterministic. */
function applyFull(patch: string[], a: string[]): { before: string[]; after: string[] } {
  const before: string[] = [];
  const after: string[] = [];
  for (const l of patch) {
    const op = l[0];
    const text = l.slice(1);
    if (op === ' ') {
      before.push(text);
      after.push(text);
    } else if (op === '-') before.push(text);
    else if (op === '+') after.push(text);
    else throw new Error(`unexpected patch line ${JSON.stringify(l)}`);
  }
  void a;
  return { before, after };
}

/** All `received` texts a patch with elisions can describe when applied to `a` (bounded search). */
function applyElided(patch: string[], a: string[]): string[][] {
  const results: string[][] = [];
  let budget = 20_000;
  const run = (pi: number, ai: number, out: string[], needAnchor: boolean): void => {
    if (budget-- <= 0) return;
    if (pi === patch.length) {
      // the remainder of `a` after the last hunk is unchanged
      results.push([...out, ...a.slice(ai)]);
      return;
    }
    const line = patch[pi] as string;
    if (line === '...') {
      // skip k unchanged lines, then the next hunk must continue there
      for (let k = 0; ai + k <= a.length; k += 1) run(pi + 1, ai + k, [...out, ...a.slice(ai, ai + k)], false);
      return;
    }
    if (needAnchor) {
      // the first hunk may start anywhere
      for (let start = 0; start <= a.length; start += 1) run(pi, start, [...a.slice(0, start)], false);
      return;
    }
    const op = line[0];
    const text = line.slice(1);
    if (op === '+') run(pi + 1, ai, [...out, text], false);
    else if ((op === ' ' || op === '-') && a[ai] === text) run(pi + 1, ai + 1, op === ' ' ? [...out, text] : out, false);
  };
  run(0, 0, [], true);
  return results;
}

function lcsLength(a: string[], b: string[]): number {
  const t = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i += 1) for (let j = 1; j <= b.length; j += 1) t[i]![j] = a[i - 1] === b[j - 1] ? t[i - 1]![j - 1]! + 1 : Math.max(t[i - 1]![j]!, t[i]![j - 1]!);
  return t[a.length]![b.length]!;
}

// ───────────────────────── generators

// A small alphabet makes repeated lines (and therefore ambiguous alignments) common.
const lineArb = fc.oneof({ weight: 6, arbitrary: fc.constantFrom('a', 'b', 'c', 'd', '', ' ', '-x', '+y', '...', '  ...', ' a') }, { weight: 1, arbitrary: hostileString({ maxLength: 20 }).map((s) => s.replace(/[\r\n]/g, '')) });
const linesArb = fc.array(lineArb, { maxLength: 12 });
const pair = fc.tuple(linesArb, fc.array(fc.tuple(fc.nat(), fc.constantFrom('del', 'ins', 'sub'), lineArb), { maxLength: 4 })).map(([a, edits]) => {
  const b = [...a];
  for (const [at, kind, line] of edits) {
    const i = b.length === 0 ? 0 : at % (b.length + 1);
    if (kind === 'ins') b.splice(i, 0, line);
    else if (kind === 'del') b.splice(i, 1);
    else if (i < b.length) b[i] = line;
  }
  return { a, b };
});
const join = (l: string[]): string => l.join('\n');

describe('fuzz: unifiedDiff', () => {
  it('a full diff (context large enough to show every line) splits exactly into the old and the new text', () => {
    fc.assert(
      fc.property(fc.oneof(pair, fc.tuple(linesArb, linesArb).map(([a, b]) => ({ a, b }))), ({ a, b }) => {
        const diff = unifiedDiff(join(a), join(b), { context: BIG, maxLines: BIG });
        if (join(a) === join(b)) {
          expect(diff).toBe('');
          return;
        }
        // text is compared through split('\n'): an empty text is one empty line
        const { before, after } = applyFull(diff.split('\n'), a);
        expect(before).toEqual(join(a).split('\n'));
        expect(after).toEqual(join(b).split('\n'));
      }),
      params({ scale: 2 }),
    );
  });

  it('is minimal: it removes and adds exactly the lines outside a longest common subsequence', () => {
    fc.assert(
      fc.property(pair, ({ a, b }) => {
        fc.pre(join(a) !== join(b));
        const lines = unifiedDiff(join(a), join(b), { context: 0, maxLines: BIG }).split('\n').filter((l) => l !== '...');
        const removed = lines.filter((l) => l.startsWith('-')).length;
        const added = lines.filter((l) => l.startsWith('+')).length;
        const lcs = lcsLength(a.length === 0 ? [''] : a, b.length === 0 ? [''] : b);
        // join/split turns [] into [''], so compare on the split representation
        const as = join(a).split('\n');
        const bs = join(b).split('\n');
        expect(removed).toBe(as.length - lcsLength(as, bs));
        expect(added).toBe(bs.length - lcsLength(as, bs));
        void lcs;
      }),
      params({ scale: 2 }),
    );
  });

  it('with any amount of context, applying the diff to the old text gives the new text (among the patches it can mean)', () => {
    fc.assert(
      fc.property(pair, fc.integer({ min: 0, max: 4 }), ({ a, b }, context) => {
        fc.pre(join(a) !== join(b));
        const as = join(a).split('\n');
        const bs = join(b).split('\n');
        const patch = unifiedDiff(join(a), join(b), { context, maxLines: BIG }).split('\n');
        const candidates = applyElided(patch, as);
        expect(candidates.some((c) => c.length === bs.length && c.every((l, i) => l === bs[i])), `patch ${JSON.stringify(patch)} on ${JSON.stringify(as)} -> ${JSON.stringify(bs)}`).toBe(true);
        // every candidate also reproduces the new lines that the patch shows
        for (const c of candidates) {
          const shown = patch.filter((l) => l[0] === '+' || l[0] === ' ').map((l) => l.slice(1));
          let at = 0;
          for (const l of c) if (l === shown[at]) at += 1;
          expect(at).toBe(shown.length);
        }
      }),
      params({ scale: 2 }),
    );
  });

  it('an empty diff means equal texts, and nothing else', () => {
    fc.assert(
      fc.property(pair, ({ a, b }) => {
        const diff = unifiedDiff(join(a), join(b));
        expect(diff === '').toBe(join(a) === join(b));
        expect(unifiedDiff(join(a), join(a))).toBe('');
      }),
      params(),
    );
  });

  it('truncation never drops the first lines and says how many it dropped; diffs of huge inputs stay cheap and do not throw', () => {
    fc.assert(
      fc.property(pair, fc.integer({ min: 1, max: 6 }), ({ a, b }, maxLines) => {
        fc.pre(join(a) !== join(b));
        const full = unifiedDiff(join(a), join(b), { context: 3, maxLines: BIG }).split('\n');
        const cut = unifiedDiff(join(a), join(b), { context: 3, maxLines }).split('\n');
        if (full.length <= maxLines) expect(cut).toEqual(full);
        else {
          expect(cut.slice(0, maxLines)).toEqual(full.slice(0, maxLines));
          expect(cut[maxLines]).toBe(`... ${full.length - maxLines} more diff line(s)`);
          expect(cut).toHaveLength(maxLines + 1);
        }
      }),
      params(),
    );
    const big = (n: number, tweak: number): string => Array.from({ length: n }, (_, i) => (i === tweak ? 'changed' : `line ${i}`)).join('\n');
    for (const n of [2000, 20_000]) {
      const used = cpuMs(() => {
        const d = unifiedDiff(big(n, 5), big(n, 7));
        // beyond 1500 lines the report is the first difference only
        expect(d).toContain('... 5 identical line(s), then the files differ');
        expect(d).toContain('-changed');
        expect(d).toContain('+line 5');
      });
      expect(used).toBeLessThan(5000);
    }
  });
});
