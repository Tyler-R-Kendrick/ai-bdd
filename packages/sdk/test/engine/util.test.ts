import { describe, expect, it } from 'vitest';
import { AiBddError } from '../../src/contracts/index.ts';
import { cmp, errorMessage, globToRegExp, mapPool, matchesAnyGlob, throwIfAborted } from '../../src/engine/util.ts';

describe('globToRegExp', () => {
  it('translates a single star to "anything except a slash"', () => {
    const re = globToRegExp('src/*.ts');
    expect(re.test('src/a.ts')).toBe(true);
    expect(re.test('src/.ts')).toBe(true);
    expect(re.test('src/a/b.ts')).toBe(false);
    expect(re.test('src/a.tsx')).toBe(false);
    expect(re.test('xsrc/a.ts')).toBe(false);
  });

  it('"**/" matches zero or more whole directory segments', () => {
    const re = globToRegExp('src/**/x.ts');
    expect(re.test('src/x.ts')).toBe(true);
    expect(re.test('src/a/x.ts')).toBe(true);
    expect(re.test('src/a/b/c/x.ts')).toBe(true);
    expect(re.test('srcx.ts')).toBe(false);
    expect(re.test('src/ax.ts')).toBe(false);
  });

  it('a leading "**/" also matches a file at the top level', () => {
    const re = globToRegExp('**/*.md');
    expect(re.test('a.md')).toBe(true);
    expect(re.test('docs/deep/a.md')).toBe(true);
    expect(re.test('docs/a.txt')).toBe(false);
  });

  it('a trailing "**" matches everything below, slashes included', () => {
    const re = globToRegExp('docs/**');
    expect(re.test('docs/a')).toBe(true);
    expect(re.test('docs/a/b/c.md')).toBe(true);
    expect(re.test('doc/a')).toBe(false);
  });

  it('"**" in the middle of a segment is not slash-anchored', () => {
    const re = globToRegExp('a**b');
    expect(re.test('ab')).toBe(true);
    expect(re.test('a/x/b')).toBe(true);
    expect(re.test('a/x/c')).toBe(false);
  });

  it('"?" matches exactly one non-slash character', () => {
    const re = globToRegExp('a?c');
    expect(re.test('abc')).toBe(true);
    expect(re.test('ac')).toBe(false);
    expect(re.test('abbc')).toBe(false);
    expect(re.test('a/c')).toBe(false);
  });

  it('braces are alternation and comma separates the alternatives', () => {
    const re = globToRegExp('x.{ts,tsx}');
    expect(re.test('x.ts')).toBe(true);
    expect(re.test('x.tsx')).toBe(true);
    expect(re.test('x.js')).toBe(false);
    expect(re.test('x.t')).toBe(false);
  });

  it('nested braces nest the alternation', () => {
    const re = globToRegExp('{a,b{1,2}}.md');
    expect(['a.md', 'b1.md', 'b2.md'].every((p) => re.test(p))).toBe(true);
    expect(re.test('b.md')).toBe(false);
    expect(re.test('b12.md')).toBe(false);
  });

  it('a comma outside braces and an unmatched closing brace are literal', () => {
    const comma = globToRegExp('a,b');
    expect(comma.test('a,b')).toBe(true);
    expect(comma.test('a')).toBe(false);
    const close = globToRegExp('a}b');
    expect(close.test('a}b')).toBe(true);
    expect(close.test('ab')).toBe(false);
  });

  it('regex metacharacters in the glob are matched literally', () => {
    const re = globToRegExp('a.b+c(d)[e]^$|\\f');
    expect(re.test('a.b+c(d)[e]^$|\\f')).toBe(true);
    expect(re.test('aXb+c(d)[e]^$|\\f')).toBe(false);
    expect(globToRegExp('a.md').test('aXmd')).toBe(false);
  });

  it('is anchored at both ends', () => {
    const re = globToRegExp('a.md');
    expect(re.test('a.md')).toBe(true);
    expect(re.test('xa.md')).toBe(false);
    expect(re.test('a.mdx')).toBe(false);
    expect(re.source.startsWith('^')).toBe(true);
    expect(re.source.endsWith('$')).toBe(true);
  });
});

describe('matchesAnyGlob', () => {
  it('is false for an empty glob list', () => {
    expect(matchesAnyGlob([], 'a.md')).toBe(false);
  });

  it('matches when any one glob matches', () => {
    expect(matchesAnyGlob(['docs/*.md', 'src/**/*.ts'], 'src/a/b.ts')).toBe(true);
    expect(matchesAnyGlob(['docs/*.md', 'src/**/*.ts'], 'src/a/b.js')).toBe(false);
  });

  it('an identical string matches without glob translation (even when it holds glob syntax)', () => {
    expect(matchesAnyGlob(['weird/{name}.md'], 'weird/{name}.md')).toBe(true);
    expect(matchesAnyGlob(['./kept.md'], './kept.md')).toBe(true);
  });

  it('strips one leading "./" from a glob before translating it', () => {
    expect(matchesAnyGlob(['./docs/*.md'], 'docs/a.md')).toBe(true);
    expect(matchesAnyGlob(['./docs/*.md'], './docs/a.md')).toBe(false);
  });
});

