import { describe, expect, it } from 'vitest';
import type { Dialect, SourceLocation, StepOptions } from '@ai-bdd/contracts';
import { parseDirectives } from '../src/index.js';

const loc: SourceLocation = { uri: 'test://directive', line: 1, column: 1 };

interface ValidRow {
  line: string;
  dialect: Dialect;
  expected: Partial<StepOptions>;
}

interface InvalidRow {
  line: string;
  dialect: Dialect;
  code: string;
  /** Keys that must not be set after the invalid row is parsed. */
  notSet?: string[];
}

const VALID: ValidRow[] = [
  { line: '<!-- ai-bdd: kind=setup -->', dialect: 'gauge', expected: { kind: 'setup' } },
  { line: '<!-- ai-bdd: kind=action -->', dialect: 'gauge', expected: { kind: 'action' } },
  { line: '<!-- ai-bdd: kind=assertion -->', dialect: 'gauge', expected: { kind: 'assertion' } },
  { line: '<!-- ai-bdd: mode=auto -->', dialect: 'gauge', expected: { mode: 'auto' } },
  { line: '<!-- ai-bdd: mode=check -->', dialect: 'gauge', expected: { mode: 'check' } },
  { line: '<!-- ai-bdd: mode=judge -->', dialect: 'gauge', expected: { mode: 'judge' } },
  { line: '<!-- ai-bdd: mode=both -->', dialect: 'gauge', expected: { mode: 'both' } },
  { line: '<!-- ai-bdd: threshold=0 -->', dialect: 'gauge', expected: { threshold: 0 } },
  { line: '<!-- ai-bdd: threshold=0.85 -->', dialect: 'gauge', expected: { threshold: 0.85 } },
  { line: '<!-- ai-bdd: threshold=1 -->', dialect: 'gauge', expected: { threshold: 1 } },
  { line: '<!-- ai-bdd: failThreshold=0.4 threshold=0.8 -->', dialect: 'gauge', expected: { failThreshold: 0.4, threshold: 0.8 } },
  { line: '<!-- ai-bdd: samples=1 -->', dialect: 'gauge', expected: { samples: 1 } },
  { line: '<!-- ai-bdd: samples=9 -->', dialect: 'gauge', expected: { samples: 9 } },
  { line: '<!-- ai-bdd: vision=on -->', dialect: 'gauge', expected: { vision: true } },
  { line: '<!-- ai-bdd: vision=off -->', dialect: 'gauge', expected: { vision: false } },
  { line: '<!-- ai-bdd: driver=web -->', dialect: 'gauge', expected: { driver: 'web' } },
  { line: '<!-- ai-bdd: driver="my driver" -->', dialect: 'gauge', expected: { driver: 'my driver' } },
  { line: '<!-- ai-bdd: resolve=auto -->', dialect: 'gauge', expected: { resolve: 'auto' } },
  { line: '<!-- ai-bdd: resolve=exact -->', dialect: 'gauge', expected: { resolve: 'exact' } },
  { line: '<!-- ai-bdd: resolve=semantic -->', dialect: 'gauge', expected: { resolve: 'semantic' } },
  { line: '<!-- ai-bdd: resolve=agent -->', dialect: 'gauge', expected: { resolve: 'agent' } },
  { line: '<!-- ai-bdd: timeout=5000 -->', dialect: 'gauge', expected: { timeout: 5000 } },
  { line: '<!-- ai-bdd: invariant=true -->', dialect: 'gauge', expected: { invariant: true } },
  { line: '<!-- ai-bdd: invariant=false -->', dialect: 'gauge', expected: { invariant: false } },
  { line: '<!--ai-bdd: kind=action-->', dialect: 'gauge', expected: { kind: 'action' } },
  { line: '<!-- ai-bdd: kind=action, threshold=0.5 -->', dialect: 'gauge', expected: { kind: 'action', threshold: 0.5 } },
  { line: '   <!-- ai-bdd: vision=on -->   ', dialect: 'gauge', expected: { vision: true } },
  { line: '<!-- ai-bdd: driver="a b c" kind=setup -->', dialect: 'gauge', expected: { driver: 'a b c', kind: 'setup' } },
  { line: '<!-- ai-bdd: driver="quote\\"inside" -->', dialect: 'gauge', expected: { driver: 'quote"inside' } },
  { line: '# ai-bdd: kind=setup', dialect: 'gherkin', expected: { kind: 'setup' } },
  { line: '# ai-bdd: kind=assertion', dialect: 'gherkin', expected: { kind: 'assertion' } },
  { line: '# ai-bdd: mode=judge threshold=0.9', dialect: 'gherkin', expected: { mode: 'judge', threshold: 0.9 } },
  { line: '   # ai-bdd: vision=off', dialect: 'gherkin', expected: { vision: false } },
  { line: '# ai-bdd: driver="playwright chrome" samples=3', dialect: 'gherkin', expected: { driver: 'playwright chrome', samples: 3 } },
];

