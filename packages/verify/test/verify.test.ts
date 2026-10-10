import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VerifyError, acceptRequested, acceptReceived, findReceived, isCI, slug, snapshotFiles, stableStringify, serialize, verify, verifyJson, verifyValue } from '../src/index.ts';
import { run } from '../src/cli.ts';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-bdd-verify-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const ctx = (name = 'renders a thing', env: Record<string, string | undefined> = {}) => ({ testPath: path.join(dir, 'x.test.ts'), testName: name, env, root: dir });
const files = (name = 'renders a thing', ext = 'txt', opts = {}) => snapshotFiles(ctx(name), opts, ext);
const fail = (fn: () => void): VerifyError => {
  try {
    fn();
  } catch (e) {
    return e as VerifyError;
  }
  throw new Error('expected verify to throw');
};

describe('file naming', () => {
  it('lives next to the test in __verified__, named after file, test and optional name', () => {
    const f = snapshotFiles({ testPath: '/p/a/plan.test.ts', testName: 'Plan > keeps IDs stable!' }, { name: 'second one' }, 'json');
    expect(f.verified).toBe('/p/a/__verified__/plan.test.plan-keeps-ids-stable.second-one.verified.json');
    expect(f.received).toBe('/p/a/__verified__/plan.test.plan-keeps-ids-stable.second-one.received.json');
    expect(snapshotFiles({ testPath: '/p/a.mts', testName: 't' }, { directory: '/snap' }, 'txt').verified).toBe('/snap/a.t.verified.txt');
  });

  it('fileName keeps a fixture layout: <directory>/<fileName>.verified.<ext>', () => {
    const f = snapshotFiles({ testPath: '/p/a.test.ts', testName: 'whatever' }, { directory: '/g', fileName: 'case.chunks' }, 'json');
    expect(f).toEqual({ verified: '/g/case.chunks.verified.json', received: '/g/case.chunks.received.json' });
  });

  it('slug: lowercase words, bounded length, never empty', () => {
    expect(slug('Hello, World -- 2')).toBe('hello-world-2');
    expect(slug('x'.repeat(200))).toHaveLength(80);
    expect(slug('!!!')).toBe('snapshot');
    expect(slug('a'.repeat(79) + '-b')).toBe('a'.repeat(79));
  });
});

