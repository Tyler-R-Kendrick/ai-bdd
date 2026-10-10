import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { findVolatile, hasVolatile, type VolatileKind } from '../../src/assert/volatile.ts';

const RUNS = Number(process.env['FC_RUNS'] ?? 200);

const kindsOf = (s: string): VolatileKind[] => [...new Set(findVolatile(s).map((m) => m.kind))].sort();

describe('volatile patterns table (R-AS2)', () => {
  const POSITIVE: [string, string, VolatileKind][] = [
    ['9:41', 'time', 'time'],
    ['Updated 12:30 today', 'time', 'time'],
    ['at 12:30:05', 'time', 'time'],
    ['at 12:30:05.123', 'time', 'time'],
    ['2026-10-09', 'ISO date', 'date'],
    ['Due 2026-01-31.', 'ISO date in prose', 'date'],
    ['10/9/26', 'US short date', 'date'],
    ['10/09/2026', 'US long date', 'date'],
    ['550e8400-e29b-41d4-a716-446655440000', 'lowercase uuid', 'uuid'],
    ['550E8400-E29B-41D4-A716-446655440000', 'uppercase uuid', 'uuid'],
    ['id 3fa85f64 ok', 'hex id with digit and letter', 'hex-id'],
    ['A1B2C3D4E5', 'uppercase hex id', 'hex-id'],
    ['order 12345', 'five-digit number', 'long-number'],
    ['1234567890', 'ten-digit number', 'long-number'],
    ['5 minutes ago', 'relative minutes', 'relative-time'],
    ['1 hour ago', 'relative hour', 'relative-time'],
    ['30 SECONDS AGO', 'relative seconds, upper case', 'relative-time'],
    ['2 days ago', 'relative days', 'relative-time'],
    ['Synced just now', 'just now', 'relative-time'],
    ['Synced Just  Now', 'just now with extra whitespace and case', 'relative-time'],
  ];
  const NEGATIVE: [string, string][] = [
    ['', 'empty string'],
    ['Upgrade to Pro', 'plain words'],
    ['1234', 'four-digit number'],
    ['12,345', 'comma grouped number'],
    ['deadbeef', 'hex letters only'],
    ['12345678', 'digits only is long-number but not hex-id'],
    ['abcdef1', 'seven hex chars'],
    ['inv_3fa85f64', 'underscore is a word character, so no boundary'],
    ['3fa85f64x', 'trailing non-hex letter'],
    ['9:5', 'single digit minutes'],
    ['9:41pm', 'suffixed minutes'],
    ['123:45', 'three-digit hours'],
    ['2026-1-09', 'short ISO month'],
    ['10/9', 'two-part date'],
    ['5 minute', 'relative time without ago'],
    ['minutes ago', 'ago without a number'],
    ['5minutes ago', 'no space between number and unit'],
    ['justnow', 'no space in just now'],
    ['version 2.0', 'version number'],
  ];

  it.each(POSITIVE)('R-AS2: %s (%s) is volatile', (text, _label, kind) => {
    expect(kindsOf(text)).toContain(kind);
    expect(hasVolatile(text)).toBe(true);
  });

  it.each(NEGATIVE)('R-AS2: %j (%s) has no volatile match of the checked kind', (text, label) => {
    const kinds = kindsOf(text);
    if (label.startsWith('digits only')) expect(kinds).toEqual(['long-number']);
    else expect(kinds).toEqual([]);
  });

  it('R-AS2: a uuid with a short last group is not a uuid', () => {
    expect(kindsOf('550e8400-e29b-41d4-a716-44665544000')).not.toContain('uuid');
  });

  it('R-AS2: a match reports its text and index', () => {
    const m = findVolatile('Saved at 12:30:05 ok');
    expect(m).toEqual([{ kind: 'time', text: '12:30:05', index: 9 }]);
  });

  it('R-AS2: hex-id requires both a digit and a letter', () => {
    expect(kindsOf('deadbeef')).toEqual([]);
    expect(kindsOf('dead1eef')).toEqual(['hex-id']);
  });
});

// Reference implementations: the regular expressions exactly as written in the spec (test-only).
const REFERENCE: Record<VolatileKind, (s: string) => boolean> = {
  time: (s) => /\b\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\b/i.test(s),
  date: (s) => /\b\d{4}-\d{2}-\d{2}\b/i.test(s) || /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/i.test(s),
  uuid: (s) => /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(s),
  'hex-id': (s) => (s.match(/\b[0-9a-f]{8,}\b/gi) ?? []).some((m) => /\d/.test(m) && /[a-f]/i.test(m)),
  'long-number': (s) => /\b\d{5,}\b/i.test(s),
  'relative-time': (s) => /\b\d+\s+(second|minute|hour|day)s?\s+ago\b/i.test(s) || /\bjust\s+now\b/i.test(s),
};

