import { describe, expect, it } from 'vitest';
import { applyScrubbers, counted, defaultScrubbers, digests, durations, guids, instants, normalizeText, paths, ports, replace } from '../src/index.ts';

describe('scrubbers', () => {
  it('guids: distinct values get distinct counters, equal values the same one, case-insensitively', () => {
    const a = '0190a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b';
    const b = '11111111-2222-3333-4444-555555555555';
    expect(guids()(`${a} ${b} ${a.toUpperCase()} not-a-guid`)).toBe('Guid_1 Guid_2 Guid_1 not-a-guid');
  });

  it('counters restart for every text, so a snapshot does not depend on what ran before', () => {
    const s = guids();
    const text = 'x 11111111-2222-3333-4444-555555555555';
    expect(s(text)).toBe('x Guid_1');
    expect(s(text)).toBe('x Guid_1');
  });

  it('instants: ISO-8601 with Z, offsets and fractions; dates alone are left alone', () => {
    expect(instants()('a 2026-10-10T15:44:29Z b 2026-10-10T15:44:29.123+02:00 c 2026-10-10 d 2026-10-10T15:44:29Z')).toBe('a Instant_1 b Instant_2 c 2026-10-10 d Instant_1');
  });

  it('digests, durations and ports', () => {
    const d = 'a'.repeat(64);
    expect(digests()(`${d} ${'b'.repeat(64)} ${d}`)).toBe('Sha256_1 Sha256_2 Sha256_1');
    expect(durations()('took 12ms and 3.5ms, 2 s')).toBe('took {duration} and {duration}, 2 s');
    expect(ports()('http://localhost:4173/x http://127.0.0.1:8080 http://example.com:80 [::1]:9')).toBe('http://localhost:{port}/x http://127.0.0.1:{port} http://example.com:80 [::1]:9');
  });

  it('paths: longest directory first, POSIX, Windows and JSON-escaped spellings', () => {
    const s = paths({ root: '/work/repo', pkg: '/work/repo/packages/a', tmp: '/tmp' });
    expect(s('/work/repo/packages/a/src/x.ts and /work/repo/y and /tmp/z and /other')).toBe('{pkg}/src/x.ts and {root}/y and {tmp}/z and /other');
    const win = paths({ root: 'C:\\work\\repo' });
    expect(win('C:\\work\\repo\\a.ts C:/work/repo/b.ts {"p":"C:\\\\work\\\\repo\\\\c"}')).toBe('{root}\\a.ts {root}/b.ts {"p":"{root}\\\\c"}');
    expect(paths({ root: '' })('/anything')).toBe('/anything');
  });

  it('custom scrubbers: counted and replace add the global flag themselves', () => {
    expect(counted(/user-\d+/, 'User')('user-7 user-9 user-7')).toBe('User_1 User_2 User_1');
    expect(replace(/secret/i, '***')('Secret secret')).toBe('*** ***');
  });

  it('normalizeText: line endings, trailing blanks, one final newline', () => {
    expect(normalizeText('a  \r\nb\t\r\n\r\n\r\n')).toBe('a\nb\n');
    expect(normalizeText('')).toBe('\n');
    expect(normalizeText('x')).toBe('x\n');
  });

  it('applyScrubbers runs in order; defaults cover paths, guids and instants', () => {
    expect(applyScrubbers('a', [(t) => `${t}b`, (t) => `${t}c`])).toBe('abc');
    const out = applyScrubbers('/r/x 11111111-2222-3333-4444-555555555555 2026-01-01T00:00:00Z', defaultScrubbers({ root: '/r' }));
    expect(out).toBe('{root}/x Guid_1 Instant_1');
  });
});