describe('approval flow', () => {
  it('a snapshot with no verified file fails, writes the received file and says how to approve', () => {
    const e = fail(() => verifyValue(ctx(), 'hello'));
    expect(e).toBeInstanceOf(VerifyError);
    expect(e.message).toContain('No verified snapshot yet');
    expect(e.message).toContain('pnpm verify:accept');
    expect(fs.readFileSync(files().received, 'utf8')).toBe('hello\n');
    expect(fs.existsSync(files().verified)).toBe(false);
  });

  it('accepting makes the next run pass and removes the received file', () => {
    fail(() => verifyValue(ctx(), 'hello'));
    expect(acceptReceived(findReceived(dir))).toEqual([files().verified]);
    verifyValue(ctx(), 'hello');
    expect(fs.existsSync(files().received)).toBe(false);
    expect(fs.readFileSync(files().verified, 'utf8')).toBe('hello\n');
  });

  it('a different value fails with a diff of verified (-) against received (+) and keeps the verified file untouched', () => {
    fs.mkdirSync(path.dirname(files().verified), { recursive: true });
    fs.writeFileSync(files().verified, 'one\ntwo\nthree\n');
    const e = fail(() => verifyValue(ctx(), 'one\n2\nthree'));
    expect(e.message).toContain('Snapshot mismatch');
    expect(e.message).toContain('-two\n+2');
    expect(fs.readFileSync(files().verified, 'utf8')).toBe('one\ntwo\nthree\n');
    expect(fs.readFileSync(files().received, 'utf8')).toBe('one\n2\nthree\n');
  });

  it('a stale received file is removed when the output matches again', () => {
    fs.mkdirSync(path.dirname(files().verified), { recursive: true });
    fs.writeFileSync(files().verified, 'same\n');
    fs.writeFileSync(files().received, 'stale\n');
    verifyValue(ctx(), 'same');
    expect(fs.existsSync(files().received)).toBe(false);
  });

  it('line endings and trailing blanks do not matter (a Windows checkout of the verified file still matches)', () => {
    fs.mkdirSync(path.dirname(files().verified), { recursive: true });
    fs.writeFileSync(files().verified, 'a  \r\nb\r\n');
    verifyValue(ctx(), 'a\nb\n\n');
  });

  it('VERIFY_ACCEPT=1 approves new and changed output locally', () => {
    verifyValue(ctx('t', { VERIFY_ACCEPT: '1' }), 'v1');
    expect(fs.readFileSync(files('t').verified, 'utf8')).toBe('v1\n');
    verifyValue(ctx('t', { VERIFY_ACCEPT: '1' }), 'v2');
    expect(fs.readFileSync(files('t').verified, 'utf8')).toBe('v2\n');
    expect(fs.existsSync(files('t').received)).toBe(false);
  });

  it('...but never in CI: approval is refused instead of silently rewriting the expectation', () => {
    const e = fail(() => verifyValue(ctx('t', { VERIFY_ACCEPT: '1', CI: 'true' }), 'v1'));
    expect(e.message).toContain('ignored in CI');
    expect(fs.existsSync(files('t').verified)).toBe(false);
    expect(isCI({ CI: 'true' })).toBe(true);
    expect(isCI({ CI: '1' })).toBe(true);
    expect(isCI({ CI: '0' })).toBe(false);
    expect(isCI({ CI: 'false' })).toBe(false);
    expect(isCI({ CI: '' })).toBe(false);
    expect(isCI({})).toBe(false);
    expect(acceptRequested({ VERIFY_ACCEPT: '1' })).toBe(true);
    expect(acceptRequested({ VERIFY_ACCEPT: 'yes' })).toBe(false);
  });

  it('two snapshots in one test need distinct names; the same name from the same test is fine', () => {
    verifyValue(ctx('multi', { VERIFY_ACCEPT: '1' }), 'a', { name: 'first' });
    verifyValue(ctx('multi', { VERIFY_ACCEPT: '1' }), 'b', { name: 'second' });
    expect(fs.readFileSync(files('multi', 'txt', { name: 'first' }).verified, 'utf8')).toBe('a\n');
    expect(fs.readFileSync(files('multi', 'txt', { name: 'second' }).verified, 'utf8')).toBe('b\n');
    verifyValue(ctx('multi'), 'a', { name: 'first' });
  });

  it('two different tests that slug to the same file are an error, not a shared snapshot', () => {
    verifyValue(ctx('Same Name!', { VERIFY_ACCEPT: '1' }), 'a');
    const e = fail(() => verifyValue(ctx('same name?', { VERIFY_ACCEPT: '1' }), 'a'));
    expect(e.message).toContain('map to the same snapshot file');
  });
});

describe('content', () => {
  it('objects are stable JSON with sorted keys; scrubbers and defaults apply', () => {
    const value = { z: 1, a: { id: '0190a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b', at: '2026-10-10T10:00:00Z', file: `${dir}/x.ts` }, list: [new Set([1]), new Map([['k', 1]])] };
    verifyValue(ctx('obj', { VERIFY_ACCEPT: '1' }), value, { scrubbers: [(t) => t.replace('"z": 1', '"z": "scrubbed"')] });
    expect(fs.readFileSync(files('obj', 'json').verified, 'utf8')).toBe(
      ['{', '  "a": {', '    "at": "Instant_1",', '    "file": "{root}/x.ts",', '    "id": "Guid_1"', '  },', '  "list": [', '    [', '      1', '    ],', '    {', '      "k": 1', '    }', '  ],', '  "z": "scrubbed"', '}', ''].join('\n'),
    );
  });

  it('scrubDefaults: false leaves ids alone', () => {
    verifyValue(ctx('raw', { VERIFY_ACCEPT: '1' }), '2026-10-10T10:00:00Z', { scrubDefaults: false });
    expect(fs.readFileSync(files('raw').verified, 'utf8')).toBe('2026-10-10T10:00:00Z\n');
  });

  it('binary snapshots compare bytes', () => {
    verifyValue(ctx('bin', { VERIFY_ACCEPT: '1' }), new Uint8Array([1, 2, 3]));
    verifyValue(ctx('bin'), new Uint8Array([1, 2, 3]));
    const e = fail(() => verifyValue(ctx('bin'), new Uint8Array([1, 2, 4])));
    expect(e.message).toContain('binary snapshot differs (3 -> 3 bytes)');
    expect(Array.from(fs.readFileSync(files('bin', 'bin').received))).toEqual([1, 2, 4]);
  });

  // Found by tests/fuzz/verify-serialize.test.ts.
  it('an own "__proto__" key is kept as data (it used to set the prototype of the copy and vanish)', () => {
    const payload = JSON.parse('{"__proto__":{"admin":true},"a":1}') as unknown;
    expect(JSON.parse(stableStringify(payload))).toEqual(payload);
    expect(stableStringify(payload)).toContain('"__proto__": {\n    "admin": true\n  }');
    expect(stableStringify(new Map([['__proto__', 1]]))).toContain('"__proto__": 1');
  });

  it('a Map is not lossy: keys that stringify alike stay apart, and string keys sort like object keys (not by locale)', () => {
    expect(stableStringify(new Map<unknown, number>([[{ a: 1 }, 1], [{ a: 2 }, 2]]))).toBe(JSON.stringify([[{ a: 1 }, 1], [{ a: 2 }, 2]], null, 2));
    expect(stableStringify(new Map<unknown, string>([[1, 'number'], ['1', 'string']]))).toBe(JSON.stringify([['1', 'string'], [1, 'number']], null, 2));
    expect(Object.keys(JSON.parse(stableStringify(new Map([['b', 1], ['B', 2], ['a', 3]]))) as object)).toEqual(['B', 'a', 'b']);
  });

  it('serialization covers odd values without losing the difference between them', () => {
    expect(stableStringify({ u: undefined, n: Number.NaN, i: Infinity, b: 10n, d: new Date(0), bad: new Date(Number.NaN), e: new TypeError('boom'), f() {}, bytes: new Uint8Array([255]) })).toBe(
      JSON.stringify({ b: '10n', bad: '[invalid date]', bytes: '[bytes 1: ff]', d: '1970-01-01T00:00:00.000Z', e: { name: 'TypeError', message: 'boom' }, f: '[function]', i: 'Infinity', n: 'NaN', u: '[undefined]' }, null, 2),
    );
    const cyc: Record<string, unknown> = { a: 1 };
    cyc['self'] = cyc;
    expect(stableStringify(cyc)).toContain('"self": "[circular]"');
    expect(stableStringify({ big: new Uint8Array(40) })).toContain('...]');
    expect(serialize('s').extension).toBe('txt');
    expect(serialize(new Uint8Array(1)).extension).toBe('bin');
    expect(serialize({}, 'md').extension).toBe('md');
    expect(serialize(Symbol('x')).text).toBe('"[symbol]"');
  });
});