const FRAGMENTS = [
  '1', '9', '12', '30', '45', '123', '1234', '12345', '2026', '07', '3fa85f64', 'deadbeef', 'DEADBEEF1', '550e8400', 'e29b', '41d4',
  'a716', '446655440000', 'x', 'ab', '_', ':', '-', '/', '.', ' ', '  ', '\t', ' ', ',', 'ago', 'minute', 'minutes', 'hour', 'day', 'days',
  'seconds', 'just', 'now', 'Z', 'f', 'A',
];

describe('volatile detection parity with the spec regexes (R-AS2)', () => {
  it('R-AS2: kind presence equals the reference regexes on random token soup', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...FRAGMENTS), { maxLength: 24 }), (parts) => {
        const s = parts.join('');
        const got = new Set(findVolatile(s).map((m) => m.kind));
        for (const kind of Object.keys(REFERENCE) as VolatileKind[]) {
          expect(got.has(kind), `${kind} on ${JSON.stringify(s)}`).toBe(REFERENCE[kind](s));
        }
      }),
      { numRuns: RUNS * 10 },
    );
  });

  it('R-AS2: every reported match slices the input at its index', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...FRAGMENTS), { maxLength: 24 }), (parts) => {
        const s = parts.join('');
        for (const m of findVolatile(s)) expect(s.slice(m.index, m.index + m.text.length)).toBe(m.text);
      }),
      { numRuns: RUNS },
    );
  });

  it('R-AS2: never throws on arbitrary unicode strings', () => {
    fc.assert(fc.property(fc.string({ unit: 'binary', maxLength: 200 }), (s) => { findVolatile(s); }), { numRuns: RUNS });
  });
});

describe('volatile patterns ReDoS fuzz (R-AS2, R-AS3)', () => {
  const N = 100_000;
  const ADVERSARIAL: [string, string][] = [
    ['digits', '1'.repeat(N)],
    ['digits then x', `${'1'.repeat(N)}x`],
    ['hex then g', `${'a1'.repeat(N / 2)}g`],
    ['colon chain', '1:'.repeat(N / 2)],
    ['time prefix then junk', `12:30${':00'.repeat(N / 3)}x`],
    ['dot digits', `12:30:45.${'1'.repeat(N)}x`],
    ['spaces after digit', `1${' '.repeat(N)}x`],
    ['digit space pairs', '1 '.repeat(N / 2)],
    ['relative prefix', '1 minute '.repeat(N / 9)],
    ['relative then no ago', `${'1 '.repeat(N / 4)}minutes ${' '.repeat(N / 4)}ag`],
    ['just spaces', `just${' '.repeat(N)}nowx`],
    ['just repeated', 'just '.repeat(N / 5)],
    ['uuid chain', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa-'.repeat(N / 37)],
    ['hyphens', '-'.repeat(N)],
    ['date chain', '2026-10-'.repeat(N / 8)],
    ['slashes', '1/'.repeat(N / 2)],
    ['alternating word/sep', 'a-'.repeat(N / 2)],
    ['unicode spaces', '1 '.repeat(N / 2)],
    ['lone surrogates', '\ud800'.repeat(N)],
  ];

  it.each(ADVERSARIAL)('R-AS2 R-AS3: %s (100k chars) completes in under 50ms', (_label, input) => {
    expect(input.length).toBeGreaterThanOrEqual(70_000);
    findVolatile(input.slice(0, 2000)); // warm up
    const times: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const t0 = performance.now();
      findVolatile(input);
      times.push(performance.now() - t0);
    }
    expect(Math.min(...times)).toBeLessThan(50);
  });

  it('R-AS2: matching time scales linearly (4x input stays within 12x time)', () => {
    const run = (n: number): number => {
      const input = '1:30 2026-10-09 3fa85f64 '.repeat(n);
      const t0 = performance.now();
      findVolatile(input);
      return performance.now() - t0;
    };
    run(2000);
    const small = Math.max(Math.min(run(4000), run(4000), run(4000)), 0.05);
    const big = Math.min(run(16000), run(16000), run(16000));
    expect(big).toBeLessThan(small * 12 + 5);
  });
});
