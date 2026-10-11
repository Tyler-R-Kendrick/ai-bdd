import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import { VerifyError, applyScrubbers, defaultScrubbers, digests, durations, guids, instants, normalizeText, paths, ports, slug, snapshotFiles, verifyValue } from '@ai-bdd/verify';
import { cpuMs, hostileString, jsonValue, params } from './helpers.ts';

// ───────────────────────── generators

const hex = (n: number): fc.Arbitrary<string> => fc.stringMatching(new RegExp(`^[0-9a-f]{${n}}$`));
const guid = fc.tuple(hex(8), hex(4), hex(4), hex(4), hex(12)).map((p) => p.join('-')).chain((g) => fc.constantFrom(g, g.toUpperCase()));
const instant = fc.constantFrom('2026-10-10T10:00:00Z', '2026-10-10T10:00:00.123Z', '2026-10-10T10:00:00+02:00', '2024-02-29T23:59:59.9-0530');
const digest = hex(64);
const duration = fc.tuple(fc.nat(99999), fc.option(fc.nat(99), { nil: undefined })).map(([a, b]) => `${a}${b === undefined ? '' : `.${b}`}ms`);
const filler = fc.oneof(fc.constantFrom(' ', ', ', '\n', ' at ', ' "', '" ', '=', ':', '/'), hostileString({ maxLength: 12 }));

/** Text with volatile tokens planted between separators. */
const volatileText = fc
  .array(fc.oneof(filler, guid, instant, digest, duration, fc.constantFrom('http://localhost:3000/x', 'http://127.0.0.1:8080', 'http://[::1]:5173/', 'localhost:99')), { maxLength: 12 })
  .map((parts) => parts.join(' '));

const DIRS = { root: '/work/project', tmp: '/tmp' };
const ALL = [...defaultScrubbers(DIRS), digests(), durations(), ports()];