describe('vitest integration (verify() snapshots itself)', () => {
  it('strings', async () => {
    await verify('line one\nline two');
  });

  it('structured values, two snapshots in one test', async () => {
    await verify({ b: [1, 2, { c: null }], a: 'x' });
    await verifyJson('already text', { name: 'as json' });
  });

  it('the failure message of a changed snapshot is itself stable', async () => {
    const v = fs.mkdtempSync(path.join(dir, 'v-'));
    const inner = { testPath: path.join(v, 'x.test.ts'), testName: 'inner', env: {}, root: v };
    fs.writeFileSync(snapshotFiles(inner, { directory: v }, 'txt').verified, 'a\nb\nc\n');
    const message = fail(() => verifyValue(inner, 'a\nB\nc', { directory: v })).message;
    const shown = path.relative(process.cwd(), v);
    await verify(message.split(shown).join('{dir}'));
  });
});

describe('cli', () => {
  const out: string[] = [];
  const log = { log: (m: unknown) => out.push(String(m)), error: (m: unknown) => out.push(String(m)) };
  beforeEach(() => {
    out.length = 0;
  });

  it('list and check report received files; check fails when there are any', () => {
    expect(run(['check', dir], log)).toBe(0);
    fs.mkdirSync(path.join(dir, 'sub', '__verified__'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sub', '__verified__', 'a.received.txt'), 'x');
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'node_modules', 'b.received.txt'), 'ignored');
    expect(run(['list', dir], log)).toBe(0);
    expect(out.join('\n')).toContain('a.received.txt');
    expect(out.join('\n')).not.toContain('b.received.txt');
    expect(run(['check', dir], log)).toBe(1);
    expect(out.join('\n')).toContain('1 snapshot(s) differ');
  });

  it('accept approves everything and says so; with nothing to approve it says that', () => {
    fs.writeFileSync(path.join(dir, 'a.received.json'), '{}');
    expect(run(['accept', dir], log)).toBe(0);
    expect(fs.existsSync(path.join(dir, 'a.verified.json'))).toBe(true);
    expect(out.join('\n')).toContain('approved');
    out.length = 0;
    run(['accept', dir], log);
    expect(out).toEqual(['nothing to approve']);
  });

  it('unknown commands print usage and fail; --help succeeds', () => {
    expect(run(['bogus'], log)).toBe(2);
    expect(run(['--help'], log)).toBe(0);
    expect(run([], log)).toBe(0);
    expect(out.join('\n')).toContain('ai-bdd-verify <command>');
  });
});
