import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import fc from 'fast-check';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ExitCode, ResolvedConfig } from '@ai-bdd/sdk/contracts';
import { AiBddError } from '@ai-bdd/sdk/contracts';
import { hostileString, params } from './helpers.ts';
import { makeConfig, makeEngine } from '../../packages/cli/test/helpers.ts';
import { main } from '../../packages/cli/src/main.ts';
import { REPORTER_NAMES, isCiEnv, parseReporters, parseWorkers, splitList } from '../../packages/cli/src/parse.ts';
import { exitCodeForError, describeError } from '../../packages/cli/src/exit.ts';

const root = mkdtempSync(join(tmpdir(), 'ai-bdd-fuzz-cli-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const COMMANDS = ['init', 'compile', 'status', 'show', 'review', 'run', 'verify-run', 'prune', 'doctor', 'help'];
const OPTIONS = [
  '--help', '-h', '-V', '--version', '-c', '--config', '--json', '--yes', '--full', '--dry-run', '--check', '--recordings', '--tag', '--grep', '--driver', '--frozen', '--no-compile',
  '--strict', '-u', '--update-recordings', '--no-agent', '--audit', '--workers', '--reporter', '--offline', '--', '-', '--unknown', '-x', '-vv', '--tag=a,b', '--workers=0', '--workers=-1',
  '--workers=2', '--reporter=json,junit', '--reporter=xml', '--config=', '--no-', '--no-json', '---', '-abc',
];
const ACTIONS = ['accept', 'reject', 'pin', 'unpin', 'Accept', 'delete', ''];

const token = fc.oneof(
  { weight: 5, arbitrary: fc.constantFrom(...COMMANDS) },
  { weight: 6, arbitrary: fc.constantFrom(...OPTIONS) },
  { weight: 2, arbitrary: fc.constantFrom(...ACTIONS) },
  { weight: 3, arbitrary: hostileString({ maxLength: 40 }) },
  { weight: 1, arbitrary: fc.constantFrom('1', '0', '-1', '3', '1.5', '1e3', '99999999999999999999', ' 2 ', 'NaN', '', '../..', '/etc/passwd', 'docs/**/*.md', 'a'.repeat(5000), '\0', '\u202e', '😀') },
  { weight: 1, arbitrary: fc.string({ unit: 'binary', maxLength: 30 }) },
  { weight: 1, arbitrary: fc.uint8Array({ maxLength: 20 }).map((b) => Buffer.from(b).toString('latin1')) },
  { weight: 1, arbitrary: fc.uint8Array({ maxLength: 20 }).map((b) => Buffer.from(b).toString('utf8')) },
);

// `init` writes into the working directory: every case gets its own scratch directory, removed afterwards.
let counter = 0;
async function run(argv: string[], env: Record<string, string | undefined> = {}): Promise<{ code: ExitCode; stdout: string; stderr: string; files: string[]; engineCalls: number }> {
  counter += 1;
  const cwd = join(root, `case-${counter}`);
  const { mkdirSync } = await import('node:fs');
  mkdirSync(cwd, { recursive: true });
  let stdout = '';
  let stderr = '';
  const config: ResolvedConfig = makeConfig({ projectRoot: cwd });
  const engine = makeEngine(config);
  const code = await main(
    argv,
    { stdout: { write: (s: string) => (stdout += s) }, stderr: { write: (s: string) => (stderr += s) }, env, cwd },
    { loadConfig: vi.fn(async () => config), createEngine: vi.fn(async () => engine), nodeVersion: '22.18.0' },
  );
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      files.push(relative(cwd, p));
      if (statSync(p).isDirectory()) walk(p);
    }
  };
  walk(cwd);
  rmSync(cwd, { recursive: true, force: true });
  const calls = Object.values(engine as unknown as Record<string, { mock?: { calls: unknown[] } }>).reduce((n, f) => n + (f?.mock?.calls.length ?? 0), 0);
  return { code, stdout, stderr, files, engineCalls: calls };
}

const CODES: ExitCode[] = [0, 1, 2, 3, 4];

