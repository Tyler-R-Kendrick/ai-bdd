import { describe, expect, it } from 'vitest';
import { isVolatileText } from '../../src/recording/volatile.ts';

describe('isVolatileText patterns that no other pattern also covers', () => {
  it.each([
    ['two-digit day and month with a four-digit year', '10/12/2026', true],
    ['two-digit day and month with a two-digit year', '10/12/26', true],
    ['one-digit day and month with a two-digit year', '1/2/26', true],
    ['a date with a one-digit year is not a date', '1/2/6', false],
    ['letters only UUID', 'abcdefab-cdef-abcd-efab-cdefabcdefab', true],
    ['upper-case letters only UUID', 'ABCDEFAB-CDEF-ABCD-EFAB-CDEFABCDEFAB', true],
    ['UUID inside a sentence', 'order abcdefab-cdef-abcd-efab-cdefabcdefab shipped', true],
    ['UUID with a short first segment', 'abcdefa-cdef-abcd-efab-cdefabcdefab', false],
    ['UUID with a short second segment', 'abcdefab-cde-abcd-efab-cdefabcdefab', false],
    ['UUID with a short third segment', 'abcdefab-cdef-abc-efab-cdefabcdefab', false],
    ['UUID with a short fourth segment', 'abcdefab-cdef-abcd-efa-cdefabcdefab', false],
    ['UUID with a short last segment', 'abcdefab-cdef-abcd-efab-cdefabcdefa', false],
    ['UUID with a non-hex first segment', 'ghijklmn-cdef-abcd-efab-cdefabcdefab', false],
    ['UUID with a non-hex second segment', 'abcdefab-ghij-abcd-efab-cdefabcdefab', false],
    ['UUID with a non-hex third segment', 'abcdefab-cdef-ghij-efab-cdefabcdefab', false],
    ['UUID with a non-hex fourth segment', 'abcdefab-cdef-abcd-ghij-cdefabcdefab', false],
    ['UUID with a non-hex last segment', 'abcdefab-cdef-abcd-efab-ghijklmnopqr', false],
    ['a multi-digit count of seconds ago', '12 seconds ago', true],
    ['a multi-digit count of minutes ago', '45 minutes ago', true],
    ['a singular minute ago', '1 minute ago', true],
    ['a singular second ago', '1 second ago', true],
    ['a singular hour ago', '1 hour ago', true],
    ['a singular day ago', '1 day ago', true],
    ['plural hours ago', '2 hours ago', true],
    ['plural days ago', '2 days ago', true],
    ['several spaces between the count and the unit', '3   minutes ago', true],
    ['a tab between the count and the unit', '3\tminutes ago', true],
    ['several spaces before "ago"', '3 minutes   ago', true],
    ['a newline before "ago"', '3 minutes\nago', true],
    ['an unknown unit', '3 weeks ago', false],
    ['no count', 'minutes ago', false],
    ['no space before "ago"', '3 minutesago', false],
    ['no space after the count', '3minutes ago', false],
  ])('%s: %j', (_name, text, expected) => {
    expect(isVolatileText(text)).toBe(expected);
  });
});

describe('isVolatileText clock times', () => {
  it.each([
    ['0:00', true],
    ['23:59', true],
    ['9:05:11', true],
    ['09:05:11.250', true],
    ['12:3', false],
    ['123:45', false],
  ])('%j', (text, expected) => {
    expect(isVolatileText(text)).toBe(expected);
  });
});

describe('isVolatileText hex identifiers', () => {
  it.each([
    ['deadbeef1', true],
    ['1deadbeef', true],
    ['0123abcd', true],
    ['DEADBEEF1', true],
    ['deadbeef', false],
    ['DEADBEEF', false],
    ['deadbee1', true],
    ['abcdef1', false],
    ['a b c d e f 1 2', false],
  ])('%j', (text, expected) => {
    expect(isVolatileText(text)).toBe(expected);
  });
});
