import { describe, expect, it } from 'vitest';
import { catchAllPattern } from '@ai-bdd/cucumber/register';

/** Attack 12: coexist cases that make a native framework report AMBIGUOUS. */
describe('attack 12: plugin ambiguity', () => {
  const nativePatterns = [
    'I open the settings page',
    'Seed a workspace {string} on the {string} plan',
    '^I have a wallet with (\\d+) euros$',
  ];

  it('never matches a native pattern in coexist mode', () => {
    const pattern = catchAllPattern(nativePatterns, true);
    const matchers = [
      'I open the settings page',
      'Seed a workspace "Acme" on the "free" plan',
      'I have a wallet with 10 euros',
    ];
    for (const step of matchers) {
      expect(pattern.test(step), `${step} must be left to the native step`).toBe(false);
    }
  });

  it('still matches everything else', () => {
    const pattern = catchAllPattern(nativePatterns, true);
    for (const step of ['Open billing settings', 'The badge reads "Pro"', '*', 'I have 10 wallets']) {
      expect(pattern.test(step), step).toBe(true);
    }
  });

  it('is a plain catch-all without coexist mode', () => {
    const pattern = catchAllPattern(nativePatterns, false);
    expect(pattern.test('I open the settings page')).toBe(true);
  });

  it('escapes regex metacharacters in native patterns', () => {
    const pattern = catchAllPattern(['a (b) [c] {d}'], true);
    expect(pattern.test('a (b) [c] {d}')).toBe(false);
    expect(pattern.test('a b c d')).toBe(true);
  });
});
