import { describe, expect, it } from 'vitest';
import { findVolatile, hasVolatile, VOLATILE_PATTERN_DESCRIPTIONS, type VolatileKind, type VolatileMatch } from '../../src/assert/volatile.ts';

const m = (kind: VolatileKind, text: string, index: number): VolatileMatch => ({ kind, text, index });
const kindsOf = (s: string): VolatileKind[] => [...new Set(findVolatile(s).map((x) => x.kind))].sort();
const only = (kind: VolatileKind, text: string, index = 0): VolatileMatch[] => [m(kind, text, index)];

describe('volatile pattern descriptions (R-AS2)', () => {
  it('R-AS2: the description table is exact', () => {
    expect(VOLATILE_PATTERN_DESCRIPTIONS).toEqual({
      time: 'clock times such as 9:41, 12:30:05 or 12:30:05.123',
      date: 'dates such as 2026-10-09 or 10/9/26',
      uuid: 'UUIDs such as 550e8400-e29b-41d4-a716-446655440000',
      'hex-id': 'hexadecimal ids of 8+ characters containing both a digit and a letter, such as 3fa85f64',
      'long-number': 'numbers of 5 or more digits',
      'relative-time': 'relative times such as "5 minutes ago" or "just now"',
    });
  });
});

describe('volatile word characters (R-AS2)', () => {
  it('R-AS2: z and Z are word characters', () => {
    expect(findVolatile('12345z')).toEqual([]);
    expect(findVolatile('z12345')).toEqual([]);
    expect(findVolatile('12345Z')).toEqual([]);
    expect(findVolatile('1z:30')).toEqual([]);
    expect(findVolatile('3fa85f64z')).toEqual([]);
    expect(findVolatile('12345 z')).toEqual(only('long-number', '12345'));
  });

  it('R-AS2: the characters just outside the word ranges separate words', () => {
    // '/' (47) and ':' (58) around the digits, '@' (64) and '[' (91) around A-Z, '`' (96) and '{' (123) around a-z
    for (const sep of ['/', ':', '@', '[', '`', '{', '-', '.']) {
      expect(findVolatile(`12345${sep}`)).toEqual(only('long-number', '12345'));
      expect(findVolatile(`${sep}12345`)).toEqual(only('long-number', '12345', 1));
    }
    expect(findVolatile('12345_')).toEqual([]);
    expect(findVolatile('_12345')).toEqual([]);
  });
});

describe('volatile whitespace between relative-time words (R-AS2)', () => {
  const isWordChar = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;

  it('R-AS2: every UTF-16 code unit is a separator exactly when the spec regex \\s matches it', () => {
    const mismatches: string[] = [];
    for (let c = 0; c <= 0xffff; c += 1) {
      if (isWordChar(c)) continue;
      const ch = String.fromCharCode(c);
      const expected = /^\s$/.test(ch);
      const rel = findVolatile(`5${ch}minutes${ch}ago`);
      const jn = findVolatile(`just${ch}now`);
      if ((rel.length === 1) !== expected) mismatches.push(`relative U+${c.toString(16)}`);
      if ((jn.length === 1) !== expected) mismatches.push(`just now U+${c.toString(16)}`);
    }
    expect(mismatches).toEqual([]);
  });

  it.each([
    [0x20], [0x09], [0x0a], [0x0b], [0x0c], [0x0d], [0xa0], [0x1680], [0x2000], [0x2005], [0x200a], [0x2028], [0x2029], [0x202f], [0x205f], [0x3000], [0xfeff],
  ])('R-AS2: U+%s is whitespace', (c) => {
    const ch = String.fromCharCode(c);
    expect(findVolatile(`5${ch}minutes${ch}ago`)).toEqual(only('relative-time', `5${ch}minutes${ch}ago`));
    expect(findVolatile(`just${ch}now`)).toEqual(only('relative-time', `just${ch}now`));
  });

  it.each([
    [0x00], [0x08], [0x0e], [0x1f], [0x21], [0x2d], [0x85], [0x180e], [0x1fff], [0x200b], [0x2027], [0x202a], [0x205e], [0x2060], [0x3001], [0xfefe],
  ])('R-AS2: U+%s is not whitespace', (c) => {
    const ch = String.fromCharCode(c);
    expect(findVolatile(`5${ch}minutes${ch}ago`)).toEqual([]);
    expect(findVolatile(`just${ch}now`)).toEqual([]);
  });

  it('R-AS2: a separator mixing whitespace with anything else is not whitespace', () => {
    for (const text of ['5 -minutes ago', '5- minutes ago', '5 minutes- ago', '5 minutes -ago', '5 , minutes ago', 'just - now', 'just -now', 'just- now']) {
      expect(findVolatile(text)).toEqual([]);
    }
  });

  it('R-AS2: a run of mixed whitespace is whitespace', () => {
    const text = '5 \t  \n minutes\r\n ago';
    expect(findVolatile(text)).toEqual(only('relative-time', text));
    expect(findVolatile('just \t　 now')).toEqual(only('relative-time', 'just \t　 now'));
  });
});