describe('fuzz: CLI argument handling (in process)', () => {
  it('returns a defined exit code for any argument vector and never throws', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(token, { maxLength: 8 }), async (argv) => {
        const r = await run(argv);
        expect(CODES, `argv ${JSON.stringify(argv)} -> ${r.code}\n${r.stderr}`).toContain(r.code);
        expect(typeof r.stdout).toBe('string');
        expect(typeof r.stderr).toBe('string');
        // nothing but init's documented outputs is ever created in the working directory
        for (const f of r.files) expect(f, `unexpected file ${f} for ${JSON.stringify(argv)}`).toMatch(/^(ai-bdd\.config\.(ts|json)|docs(\/example\.md)?|\.gitignore|\.ai-bdd(\/plans)?)$/);
      }),
      params({ scale: 0.8 }),
    );
  });

  it('survives random bytes as arguments, including NUL, lone surrogates and very long values', async () => {
    const bytes = fc.oneof(fc.string({ unit: 'binary', maxLength: 60 }), hostileString({ maxLength: 200 }), fc.constantFrom('a'.repeat(100_000), '\0'.repeat(50), '-'.repeat(10_000), '\ud800'));
    await fc.assert(
      fc.asyncProperty(fc.array(bytes, { minLength: 1, maxLength: 4 }), fc.constantFrom('', 'run', 'show', 'review', 'verify-run', 'compile'), async (args, cmd) => {
        const r = await run(cmd === '' ? args : [cmd, ...args]);
        expect(CODES).toContain(r.code);
      }),
      params({ scale: 0.5 }),
    );
  });

  it('an unknown command or option is a usage error (exit 2) that names what was wrong and does not touch the engine', async () => {
    const bogus = hostileString({ maxLength: 20 }).filter((s) => !COMMANDS.includes(s) && !s.startsWith('-') && s.trim() !== '' && !/^\s/.test(s));
    await fc.assert(
      fc.asyncProperty(bogus, async (cmd) => {
        const r = await run([cmd]);
        expect(r.code, `${JSON.stringify(cmd)}\n${r.stderr}`).toBe(2);
        expect(r.stderr.length).toBeGreaterThan(0);
        expect(r.engineCalls).toBe(0);
      }),
      params({ scale: 0.5 }),
    );
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('status', 'show', 'compile', 'run', 'prune', 'doctor', 'init'), fc.stringMatching(/^--[a-z]{6,12}$/), async (cmd, flag) => {
        fc.pre(!OPTIONS.includes(flag));
        const r = await run([cmd, flag]);
        expect(r.code).toBe(2);
        expect(r.engineCalls).toBe(0);
      }),
      params({ scale: 0.5 }),
    );
  });

  it('--workers accepts exactly the positive decimal integers, and everything else is exit 2 before the engine is touched', async () => {
    const value = fc.oneof(fc.integer({ min: -3, max: 12 }).map(String), fc.constantFrom('', ' ', ' 4 ', '04', '4.0', '1e2', '0x4', '٤', '+4', '4abc', 'NaN', '99999999999999999999'), hostileString({ maxLength: 8 }));
    await fc.assert(
      fc.asyncProperty(value, async (v) => {
        const r = await run(['run', '--workers', v]);
        const valid = /^[1-9]\d*$/.test(v.trim());
        if (valid) expect(r.code, `${JSON.stringify(v)}\n${r.stderr}`).toBe(0);
        else {
          expect(r.code, `${JSON.stringify(v)}\n${r.stderr}`).toBe(2);
          expect(r.engineCalls).toBe(0);
        }
      }),
      params({ scale: 0.6 }),
    );
  });

  it('review needs one of accept/reject/pin/unpin and at least one id; anything else is exit 2', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...ACTIONS, 'accept'), fc.array(hostileString({ maxLength: 12 }).filter((s) => !s.startsWith('-')), { maxLength: 3 }), async (action, ids) => {
        const r = await run(['review', action, ...ids]);
        const ok = ['accept', 'reject', 'pin', 'unpin'].includes(action) && ids.length > 0;
        expect(r.code === 0, `${action} ${JSON.stringify(ids)} -> ${r.code}\n${r.stderr}`).toBe(ok);
        if (!ok) expect(r.code).toBe(2);
      }),
      params({ scale: 0.6 }),
    );
  });

  it('secrets known to the CLI never reach the terminal, whatever the command prints', async () => {
    const secret = 'Zq9-hunter2-ZQ';
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('status', 'show', 'doctor', 'prune', 'compile'), async (cmd) => {
        counter += 1;
        const cwd = join(root, `secret-${counter}`);
        let out = '';
        const config = makeConfig({ projectRoot: cwd, secrets: { pw: { env: 'PW' } } });
        const engine = makeEngine(config, { doctor: vi.fn(async () => ({ ok: false, checks: [{ name: 'x', ok: false, detail: `bad ${secret}` }] })), status: vi.fn(async () => { throw new Error(`boom ${secret}`); }) });
        const code = await main([cmd], { stdout: { write: (s: string) => (out += s) }, stderr: { write: (s: string) => (out += s) }, env: { PW: secret }, cwd }, { loadConfig: vi.fn(async () => config), createEngine: vi.fn(async () => engine), nodeVersion: '22.18.0' });
        expect(CODES).toContain(code);
        expect(out).not.toContain(secret);
      }),
      params({ scale: 0.3 }),
    );
  });
});

