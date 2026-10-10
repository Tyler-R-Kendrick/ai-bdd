import { describe, expect, it } from 'vitest';
import { MAX_ID_BYTES, MAX_ID_SEGMENT_BYTES, idTooLong, uuidv7 } from '../../src/util/index.ts';

const UUID_V7 = /^([0-9a-f]{8})-([0-9a-f]{4})-(7[0-9a-f]{3})-([89ab][0-9a-f]{3})-([0-9a-f]{12})$/;

function timestampOf(id: string): number {
  const m = UUID_V7.exec(id);
  return Number.parseInt(`${m?.[1]}${m?.[2]}`, 16);
}

describe('uuidv7', () => {
  it('has the 8-4-4-4-12 layout with version 7 and the RFC variant', () => {
    for (let i = 0; i < 200; i++) {
      const id = uuidv7(1_700_000_000_000);
      expect(id).toMatch(UUID_V7);
      expect(id).toHaveLength(36);
    }
  });

  it('carries the millisecond timestamp in its first 48 bits', () => {
    expect(uuidv7(0x0123456789ab).slice(0, 13)).toBe('01234567-89ab');
    expect(uuidv7(0).slice(0, 13)).toBe('00000000-0000');
    expect(uuidv7(0xffffffffffff).slice(0, 13)).toBe('ffffffff-ffff');
    expect(timestampOf(uuidv7(1_700_000_123_456))).toBe(1_700_000_123_456);
  });

  it('sorts by time as text', () => {
    const ts = [3_000, 1_000, 2_000, 1_700_000_000_000, 10];
    const ids = ts.map((t) => uuidv7(t));
    expect([...ids].sort().map((s) => ts[ids.indexOf(s)])).toEqual([10, 1_000, 2_000, 3_000, 1_700_000_000_000]);
  });

  it('is random below the timestamp', () => {
    const rest = new Set(Array.from({ length: 20 }, () => uuidv7(5).slice(14)));
    expect(rest.size).toBe(20);
  });

  it('defaults to the current time', () => {
    const before = Date.now();
    const t = timestampOf(uuidv7());
    const after = Date.now();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
  });
});

describe('idTooLong', () => {
  it('exports the limits', () => {
    expect(MAX_ID_SEGMENT_BYTES).toBe(180);
    expect(MAX_ID_BYTES).toBe(1024);
  });

  it('accepts ordinary ids, the empty id and ids with empty segments', () => {
    expect(idTooLong('')).toBe(false);
    expect(idTooLong('scenario/login')).toBe(false);
    expect(idTooLong('//')).toBe(false);
  });

  it('allows a segment of exactly 180 bytes and refuses 181, whether it is the only, first, middle or last one', () => {
    const ok = 'a'.repeat(180);
    const long = 'a'.repeat(181);
    expect(idTooLong(ok)).toBe(false);
    expect(idTooLong(long)).toBe(true);
    expect(idTooLong(`${ok}/${ok}`)).toBe(false);
    expect(idTooLong(`${long}/x`)).toBe(true);
    expect(idTooLong(`x/${long}/y`)).toBe(true);
    expect(idTooLong(`x/${long}`)).toBe(true);
  });

  it('counts UTF-8 bytes, not characters', () => {
    expect(idTooLong('é'.repeat(90))).toBe(false); // 180 bytes
    expect(idTooLong('é'.repeat(91))).toBe(true); // 91 characters, 182 bytes
    expect(idTooLong('€'.repeat(60))).toBe(false); // 180 bytes
    expect(idTooLong('€'.repeat(61))).toBe(true);
    expect(idTooLong('😀'.repeat(45))).toBe(false); // 180 bytes
    expect(idTooLong('😀'.repeat(46))).toBe(true);
  });

  it('splits segments on / only', () => {
    expect(idTooLong(`${'a'.repeat(100)}/${'a'.repeat(100)}`)).toBe(false);
    expect(idTooLong(`${'a'.repeat(100)}\\${'a'.repeat(100)}`)).toBe(true);
    expect(idTooLong(`${'a'.repeat(100)}.${'a'.repeat(100)}`)).toBe(true);
  });

  it('allows a whole id of exactly 1024 bytes and refuses 1025, even when every segment is short', () => {
    // segments of 100 bytes joined by '/': 9 * 101 + 115 = 1024 bytes
    const build = (bytes: number): string => {
      const parts: string[] = [];
      let left = bytes;
      while (left > 0) {
        const take = Math.min(100, left);
        parts.push('a'.repeat(take));
        left -= take + 1;
      }
      return parts.join('/');
    };
    const at = build(1024);
    expect(Buffer.byteLength(at)).toBe(1024);
    expect(idTooLong(at)).toBe(false);
    const over = build(1025);
    expect(Buffer.byteLength(over)).toBe(1025);
    expect(over.split('/').every((s) => Buffer.byteLength(s) <= 180)).toBe(true);
    expect(idTooLong(over)).toBe(true);
  });
});