describe('volatile relative times (R-AS2)', () => {
  it.each(['second', 'seconds', 'minute', 'minutes', 'hour', 'hours', 'day', 'days'])('R-AS2: "5 %s ago" is relative', (unit) => {
    expect(findVolatile(`5 ${unit} ago`)).toEqual(only('relative-time', `5 ${unit} ago`));
    expect(findVolatile(`Edited 12 ${unit.toUpperCase()} AGO.`)).toEqual(only('relative-time', `12 ${unit.toUpperCase()} AGO`, 7));
  });

  it.each([
    'x minutes ago', 'ab minutes ago', '5-minutes ago', '5 weeks ago', '5 month ago', '5 minutes-ago', '5 minutes later', '5 minutes agog',
    '5 minutes', '5 ', 'minutes ago', '5 minute', '5  ago', 'just-now', 'foo now', 'just later', 'just', 'now', 'ago', 'justnow', 'just nowx',
  ])('R-AS2: %j is not relative', (text) => {
    expect(findVolatile(text)).toEqual([]);
  });

  it('R-AS2: "just now" is reported with its exact text and index', () => {
    expect(findVolatile('Synced Just  Now ok')).toEqual(only('relative-time', 'Just  Now', 7));
    expect(findVolatile('JUST NOW')).toEqual(only('relative-time', 'JUST NOW'));
  });

  it('R-AS2: a long number before the unit is both a long number and a relative time', () => {
    expect(findVolatile('12345 days ago')).toEqual([m('long-number', '12345', 0), m('relative-time', '12345 days ago', 0)]);
  });
});

describe('volatile times (R-AS2)', () => {
  it.each([
    ['9:41', '9:41'],
    ['09:41', '09:41'],
    ['12:30:05', '12:30:05'],
    ['12:30:05.123', '12:30:05.123'],
    ['12:30:05.1', '12:30:05.1'],
    ['12:30:05.123456789', '12:30:05.123456789'],
    ['12:30.5', '12:30.5'],
    ['12:30.123', '12:30.123'],
    ['12:30:05.', '12:30:05'],
    ['12:30.', '12:30'],
    ['12:30.x', '12:30'],
    ['12:30:05.x', '12:30:05'],
    ['12:30:05.1x', '12:30:05'],
    ['12:30-45', '12:30'],
    ['12:30-45.5', '12:30'],
    ['12:30:ab', '12:30'],
    ['12:30:5', '12:30'],
    ['12:30:5.5', '12:30'],
    ['12:30::05', '12:30'],
    ['12:30 :05', '12:30'],
    ['12:30:0a', '12:30'],
    ['12:30:123', '12:30'],
  ])('R-AS2: %j reports the time %j', (text, time) => {
    // a fraction of 5 or more digits is additionally a long number, which is not what is asserted here
    expect(findVolatile(text).filter((x) => x.kind === 'time')).toEqual(only('time', time));
  });

  it.each([
    '1:2', '123:45', 'ab:cd', 'ab:12', '12:cd', '1a:23', 'a1:23', '12:3a', '12::34', '12;34', '12-34', '12.34', '12 :34', '12: 34', '1:234', '12:',
    ':34',
  ])('R-AS2: %j is not a time', (text) => {
    expect(kindsOf(text)).not.toContain('time');
  });

  it('R-AS2: several times in a row are reported in order', () => {
    expect(findVolatile('9:41 then 12:30:05.5, 7:05')).toEqual([m('time', '9:41', 0), m('time', '12:30:05.5', 10), m('time', '7:05', 22)]);
  });

  it('R-AS2: a time whose fraction is long is still one match', () => {
    const frac = '1'.repeat(40);
    expect(findVolatile(`12:30:05.${frac}`)).toEqual([m('time', `12:30:05.${frac}`, 0), m('long-number', frac, 9)]);
  });
});