const INVALID: InvalidRow[] = [
  { line: '<!-- ai-bdd: kind=banana -->', dialect: 'gauge', code: 'DIRECTIVE_INVALID_VALUE', notSet: ['kind'] },
  { line: '<!-- ai-bdd: mode=maybe -->', dialect: 'gauge', code: 'DIRECTIVE_INVALID_VALUE', notSet: ['mode'] },
  { line: '<!-- ai-bdd: threshold=1.5 -->', dialect: 'gauge', code: 'DIRECTIVE_INVALID_VALUE', notSet: ['threshold'] },
  { line: '<!-- ai-bdd: threshold=-0.1 -->', dialect: 'gauge', code: 'DIRECTIVE_INVALID_VALUE', notSet: ['threshold'] },
  { line: '<!-- ai-bdd: threshold=abc -->', dialect: 'gauge', code: 'DIRECTIVE_INVALID_VALUE', notSet: ['threshold'] },
  { line: '<!-- ai-bdd: failThreshold=0.9 threshold=0.5 -->', dialect: 'gauge', code: 'DIRECTIVE_INVALID_VALUE' },
  { line: '<!-- ai-bdd: failThreshold=0.5 threshold=0.5 -->', dialect: 'gauge', code: 'DIRECTIVE_INVALID_VALUE' },
  { line: '<!-- ai-bdd: samples=0 -->', dialect: 'gauge', code: 'DIRECTIVE_INVALID_VALUE', notSet: ['samples'] },
  { line: '<!-- ai-bdd: samples=10 -->', dialect: 'gauge', code: 'DIRECTIVE_INVALID_VALUE', notSet: ['samples'] },
  { line: '<!-- ai-bdd: samples=1.5 -->', dialect: 'gauge', code: 'DIRECTIVE_INVALID_VALUE', notSet: ['samples'] },
  { line: '<!-- ai-bdd: vision=true -->', dialect: 'gauge', code: 'DIRECTIVE_INVALID_VALUE', notSet: ['vision'] },
  { line: '<!-- ai-bdd: vision=maybe -->', dialect: 'gauge', code: 'DIRECTIVE_INVALID_VALUE', notSet: ['vision'] },
  { line: '<!-- ai-bdd: invariant=yes -->', dialect: 'gauge', code: 'DIRECTIVE_INVALID_VALUE', notSet: ['invariant'] },
  { line: '<!-- ai-bdd: resolve=maybe -->', dialect: 'gauge', code: 'DIRECTIVE_INVALID_VALUE', notSet: ['resolve'] },
  { line: '<!-- ai-bdd: timeout=0 -->', dialect: 'gauge', code: 'DIRECTIVE_INVALID_VALUE', notSet: ['timeout'] },
  { line: '<!-- ai-bdd: timeout=-5 -->', dialect: 'gauge', code: 'DIRECTIVE_INVALID_VALUE', notSet: ['timeout'] },
  { line: '<!-- ai-bdd: driver= -->', dialect: 'gauge', code: 'DIRECTIVE_INVALID_VALUE', notSet: ['driver'] },
  { line: '<!-- ai-bdd: unknown=1 -->', dialect: 'gauge', code: 'DIRECTIVE_UNKNOWN_KEY' },
  { line: '<!-- ai-bdd: nope -->', dialect: 'gauge', code: 'DIRECTIVE_INVALID_VALUE' },
  { line: '<!-- ai-bdd: =1 -->', dialect: 'gauge', code: 'DIRECTIVE_UNKNOWN_KEY' },
  { line: '<!-- ai-bdd: kind="unterminated -->', dialect: 'gauge', code: 'DIRECTIVE_INVALID_VALUE' },
  { line: '# ai-bdd: kind=nope', dialect: 'gherkin', code: 'DIRECTIVE_INVALID_VALUE', notSet: ['kind'] },
  { line: '# ai-bdd: threshold=2', dialect: 'gherkin', code: 'DIRECTIVE_INVALID_VALUE', notSet: ['threshold'] },
  { line: '# ai-bdd: mystery=1', dialect: 'gherkin', code: 'DIRECTIVE_UNKNOWN_KEY' },
];

const NOT_DIRECTIVES: Array<{ line: string; dialect: Dialect }> = [
  { line: '# Workspace billing', dialect: 'gauge' },
  { line: '## Scenario one', dialect: 'gauge' },
  { line: '* a step', dialect: 'gauge' },
  { line: '<!-- just a comment -->', dialect: 'gauge' },
  { line: '<!-- ai-bdd -->', dialect: 'gauge' },
  { line: '', dialect: 'gauge' },
  { line: 'Tags: billing, smoke', dialect: 'gauge' },
  { line: '# language: fr', dialect: 'gherkin' },
  { line: 'Feature: billing', dialect: 'gherkin' },
  { line: 'Given a workspace', dialect: 'gherkin' },
  { line: '', dialect: 'gherkin' },
];

describe('parseDirectives (section 7.3)', () => {
  it.each(VALID)('accepts $dialect "$line"', ({ line, dialect, expected }) => {
    const result = parseDirectives(line, dialect, loc);
    expect(result).not.toBeNull();
    expect(result?.directives).toEqual(expected);
    expect(result?.diagnostics).toEqual([]);
  });

  it.each(INVALID)('rejects $dialect "$line" with $code', ({ line, dialect, code, notSet }) => {
    const result = parseDirectives(line, dialect, loc);
    expect(result).not.toBeNull();
    expect(result?.diagnostics.map((d) => d.code)).toContain(code);
    for (const key of notSet ?? []) {
      expect(result?.directives).not.toHaveProperty(key);
    }
  });

  it.each(NOT_DIRECTIVES)('returns null for non-directive $dialect "$line"', ({ line, dialect }) => {
    expect(parseDirectives(line, dialect, loc)).toBeNull();
  });

  it('covers at least 30 valid and invalid directive lines', () => {
    expect(VALID.length + INVALID.length).toBeGreaterThanOrEqual(30);
  });
});