describe('fuzz: CLI parsing helpers', () => {
  it('splitList returns trimmed, non-empty, unique names in order of first appearance, none containing a comma', () => {
    fc.assert(
      fc.property(fc.option(fc.array(fc.oneof(fc.string({ maxLength: 10 }), hostileString({ maxLength: 20 }), fc.constantFrom('a,b', ' a , b ', ',', ',,a', 'a,,b,a')), { maxLength: 6 }), { nil: undefined }), (values) => {
        const out = splitList(values);
        expect(new Set(out).size).toBe(out.length);
        for (const n of out) {
          expect(n).toBe(n.trim());
          expect(n).not.toBe('');
          expect(n).not.toContain(',');
        }
        const expected: string[] = [];
        for (const v of values ?? []) for (const part of v.split(',')) if (part.trim() !== '' && !expected.includes(part.trim())) expected.push(part.trim());
        expect(out).toEqual(expected);
      }),
      params(),
    );
  });

  it('parseReporters accepts only json/junit/markdown and otherwise throws AiBddError(USAGE)', () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(fc.constantFrom(...REPORTER_NAMES, 'json,junit', ' markdown ', 'xml', 'JSON', ''), hostileString({ maxLength: 12 })), { maxLength: 4 }), (values) => {
        try {
          const names = parseReporters(values);
          for (const n of names) expect(REPORTER_NAMES).toContain(n);
        } catch (e) {
          expect(e instanceof AiBddError && e.code === 'USAGE', String(e)).toBe(true);
          expect(exitCodeForError(e)).toBe(2);
        }
      }),
      params(),
    );
  });

  it('parseWorkers and isCiEnv agree with their specification on any string', () => {
    fc.assert(
      fc.property(fc.oneof(hostileString({ maxLength: 12 }), fc.integer({ min: -5, max: 5 }).map(String), fc.constantFrom('1', ' 1 ', 'true', 'TRUE', ' 1', '1 ', '0', 'yes', '')), (v) => {
        if (/^[1-9]\d*$/.test(v.trim())) expect(parseWorkers(v)).toBe(Number.parseInt(v, 10));
        else expect(() => parseWorkers(v)).toThrow(AiBddError);
        expect(isCiEnv({ CI: v })).toBe(['true', '1'].includes(v.trim().toLowerCase()));
        expect(isCiEnv({})).toBe(false);
      }),
      params(),
    );
  });

  it('describeError / exitCodeForError never throw and map foreign errors to infrastructure (3), never to a function or undefined', () => {
    const errors = fc.oneof(
      hostileString({ maxLength: 20 }).map((m) => new Error(m)),
      fc.constantFrom('constructor', '__proto__', 'toString', 'USAGE', 'NOPE', 'ABORTED').map((code) => Object.assign(new Error('forged'), { name: 'AiBddError', code })),
      fc.constantFrom(null, undefined, 0, 'str', {}, [], Symbol('s') as unknown, () => 1),
    );
    fc.assert(
      fc.property(errors, fc.boolean(), (e, debug) => {
        expect(typeof describeError(e, debug)).toBe('string');
        expect(CODES).toContain(exitCodeForError(e));
      }),
      params(),
    );
  });
});
