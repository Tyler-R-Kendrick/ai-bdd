/**
 * Tests that pin behaviour a mutation run (Stryker) showed to be unprotected: boundaries, fallback texts and details of the
 * file walk. Each one asserts exact values.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VerifyError, durations, findReceived, normalizeText, snapshotFiles, serialize, stableStringify, unifiedDiff, verifiedPathOf, verifyValue } from '../src/index.ts';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-bdd-verify-mut-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const lines = (n: number, prefix = 'l'): string[] => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

describe('unifiedDiff: the size limit', () => {
  const FALLBACK = (k: number): string => ` ... ${k} identical line(s), then the files differ (too large for a full diff) ...`;

  it('exactly 1500 lines on each side still get the full line diff', () => {
    const a = lines(1500);
    const b = [...a];
    b[750] = 'changed';
    expect(unifiedDiff(a.join('\n'), b.join('\n'))).toBe([' l747', ' l748', ' l749', '-l750', '+changed', ' l751', ' l752', ' l753'].join('\n'));
  });

  it('more than 1500 lines on the verified side only falls back to the first difference', () => {
    const big = lines(1501);
    expect(unifiedDiff(['l0', 'l1', 'l2'].join('\n'), big.join('\n'))).toBe([FALLBACK(3), '-', '+l3'].join('\n'));
  });

  it('more than 1500 lines on the received side only falls back to the first difference', () => {
    const big = lines(1501);
    expect(unifiedDiff(big.join('\n'), ['l0', 'l1', 'l2'].join('\n'))).toBe([FALLBACK(3), '-l3', '+'].join('\n'));
  });

  it('a changed line in a very large input is reported with the count of identical lines before it', () => {
    const big = lines(1501);
    const other = [...big];
    other[2] = 'changed';
    expect(unifiedDiff(big.join('\n'), other.join('\n'))).toBe([FALLBACK(2), '-l2', '+changed'].join('\n'));
  });

  // The scan for the first difference stops at the end of the inputs: when it did not, identical inputs made it loop forever.
  it('two identical very large inputs report all lines identical (and finish)', () => {
    const big = lines(1501).join('\n');
    expect(unifiedDiff(big, big)).toBe([FALLBACK(1501), '-', '+'].join('\n'));
  });
});

describe('scrub details', () => {
  it('durations: fractions of any length are one duration', () => {
    expect(durations()('3.55ms')).toBe('{duration}');
    expect(durations()('took 12.125ms')).toBe('took {duration}');
  });

  it('normalizeText: a lone carriage return is a line ending too', () => {
    expect(normalizeText('a\rb')).toBe('a\nb\n');
    expect(normalizeText('a\r\rb\r')).toBe('a\n\nb\n');
  });
});

describe('serialize details', () => {
  const hex = (n: number): string => '00'.repeat(n);

  it('bytes: up to 32 are listed whole, longer ones are cut after 32 with an ellipsis', () => {
    expect(JSON.parse(stableStringify(new Uint8Array(32)))).toBe(`[bytes 32: ${hex(32)}]`);
    expect(JSON.parse(stableStringify(new Uint8Array(31)))).toBe(`[bytes 31: ${hex(31)}]`);
    expect(JSON.parse(stableStringify(new Uint8Array(33)))).toBe(`[bytes 33: ${hex(32)}...]`);
  });

  it('a Map whose keys look alike keeps its insertion order among them', () => {
    const m = new Map<unknown, string>([[{ a: 1 }, 'first'], [{ a: 1 }, 'second'], [{ a: 1 }, 'third']]);
    expect(stableStringify(m)).toBe(JSON.stringify([[{ a: 1 }, 'first'], [{ a: 1 }, 'second'], [{ a: 1 }, 'third']], null, 2));
  });

  it('a Map with several non-string keys is listed in the order of the keys as JSON text', () => {
    const m = new Map<unknown, number>([[3, 1], [1, 2], [2, 3], ['x', 4]]);
    expect(stableStringify(m)).toBe(JSON.stringify([['x', 4], [1, 2], [2, 3], [3, 1]], null, 2));
    expect(serialize(new Map([['b', 1], ['a', 2]])).text).toBe(JSON.stringify({ a: 2, b: 1 }, null, 2));
  });
});

describe('findReceived and verifiedPathOf', () => {
  const touch = (...parts: string[]): string => {
    const file = path.join(dir, ...parts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x');
    return file;
  };

  it.each(['node_modules', 'dist', '.git', 'coverage', '.ai-bdd', '.work'])('does not look inside %s', (skipped) => {
    const kept = touch('src', 'a.received.txt');
    touch(skipped, 'hidden.received.txt');
    touch('src', skipped, 'nested.received.txt');
    expect(findReceived(dir)).toEqual([kept]);
  });

  it('only a file whose last extension follows ".received." counts', () => {
    const kept = touch('a.received.txt');
    touch('a.received.txt.bak');
    touch('b.received.d.txt');
    touch('received.txt');
    touch('c.received.');
    expect(findReceived(dir)).toEqual([kept]);
  });

  it('the result is sorted by path, whatever order the directories are read in', () => {
    const names = ['g/a.received.txt', 'e/z.received.txt', 'e.received.txt', 'd.received.txt', 'c/z.received.txt', 'c.received.txt', 'b/a.received.txt', 'a/z.received.txt', 'a.received.txt', 'f/a.received.txt'];
    for (const n of names) touch(...n.split('/'));
    expect(findReceived(dir)).toEqual(
      ['a.received.txt', 'a/z.received.txt', 'b/a.received.txt', 'c.received.txt', 'c/z.received.txt', 'd.received.txt', 'e.received.txt', 'e/z.received.txt', 'f/a.received.txt', 'g/a.received.txt'].map((n) => path.join(dir, ...n.split('/'))),
    );
  });

  it('a directory that cannot be read is skipped', () => {
    expect(findReceived(path.join(dir, 'missing'))).toEqual([]);
  });

  it('verifiedPathOf changes only the last ".received." segment', () => {
    expect(verifiedPathOf('/p/x.received.d/y.received.txt')).toBe('/p/x.received.d/y.verified.txt');
    expect(verifiedPathOf('/p/a.received.json')).toBe('/p/a.verified.json');
    expect(verifiedPathOf('/p/a.received.txt.bak')).toBe('/p/a.received.txt.bak');
  });
});

describe('verify details', () => {
  const ctx = (testName: string) => ({ testPath: path.join(dir, 'x.test.ts'), testName, env: { VERIFY_ACCEPT: '1' }, root: dir });
  const thrown = (fn: () => void): Error => {
    try {
      fn();
    } catch (e) {
      return e as Error;
    }
    throw new Error('expected a throw');
  };

  it('VerifyError carries its name and the two file paths', () => {
    const e = new VerifyError('m', { received: '/r', verified: '/v' });
    expect(e.name).toBe('VerifyError');
    expect(String(e)).toBe('VerifyError: m');
    expect([e.message, e.received, e.verified]).toEqual(['m', '/r', '/v']);
  });

  it('a snapshot name is derived from the base name with only the last script extension removed', () => {
    expect(snapshotFiles({ testPath: '/p/a.ts.test.ts', testName: 't' }, {}, 'txt').verified).toBe('/p/__verified__/a.ts.test.t.verified.txt');
    expect(snapshotFiles({ testPath: '/p/b.js.spec.mjs', testName: 't' }, {}, 'txt').verified).toBe('/p/__verified__/b.js.spec.t.verified.txt');
    expect(snapshotFiles({ testPath: '/p/c.tsx.test.cts', testName: 't' }, {}, 'txt').verified).toBe('/p/__verified__/c.tsx.test.t.verified.txt');
  });

  it('the collision error names both tests, with an empty name part when no `name` was given', () => {
    verifyValue(ctx('Same Name!'), 'a');
    const testPath = path.join(dir, 'x.test.ts');
    const file = path.join(dir, '__verified__', 'x.test.same-name.verified.txt');
    expect(thrown(() => verifyValue(ctx('same name?'), 'a')).message).toBe(
      `verify: "${testPath}::same name?::" and "${testPath}::Same Name!::" map to the same snapshot file ${file}; give one of them a distinct \`name\``,
    );
  });

  it('...and with the given `name` when there is one', () => {
    verifyValue(ctx('Same Name!'), 'a', { name: 'one' });
    const testPath = path.join(dir, 'x.test.ts');
    const file = path.join(dir, '__verified__', 'x.test.same-name.one.verified.txt');
    expect(thrown(() => verifyValue(ctx('same name?'), 'a', { name: 'one' })).message).toBe(
      `verify: "${testPath}::same name?::one" and "${testPath}::Same Name!::one" map to the same snapshot file ${file}; give one of them a distinct \`name\``,
    );
  });
});