describe('fuzz: scrubbers', () => {
  it('every scrubber is deterministic, never throws, and leaves a second pass with nothing to do (idempotent)', () => {
    const named = { guids: guids(), instants: instants(), digests: digests(), durations: durations(), ports: ports(), paths: paths(DIRS), normalizeText };
    fc.assert(
      fc.property(fc.oneof(volatileText, hostileString({ maxLength: 300 })), (text) => {
        for (const [name, fn] of Object.entries(named)) {
          const once = fn(text);
          expect(fn(text), name).toBe(once);
          expect(fn(once), `${name} twice`).toBe(once);
        }
        const all = applyScrubbers(text, ALL);
        expect(applyScrubbers(all, ALL)).toBe(all);
      }),
      params({ scale: 2 }),
    );
  });

  it('numbered scrubbers keep identity: equal values share a label, different values never do, labels count up from 1 in order of appearance', () => {
    fc.assert(
      fc.property(fc.array(guid, { minLength: 1, maxLength: 8 }), (ids) => {
        const text = ids.join(' | ');
        const out = guids()(text).split(' | ');
        const firstSeen = new Map<string, number>();
        ids.forEach((id, i) => {
          const key = id.toLowerCase();
          if (!firstSeen.has(key)) firstSeen.set(key, firstSeen.size + 1);
          expect(out[i]).toBe(`Guid_${firstSeen.get(key)}`);
        });
      }),
      params(),
    );
    fc.assert(
      fc.property(fc.array(digest, { minLength: 1, maxLength: 6 }), (ds) => {
        const out = digests()(ds.join(' ')).split(' ');
        ds.forEach((d, i) => {
          const j = ds.findIndex((x) => x.toLowerCase() === d.toLowerCase());
          expect(out[i]).toBe(out[j]);
        });
        expect(new Set(out).size).toBe(new Set(ds.map((d) => d.toLowerCase())).size);
      }),
      params(),
    );
  });

  it('removes every token it is responsible for and nothing else: text without tokens is unchanged', () => {
    fc.assert(
      fc.property(guid, instant, digest, duration, fc.constantFrom('and', '\n', ' - '), (g, i, d, ms, sep) => {
        const text = ['id', g, 'at', i, 'sha', d, 'took', ms, 'on', 'http://localhost:3123/x'].join(sep === 'and' ? ' ' : sep);
        const out = applyScrubbers(text, ALL);
        expect(out).not.toContain(g);
        expect(out).not.toContain(i);
        expect(out).not.toContain(d);
        expect(out).not.toContain(ms);
        expect(out).not.toContain(':3123');
        expect(out).toContain('{duration}');
        expect(out).toContain('localhost:{port}');
      }),
      params(),
    );
    fc.assert(
      fc.property(fc.array(fc.constantFrom('hello', 'world', 'abc', '12', '2026', 'ms', 'T', '-', ':', ' ', '\n', 'localhost', 'x'), { maxLength: 20 }).map((p) => p.join('')), (text) => {
        // short digit runs, words and separators: no GUID, instant, digest, duration or loopback port can be formed
        fc.pre(!/\d+ms\b|:\d{2,5}\b|[0-9a-f]{8}-/i.test(text));
        expect(applyScrubbers(text, [guids(), instants(), digests()])).toBe(text);
      }),
      params(),
    );
  });

  it('paths() replaces every spelling of a directory (plain, forward and back slashes, JSON-escaped), longest directory first', () => {
    const seg = fc.stringMatching(/^[a-z][a-z0-9_-]{0,7}$/);
    fc.assert(
      fc.property(fc.array(seg, { minLength: 1, maxLength: 3 }), fc.array(seg, { maxLength: 3 }), (parts, tail) => {
        const root = `/${parts.join('/')}`;
        const inner = `${root}/${['inner', ...tail].join('/')}`;
        const scrub = paths({ root, inner });
        const forms = [inner, inner.replace(/\//g, '\\'), JSON.stringify(inner).slice(1, -1), `${root}/other.ts`, root];
        for (const f of forms) {
          const out = scrub(`file ${f} end`);
          expect(out).not.toContain(root);
          expect(scrub(out)).toBe(out);
        }
        // the longer directory wins over the shorter one it starts with
        expect(scrub(`${inner}/~tail.ts`)).toBe('{inner}/~tail.ts');
        expect(scrub(`${root}/~tail.ts`)).toBe('{root}/~tail.ts');
      }),
      params(),
    );
  });

  it('stays linear on long inputs (CPU budget)', () => {
    const shapes = ['a'.repeat(200_000), '0123456789abcdef'.repeat(20_000), '1ms '.repeat(40_000), 'localhost:'.repeat(30_000), `${'2026-10-10T10:00:00'.repeat(10_000)}`, '-'.repeat(100_000), '/work/project'.repeat(20_000)];
    for (const text of shapes) {
      const used = cpuMs(() => {
        applyScrubbers(text, ALL);
      });
      expect(used, text.slice(0, 12)).toBeLessThan(4000);
    }
  });
});

describe('fuzz: normalizeText / slug / snapshot file names', () => {
  it('normalizeText ends with exactly one newline, has LF endings, no trailing blanks, and is idempotent', () => {
    fc.assert(
      fc.property(fc.oneof(hostileString({ maxLength: 200 }), fc.string({ unit: 'binary', maxLength: 60 })), (text) => {
        const n = normalizeText(text);
        expect(n.endsWith('\n')).toBe(true);
        expect(n.endsWith('\n\n') && n.length > 2).toBe(false);
        expect(n).not.toContain('\r');
        for (const line of n.split('\n')) expect(line).not.toMatch(/[ \t]$/);
        expect(normalizeText(n)).toBe(n);
        // CRLF, CR and LF spellings of one text normalize alike
        const lf = text.replace(/\r\n?/g, '\n');
        expect(normalizeText(lf.replace(/\n/g, '\r\n'))).toBe(normalizeText(lf));
      }),
      params(),
    );
  });

  it('slug yields a non-empty [a-z0-9-] name within the limit, never starts or ends with "-", and is idempotent', () => {
    fc.assert(
      // max below 8 is meaningless: the fallback name "snapshot" is longer than that
      fc.property(hostileString({ maxLength: 200 }), fc.integer({ min: 8, max: 100 }), (text, max) => {
        const s = slug(text, max);
        expect(s).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
        expect(s.length).toBeLessThanOrEqual(max);
        expect(slug(s, max)).toBe(s);
      }),
      params(),
    );
  });

  it('snapshot files for hostile test names stay inside the directory and keep the verified/received pair side by side', () => {
    fc.assert(
      fc.property(hostileString({ maxLength: 120 }), fc.option(hostileString({ maxLength: 40 }), { nil: undefined }), (testName, name) => {
        const dir = '/project/test/__verified__';
        const f = snapshotFiles({ testPath: '/project/test/a.test.ts', testName }, { ...(name === undefined ? {} : { name }), directory: dir }, 'json');
        for (const file of [f.verified, f.received]) {
          expect(file.startsWith(`${dir}/`)).toBe(true);
          expect(file.slice(dir.length + 1)).not.toMatch(/[\\/]/);
        }
        expect(f.verified.replace('.verified.json', '')).toBe(f.received.replace('.received.json', ''));
      }),
      params(),
    );
  });
});

describe('fuzz: verifyValue approval round trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-bdd-fuzz-verify-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  let counter = 0;

  it('a value that was accepted verifies again; a different value does not; the received file only exists while they differ', () => {
    const value = fc.oneof(
      jsonValue({ maxDepth: 3, maxKeys: 4 }),
      volatileText,
      hostileString({ maxLength: 200 }),
      fc.uint8Array({ maxLength: 30 }),
      fc.array(fc.oneof(fc.string({ maxLength: 8 }), guid), { maxLength: 4 }).map((l) => ({ ids: l, when: new Date(0), tags: new Set(l), by: new Map(l.map((x, i) => [x, i])) })),
    );
    fc.assert(
      fc.property(value, value, (v, other) => {
        counter += 1;
        const ctx = (env: Record<string, string>) => ({ testPath: join(dir, 'x.test.ts'), testName: `case ${counter}`, env, root: dir });
        const files = () => readdirSync(dir).filter((f) => f.includes(`case-${counter}.`));
        // first run: no snapshot, so it fails and leaves a received file
        expect(() => verifyValue(ctx({}), v, { directory: dir })).toThrow(VerifyError);
        expect(files().some((f) => f.includes('.received.'))).toBe(true);
        // approving writes the verified file and removes the received one
        verifyValue(ctx({ VERIFY_ACCEPT: '1' }), v, { directory: dir });
        expect(files().some((f) => f.includes('.received.'))).toBe(false);
        expect(files().some((f) => f.includes('.verified.'))).toBe(true);
        // the same value verifies, whatever the environment
        verifyValue(ctx({}), v, { directory: dir });
        // a value with a different serialization is refused with a diff, and CI never accepts
        const same = JSON.stringify(readSnapshot(dir, counter)) === JSON.stringify(readSnapshotOf(other, dir, counter + 1_000_000));
        if (!same) {
          expect(() => verifyValue(ctx({}), other, { directory: dir })).toThrow(VerifyError);
          expect(() => verifyValue(ctx({ VERIFY_ACCEPT: '1', CI: 'true' }), other, { directory: dir })).toThrow(/ignored in CI/);
        }
      }),
      params({ scale: 0.3 }),
    );
  });
});

function readSnapshot(dir: string, n: number): string {
  const file = readdirSync(dir).find((f) => f.includes(`case-${n}.`) && f.includes('.verified.'));
  return file === undefined ? '' : readFileSync(join(dir, file), 'utf8');
}

/** The text `value` would be recorded as (accepting it under a scratch name). */
function readSnapshotOf(value: unknown, dir: string, n: number): string {
  try {
    verifyValue({ testPath: join(dir, 'x.test.ts'), testName: `case ${n}`, env: { VERIFY_ACCEPT: '1' }, root: dir }, value, { directory: dir });
  } catch {
    return '';
  }
  return readSnapshot(dir, n);
}