describe('cmp', () => {
  it('orders by UTF-16 code unit, not by locale', () => {
    expect(cmp('a', 'b')).toBe(-1);
    expect(cmp('b', 'a')).toBe(1);
    expect(cmp('a', 'a')).toBe(0);
    expect(cmp('Z', 'a')).toBe(-1);
    expect(cmp('a', 'Z')).toBe(1);
    expect(cmp('z', 'é')).toBe(-1);
    expect(['b', 'B', 'a', 'A'].sort(cmp)).toEqual(['A', 'B', 'a', 'b']);
  });
});

describe('throwIfAborted', () => {
  it('does nothing without a signal or with a live one', () => {
    expect(() => throwIfAborted(undefined)).not.toThrow();
    expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();
  });

  it('throws ABORTED once the signal has aborted', () => {
    const ac = new AbortController();
    ac.abort();
    let caught: unknown;
    try {
      throwIfAborted(ac.signal);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AiBddError);
    expect((caught as AiBddError).code).toBe('ABORTED');
    expect((caught as AiBddError).message).toBe('aborted');
  });
});

describe('errorMessage', () => {
  it('uses the message of an Error and the string form of anything else', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage(new TypeError('bad type'))).toBe('bad type');
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage(null)).toBe('null');
    expect(errorMessage({ message: 'not an Error instance' })).toBe('[object Object]');
  });
});

/** A promise settled from the outside, so a test controls the order in which pool tasks finish. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('mapPool', () => {
  it('returns an empty list for no items without calling the function', async () => {
    let calls = 0;
    expect(await mapPool([], 4, async () => ++calls)).toEqual([]);
    expect(calls).toBe(0);
  });

  it('results keep input order even when tasks finish out of order, and the index is passed', async () => {
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    const run = mapPool(['a', 'b', 'c'], 3, async (item, i) => {
      await (gates[i] as ReturnType<typeof deferred<void>>).promise;
      return `${item}${i}`;
    });
    gates[2]?.resolve();
    await tick();
    gates[0]?.resolve();
    gates[1]?.resolve();
    expect(await run).toEqual(['a0', 'b1', 'c2']);
  });

  it('never runs more than `limit` calls at once and runs every item exactly once', async () => {
    let active = 0;
    let peak = 0;
    const seen: number[] = [];
    const out = await mapPool([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 3, async (n) => {
      active++;
      peak = Math.max(peak, active);
      seen.push(n);
      await tick();
      active--;
      return n * 2;
    });
    expect(peak).toBe(3);
    expect(seen.slice().sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(out).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);
  });

  it('starts only as many workers as there are items when the limit is larger', async () => {
    let active = 0;
    let peak = 0;
    await mapPool([1, 2], 50, async () => {
      active++;
      peak = Math.max(peak, active);
      await tick();
      active--;
    });
    expect(peak).toBe(2);
  });

  it('a limit below one still makes progress, serially', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapPool([1, 2, 3], 0, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await tick();
      active--;
      return n;
    });
    expect(peak).toBe(1);
    expect(out).toEqual([1, 2, 3]);
  });

  it('after a failure no new item is started and the original error is rethrown', async () => {
    const started: number[] = [];
    const boom = new Error('boom at 1');
    await expect(
      mapPool([0, 1, 2, 3, 4], 1, async (n) => {
        started.push(n);
        if (n === 1) throw boom;
        return n;
      }),
    ).rejects.toBe(boom);
    expect(started).toEqual([0, 1]);
  });

  it('with several concurrent workers, items already in flight finish but nothing new starts', async () => {
    const started: number[] = [];
    const finished: number[] = [];
    const gate = deferred<void>();
    const run = mapPool([0, 1, 2, 3, 4, 5], 2, async (n) => {
      started.push(n);
      if (n === 1) throw new Error('fail 1');
      await gate.promise;
      finished.push(n);
      return n;
    });
    const settled = run.catch((e: unknown) => e);
    await tick();
    gate.resolve();
    expect(((await settled) as Error).message).toBe('fail 1');
    expect(started).toEqual([0, 1]);
    expect(finished).toEqual([0]);
  });

  it('when several tasks fail, the first failure in time wins', async () => {
    const g0 = deferred<void>();
    const g1 = deferred<void>();
    const run = mapPool([0, 1], 2, async (n) => {
      await (n === 0 ? g0 : g1).promise;
      throw new Error(`fail ${n}`);
    });
    const settled = run.catch((e: unknown) => e);
    g1.resolve();
    await tick();
    g0.resolve();
    expect(((await settled) as Error).message).toBe('fail 1');
  });

  it('a non-Error rejection is rethrown as-is', async () => {
    await expect(mapPool([1], 1, () => Promise.reject('just a string'))).rejects.toBe('just a string');
  });
});