describe('volatile dates (R-AS2)', () => {
  it.each([
    ['2026-10-09', 'date', '2026-10-09'],
    ['x 2026-01-31 y', 'date', '2026-01-31'],
    ['1/2/03', 'date', '1/2/03'],
    ['12/31/2026', 'date', '12/31/2026'],
    ['1/2/2026', 'date', '1/2/2026'],
    ['01/02/03', 'date', '01/02/03'],
  ] as const)('R-AS2: %j reports the date', (text, kind, found) => {
    const hit = findVolatile(text).filter((x) => x.kind === kind);
    expect(hit.map((x) => x.text)).toEqual([found]);
    expect(hit[0]?.index).toBe(text.indexOf(found));
  });

  it.each([
    '12-34-56', 'ab-12-34', 'ab-cd-ef', '2026.12-34', '2026-12.34', '2026-12-3', '2026-1-09', '026-12-34', '12026-12-34', '2026--12-10', '2026-12--10',
    '2026/10/09', '2026-10/09', '2026_10-09', '2026-10-0x', '2026-1x-09', '2x26-10-09', '2026 - 10 - 09',
    '1.2/03', 'ab/2/03', '1/2.03', '1/ab/03', '1/2/3', '1/2/12345', '123/2/03', '1/234/03', '1//2/03', '1/2//03', '1/2/0x', '1-2/03', '1/2-03', '12/34',
  ])('R-AS2: %j is not a date', (text) => {
    expect(kindsOf(text)).not.toContain('date');
  });
});

describe('volatile uuids (R-AS2)', () => {
  const GROUPS = ['550e8400', 'e29b', '41d4', 'a716', '446655440000'];
  const uuid = (groups: readonly string[] = GROUPS, seps: readonly string[] = ['-', '-', '-', '-']): string =>
    groups.map((g, i) => (i < seps.length ? `${g}${seps[i]}` : g)).join('');

  it('R-AS2: a uuid is reported once with its text and index', () => {
    const text = `id ${uuid()} ok`;
    expect(findVolatile(text)).toEqual([
      m('hex-id', '550e8400', 3), m('uuid', '550e8400-e29b-41d4-a716-446655440000', 3), m('long-number', '446655440000', 27),
    ]);
  });

  it('R-AS2: upper case and letter-only uuids are uuids', () => {
    expect(kindsOf('550E8400-E29B-41D4-A716-446655440000')).toContain('uuid');
    expect(kindsOf('abcdefab-abcd-abcd-abcd-abcdefabcdef')).toContain('uuid');
    expect(kindsOf('00000000-0000-0000-0000-000000000000')).toContain('uuid');
  });

  it('R-AS2: two uuids are two matches', () => {
    const other = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const hits = findVolatile(`${uuid()} ${other}`).filter((x) => x.kind === 'uuid');
    expect(hits).toEqual([m('uuid', uuid(), 0), m('uuid', other, 37)]);
  });

  const BREAKS: [string, string][] = [];
  GROUPS.forEach((g, j) => {
    const swap = (replacement: string): string[] => GROUPS.map((x, k) => (k === j ? replacement : x));
    BREAKS.push([`group ${j} has a non-hex first character`, uuid(swap(`g${g.slice(1)}`))]);
    BREAKS.push([`group ${j} has a non-hex last character`, uuid(swap(`${g.slice(0, -1)}g`))]);
    BREAKS.push([`group ${j} is one character short`, uuid(swap(g.slice(1)))]);
    BREAKS.push([`group ${j} is one character long`, uuid(swap(`${g}a`))]);
    BREAKS.push([`group ${j} is not a word`, uuid(swap(`${g.slice(0, 2)}.${g.slice(3)}`))]);
  });
  for (let j = 0; j < 4; j += 1) {
    for (const sep of ['.', ' ', '--', ':', '/', '- ', ' -']) {
      const seps = ['-', '-', '-', '-'];
      seps[j] = sep;
      BREAKS.push([`separator ${j} is ${JSON.stringify(sep)}`, uuid(GROUPS, seps)]);
    }
  }
  BREAKS.push(['there are too few groups', '550e8400-e29b-41d4-a716']);

  it.each(BREAKS)('R-AS2: a uuid where %s is not a uuid', (_label, text) => {
    expect(kindsOf(text)).not.toContain('uuid');
  });

  it('R-AS2: a uuid with a trailing group is not a uuid', () => {
    expect(kindsOf('550e8400-e29b-41d4-a716-446655440000a')).not.toContain('uuid');
    expect(kindsOf('x550e8400-e29b-41d4-a716-446655440000')).not.toContain('uuid');
  });

  it('R-AS2: every non-uuid hex group in the uuid shape stays a plain hex or number match', () => {
    // 8-4-4-4-12 shaped but with non-hex letters: no uuid, no hex-id (not hex), only the all-digit group is a long number
    expect(findVolatile('gggggggg-gggg-gggg-gggg-gggggggggggg')).toEqual([]);
    expect(findVolatile('a-b-c-d-e')).toEqual([]);
  });
});

