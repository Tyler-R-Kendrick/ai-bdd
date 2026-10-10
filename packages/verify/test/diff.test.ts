import { describe, expect, it } from 'vitest';
import { unifiedDiff } from '../src/index.ts';

describe('unifiedDiff', () => {
  it('shows removed and added lines with context and elides the rest', () => {
    const a = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const b = a.replace('line 10', 'line TEN');
    const d = unifiedDiff(a, b, { context: 1 });
    expect(d).toBe(['...', ' line 9', '-line 10', '+line TEN', ' line 11', '...'].join('\n').replace(/^\.\.\.\n/, '').replace(/\n\.\.\.$/, ''));
  });

  // Found by tests/fuzz/verify-diff.test.ts: every changed line looped over `context` lines on each side, so a huge or infinite
  // context cost O(context) per change (context: Infinity never returned).
  it('a context wider than the diff shows the whole diff, immediately', () => {
    const a = ['one', 'two', 'three'].join('\n');
    const b = ['one', 'TWO', 'three'].join('\n');
    const started = process.cpuUsage();
    const d = unifiedDiff(a, b, { context: Number.POSITIVE_INFINITY, maxLines: 100 });
    const used = process.cpuUsage(started);
    expect(d).toBe(' one\n-two\n+TWO\n three');
    expect(unifiedDiff(a, b, { context: 2e9 })).toBe(d);
    expect((used.user + used.system) / 1000).toBeLessThan(1000);
  });

  it('identical inputs produce no changed lines', () => {
    expect(unifiedDiff('a\nb', 'a\nb')).toBe('');
  });

  it('handles insertions at either end and empty inputs', () => {
    expect(unifiedDiff('b', 'a\nb\nc', { context: 0 })).toBe('+a\n...\n+c');
    expect(unifiedDiff('', 'x')).toBe('-\n+x');
  });

  it('truncates long diffs', () => {
    const a = Array.from({ length: 200 }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: 200 }, (_, i) => `b${i}`).join('\n');
    const d = unifiedDiff(a, b, { maxLines: 10 });
    expect(d.split('\n')).toHaveLength(11);
    expect(d).toMatch(/\.\.\. \d+ more diff line\(s\)$/);
  });

  it('very large inputs fall back to the first difference', () => {
    const big = Array.from({ length: 2000 }, (_, i) => `l${i}`);
    const other = [...big];
    other[1500] = 'changed';
    const d = unifiedDiff(big.join('\n'), other.join('\n'));
    expect(d).toContain('1500 identical line(s)');
    expect(d).toContain('-l1500');
    expect(d).toContain('+changed');
  });
});
