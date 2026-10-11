import { describe, expect, it } from 'vitest';
import { normalizeForQuote, normalizeText, sha256Hex, slugify, toPosix } from '../../src/util/index.ts';

describe('normalizeText', () => {
  it('collapses every run of whitespace to one space and trims', () => {
    expect(normalizeText('  a \t\n b\u00a0\u2003c  ')).toBe('a b c');
    expect(normalizeText('')).toBe('');
    expect(normalizeText(' \n ')).toBe('');
  });

  it('composes to NFC', () => {
    expect(normalizeText('e\u0301')).toBe('\u00e9');
    expect(normalizeText('e\u0301').length).toBe(1);
  });
});

describe('normalizeForQuote', () => {
  it('lowercases and normalizes whitespace', () => {
    expect(normalizeForQuote('  Hello\n  WORLD ')).toBe('hello world');
  });

  it('maps typographic single quotes, double quotes, dashes and the ellipsis to ASCII', () => {
    expect(normalizeForQuote('\u2018a\u2019 \u201Ab\u201B')).toBe("'a' 'b'");
    expect(normalizeForQuote('\u201Cx\u201D \u201Ey\u201F')).toBe('"x" "y"');
    for (const dash of ['\u2010', '\u2011', '\u2012', '\u2013', '\u2014', '\u2015']) expect(normalizeForQuote(`a${dash}b`)).toBe('a-b');
    expect(normalizeForQuote('wait\u2026')).toBe('wait...');
  });

  it('leaves characters just outside the mapped ranges alone', () => {
    expect(normalizeForQuote('\u2016\u201c\u2017x')).toBe('\u2016"\u2017x');
  });
});

describe('slugify', () => {
  it('lowercases, strips accents and joins words with single dashes', () => {
    expect(slugify('Hello, World!')).toBe('hello-world');
    expect(slugify('Crème Brûlée')).toBe('creme-brulee');
    expect(slugify('a___b   c')).toBe('a-b-c');
    expect(slugify('--Edge--Case--')).toBe('edge-case');
    expect(slugify('ＡＢＣ 123')).toBe('abc-123');
  });

  it('cuts to the maximum length (64 by default) and never ends in a dash after the cut', () => {
    expect(slugify('a'.repeat(100))).toBe('a'.repeat(64));
    expect(slugify('abcdef', 3)).toBe('abc');
    expect(slugify('abc def', 4)).toBe('abc');
    expect(slugify('abc def', 5)).toBe('abc-d');
    expect(slugify(`${'a'.repeat(63)} b`)).toBe('a'.repeat(63));
    expect(slugify(`${'a'.repeat(62)} b`)).toBe(`${'a'.repeat(62)}-b`);
  });

  it('falls back to a hash of the input when nothing usable is left', () => {
    expect(slugify('日本語')).toBe(`h-${sha256Hex('日本語').slice(0, 8)}`);
    expect(slugify('---')).toBe(`h-${sha256Hex('---').slice(0, 8)}`);
    expect(slugify('')).toBe(`h-${sha256Hex('').slice(0, 8)}`);
    expect(slugify('abc', 0)).toBe(`h-${sha256Hex('abc').slice(0, 8)}`);
    expect(slugify('日本語')).not.toBe(slugify('中文'));
  });
});

describe('toPosix', () => {
  it('turns every backslash into a forward slash and changes nothing else', () => {
    expect(toPosix('a\\b')).toBe('a/b');
    expect(toPosix('C:\\Users\\me\\x.txt')).toBe('C:/Users/me/x.txt');
    expect(toPosix('\\\\server\\share')).toBe('//server/share');
    expect(toPosix('a/b/c')).toBe('a/b/c');
    expect(toPosix('')).toBe('');
    expect(toPosix('plain')).toBe('plain');
  });
});