describe('volatile hex ids and long numbers (R-AS2)', () => {
  it.each([
    ['abcdefab0', 'hex-id'],
    ['0abcdefab', 'hex-id'],
    ['abcdef0a', 'hex-id'],
    ['a0000000', 'hex-id'],
    ['ABCDEFAB9', 'hex-id'],
    ['abcdefab1', 'hex-id'],
    ['1bcdefab', 'hex-id'],
  ])('R-AS2: %j is a hex id (the digit may be 0 or 9)', (text, kind) => {
    expect(findVolatile(text)).toEqual(only(kind as VolatileKind, text));
  });

  it.each(['abcdefab', 'ABCDEFAB', 'abcdefa', 'abcdefg0', '1234567', 'a1b2c3d', 'abcdefab_0'])('R-AS2: %j is not a hex id', (text) => {
    expect(kindsOf(text)).not.toContain('hex-id');
  });

  it('R-AS2: a hex id is not read past the end of its word', () => {
    // the character after the word is a non-digit separator, never a digit: the word is judged on its own characters
    expect(findVolatile('abcdefab 0')).toEqual([]);
    expect(findVolatile('abcdefab-0')).toEqual([]);
    expect(findVolatile('abcdefab0')).toEqual(only('hex-id', 'abcdefab0'));
    expect(findVolatile('x abcdefab0 7')).toEqual(only('hex-id', 'abcdefab0', 2));
  });

  it.each([['1234', 0], ['12345', 1], ['123456', 1]])('R-AS2: %j has %i long-number matches', (text, n) => {
    expect(findVolatile(text).filter((x) => x.kind === 'long-number')).toHaveLength(n);
  });

  it('R-AS2: matches of different kinds are listed in index order', () => {
    const text = '12:30 2026-10-09 3fa85f64 12345 5 minutes ago just now';
    expect(findVolatile(text)).toEqual([
      m('time', '12:30', 0), m('date', '2026-10-09', 6), m('hex-id', '3fa85f64', 17), m('long-number', '12345', 26),
      m('relative-time', '5 minutes ago', 32), m('relative-time', 'just now', 46),
    ]);
    expect(hasVolatile(text)).toBe(true);
  });

  it('R-AS2: the empty string and plain text have no match', () => {
    expect(findVolatile('')).toEqual([]);
    expect(hasVolatile('')).toBe(false);
    expect(hasVolatile('Upgrade to Pro')).toBe(false);
    expect(hasVolatile(' ')).toBe(false);
  });
});
