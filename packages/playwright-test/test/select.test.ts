import { describe, expect, it } from 'vitest';
import { globToRegExp, normalizeTag, selectScenarios } from '../src/select.ts';
import { feature, plan, scenario } from './helpers/doubles.ts';

describe('selection helpers (R-SDK1)', () => {
  it.each([
    ['docs/*.md', 'docs/billing.md', true],
    ['docs/*.md', 'docs/sub/billing.md', false],
    ['docs/**/*.md', 'docs/billing.md', true],
    ['docs/**/*.md', 'docs/sub/deep/billing.md', true],
    ['**/*.md', 'a.md', true],
    ['docs/b?lling.md', 'docs/billing.md', true],
    ['docs/b?lling.md', 'docs/b/lling.md', false],
    ['docs/a+b (1).md', 'docs/a+b (1).md', true],
    ['docs/billing.md', 'docs/billingxmd', false],
  ])('R-SDK1 glob %s vs %s -> %s', (glob, path, expected) => {
    expect(globToRegExp(glob).test(path)).toBe(expected);
  });

  it('R-SDK1 normalizes tags', () => {
    expect(normalizeTag(' @@smoke ')).toBe('smoke');
    expect(normalizeTag('smoke')).toBe('smoke');
  });

  it('R-SDK1 selectScenarios keeps plan order and drops features without remaining scenarios', () => {
    const plans = [
      plan('docs/a.md', [
        feature('a--one', 'One', [scenario('a--one/x', 'X'), scenario('a--one/y', 'Y', { review: 'rejected' })]),
        feature('a--two', 'Two', [scenario('a--two/z', 'Z', { tags: ['slow'] })]),
      ]),
    ];
    expect(selectScenarios(plans).map((g) => g.scenarios.map((s) => s.id))).toEqual([['a--one/x'], ['a--two/z']]);
    expect(selectScenarios(plans, { tags: ['slow'] }).map((g) => g.feature.id)).toEqual(['a--two']);
    expect(selectScenarios(plans, { selectors: ['a--one'] })).toEqual([]);
    expect(selectScenarios(plans, { selectors: ['a--one/x'] })).toHaveLength(1);
  });
});
