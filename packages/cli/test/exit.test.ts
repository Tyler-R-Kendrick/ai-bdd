import { describe, expect, it, vi } from 'vitest';
import { AiBddError, ERROR_CODES, type ErrorCode, type ExitCode } from '@ai-bdd/sdk/contracts';
import { EXIT_BY_ERROR_CODE, asAiBddError, describeError, exitCodeForError, hasErrorCode } from '../src/exit.ts';
import { runCli } from './helpers.ts';

/**
 * The documented mapping (docs/cli.md "Exit codes", R-RN3), spelled out independently of the production table so that a
 * changed entry is caught. Typed as a full `Record<ErrorCode, ExitCode>`: adding an error code forces a decision here too.
 */
const DOCUMENTED: Record<ErrorCode, ExitCode> = {
  USAGE: 2,
  CONFIG_INVALID: 2,
  CONFIG_NOT_FOUND: 2,
  CONFIG_TS_UNSUPPORTED: 2,
  SECRET_MISSING: 2,
  SECRET_TOO_SHORT: 2,
  DOC_READ_FAILED: 2,
  DOC_CHUNK_TOO_LARGE: 2,
  DIRECTIVE_INVALID: 2,
  DIRECTIVE_UNKNOWN_KEY: 2,
  EXTRACT_MODEL_OUTPUT_INVALID: 1,
  EXTRACT_UNGROUNDED: 1,
  EXTRACT_QUOTE_NOT_FOUND: 1,
  EXTRACT_FIXTURE_INVALID: 1,
  EXTRACT_SECTION_FAILED: 1,
  PLAN_STALE: 4,
  PLAN_CORRUPT: 2,
  PLAN_SCHEMA_UNSUPPORTED: 2,
  PLAN_PINNED_STALE: 1,
  PLAN_CONTEXT_CHANGED: 1,
  SCENARIO_NOT_FOUND: 2,
  FIXTURE_REQUIRED: 1,
  FIXTURE_FAILED: 1,
  ACT_BUDGET_EXHAUSTED: 1,
  ACT_BLOCKED: 1,
  ACT_TARGET_AMBIGUOUS: 1,
  ACT_NO_AGENT: 1,
  REPLAY_DIVERGED: 1,
  CHARACTERIZATION_UNSTABLE: 1,
  CHECK_FAILED: 1,
  CHECK_NOT_DISCRIMINATIVE: 1,
  CHECK_LINT_FAILED: 1,
  CHECK_GENERATION_FAILED: 1,
  CHECK_JUDGE_DISAGREEMENT: 1,
  JUDGE_FAILED: 1,
  JUDGE_INCONCLUSIVE: 1,
  JUDGE_SAME_AS_ACTOR: 2,
  SCREEN_NOT_SETTLED: 1,
  DRIVER_UNAVAILABLE: 3,
  DRIVER_ERROR: 3,
  STALE_REF: 3,
  TARGET_NOT_FOUND: 3,
  POLICY_DENIED: 2,
  PIXEL_TAINTED: 3,
  SESSION_LIMIT: 3,
  VERB_UNSUPPORTED: 3,
  MODEL_UNAVAILABLE: 3,
  MODEL_OUTPUT_INVALID: 3,
  MODEL_NO_RULE: 3,
  RECORDING_CORRUPT: 2,
  RECORDING_READ_ONLY: 2,
  EVIDENCE_CORRUPT: 1,
  NOT_IMPLEMENTED: 3,
  INTERNAL: 3,
  ABORTED: 3,
};

/** An error from a second copy of the contracts module: same shape and name, but not `instanceof` our AiBddError. */
class ForeignAiBddError extends Error {
  override name = 'AiBddError';
  constructor(readonly code: unknown, message: string) {
    super(message);
  }
}

describe('exit.ts: error code to exit code (R-RN3)', () => {
  it('covers every ERROR_CODES entry and nothing else', () => {
    expect(Object.keys(EXIT_BY_ERROR_CODE).sort()).toEqual([...ERROR_CODES].sort());
    expect(Object.keys(DOCUMENTED).sort()).toEqual([...ERROR_CODES].sort());
  });

  it.each(ERROR_CODES.map((c) => [c, DOCUMENTED[c]] as const))('exitCodeForError(AiBddError %s) = %i', (code, exit) => {
    expect(exitCodeForError(new AiBddError(code, 'x'))).toBe(exit);
    expect(EXIT_BY_ERROR_CODE[code]).toBe(exit);
  });

  it('uses all four non-zero exit codes and never maps an error to 0', () => {
    expect(new Set(Object.values(EXIT_BY_ERROR_CODE))).toEqual(new Set([1, 2, 3, 4]));
  });

  it('PLAN_STALE is the only frozen-violation code (4)', () => {
    expect(ERROR_CODES.filter((c) => EXIT_BY_ERROR_CODE[c] === 4)).toEqual(['PLAN_STALE']);
  });

  it('a foreign-module AiBddError (same name, known code) maps like the real one', () => {
    expect(exitCodeForError(new ForeignAiBddError('PLAN_STALE', 'stale'))).toBe(4);
    expect(exitCodeForError(new ForeignAiBddError('CONFIG_INVALID', 'bad'))).toBe(2);
    expect(exitCodeForError(new ForeignAiBddError('CHECK_FAILED', 'bad'))).toBe(1);
  });

  it.each([
    ['a plain Error', new Error('boom')],
    ['a TypeError', new TypeError('boom')],
    ['a string', 'boom'],
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['a plain object shaped like an error', { name: 'AiBddError', code: 'PLAN_STALE', message: 'x' }],
    ['an Error named AiBddError with an unknown code', new ForeignAiBddError('NOT_A_CODE', 'x')],
    ['an Error named AiBddError with a non-string code', new ForeignAiBddError(4, 'x')],
    ['an Error named AiBddError without a code', Object.assign(new Error('x'), { name: 'AiBddError' })],
    ['an Error with a valid code but another name', Object.assign(new Error('x'), { code: 'PLAN_STALE' })],
  ])('exitCodeForError(%s) is the infrastructure code 3', (_label, value) => {
    expect(asAiBddError(value)).toBeUndefined();
    expect(exitCodeForError(value)).toBe(3);
  });

  it('asAiBddError returns the very same object for real and foreign AiBddErrors', () => {
    const real = new AiBddError('USAGE', 'x');
    const foreign = new ForeignAiBddError('USAGE', 'x');
    expect(asAiBddError(real)).toBe(real);
    expect(asAiBddError(foreign)).toBe(foreign);
  });

  it('a code that is only an inherited Object property (e.g. "toString") is not a known code', () => {
    expect(asAiBddError(new ForeignAiBddError('toString', 'x'))).toBeUndefined();
    expect(exitCodeForError(new ForeignAiBddError('constructor', 'x'))).toBe(3);
  });

  it('hasErrorCode matches only the given code, for real and foreign errors', () => {
    expect(hasErrorCode(new AiBddError('CONFIG_NOT_FOUND', 'x'), 'CONFIG_NOT_FOUND')).toBe(true);
    expect(hasErrorCode(new AiBddError('CONFIG_NOT_FOUND', 'x'), 'CONFIG_INVALID')).toBe(false);
    expect(hasErrorCode(new ForeignAiBddError('EVIDENCE_CORRUPT', 'x'), 'EVIDENCE_CORRUPT')).toBe(true);
    expect(hasErrorCode(new Error('x'), 'EVIDENCE_CORRUPT')).toBe(false);
    expect(hasErrorCode('EVIDENCE_CORRUPT', 'EVIDENCE_CORRUPT')).toBe(false);
    expect(hasErrorCode(undefined, 'USAGE')).toBe(false);
  });
});

describe('exit.ts: describeError', () => {
  it('renders an AiBddError as "error [CODE]: message" without a stack, even in debug mode', () => {
    const e = new AiBddError('PLAN_STALE', 'docs/a.md is stale');
    expect(describeError(e, false)).toBe('ai-bdd: error [PLAN_STALE]: docs/a.md is stale');
    expect(describeError(e, true)).toBe('ai-bdd: error [PLAN_STALE]: docs/a.md is stale');
  });

  it('renders a foreign AiBddError like a real one', () => {
    expect(describeError(new ForeignAiBddError('DRIVER_ERROR', 'crashed'), false)).toBe('ai-bdd: error [DRIVER_ERROR]: crashed');
  });

  it('renders an unexpected Error as "internal error" and appends the stack only in debug mode', () => {
    const e = new RangeError('out of range');
    e.stack = 'RangeError: out of range\n    at fake (file.ts:1:1)';
    expect(describeError(e, false)).toBe('ai-bdd: internal error: out of range');
    expect(describeError(e, true)).toBe('ai-bdd: internal error: out of range\nRangeError: out of range\n    at fake (file.ts:1:1)');
  });

  it('omits the stack suffix when an Error has no stack, even in debug mode', () => {
    const e = new Error('no stack here');
    delete e.stack;
    expect(describeError(e, true)).toBe('ai-bdd: internal error: no stack here');
  });

  it('stringifies non-Error values and never prints a stack for them', () => {
    expect(describeError('plain string', true)).toBe('ai-bdd: internal error: plain string');
    expect(describeError(404, false)).toBe('ai-bdd: internal error: 404');
    expect(describeError(null, true)).toBe('ai-bdd: internal error: null');
    expect(describeError({ message: 'obj' }, true)).toBe('ai-bdd: internal error: [object Object]');
  });
});

describe('exit.ts: end to end through main (R-RN3)', () => {
  const throwing = (e: unknown) => ({ status: vi.fn(async () => { throw e; }) });

  it('an AiBddError thrown by a command prints "error [CODE]" on stderr, nothing on stdout, and returns the mapped exit code', async () => {
    const h = await runCli(['status'], { engine: throwing(new AiBddError('PLAN_CORRUPT', 'plan x.plan.json is not valid JSON')) });
    expect(h.code).toBe(2);
    expect(h.stderr).toBe('ai-bdd: error [PLAN_CORRUPT]: plan x.plan.json is not valid JSON\n');
    expect(h.stdout).toBe('');
    expect(h.engine.close).toHaveBeenCalledOnce();
  });

  it('an unknown Error is exit 3 "internal error" and hides the stack unless AI_BDD_DEBUG=1', async () => {
    const e = new TypeError('cannot read x');
    e.stack = 'TypeError: cannot read x\n    at secret (internal.ts:9:9)';
    const quiet = await runCli(['status'], { engine: throwing(e) });
    expect(quiet.code).toBe(3);
    expect(quiet.stderr).toBe('ai-bdd: internal error: cannot read x\n');

    const debug = await runCli(['status'], { engine: throwing(e), env: { AI_BDD_DEBUG: '1' } });
    expect(debug.code).toBe(3);
    expect(debug.stderr).toBe('ai-bdd: internal error: cannot read x\nTypeError: cannot read x\n    at secret (internal.ts:9:9)\n');
  });

  it('only the exact value AI_BDD_DEBUG=1 turns on stack traces', async () => {
    const e = new Error('nope');
    e.stack = 'Error: nope\n    at x (y.ts:1:1)';
    for (const value of ['0', 'true', '', undefined]) {
      const h = await runCli(['status'], { engine: throwing(e), env: { AI_BDD_DEBUG: value } });
      expect(h.stderr).toBe('ai-bdd: internal error: nope\n');
    }
  });

  it('a thrown non-Error value is exit 3, stringified, without a stack even with AI_BDD_DEBUG=1', async () => {
    const h = await runCli(['status'], { engine: throwing('just a string'), env: { AI_BDD_DEBUG: '1' } });
    expect(h.code).toBe(3);
    expect(h.stderr).toBe('ai-bdd: internal error: just a string\n');
  });

  it('abort (SIGINT) surfaces as ABORTED, exit 3, and the engine is still closed', async () => {
    const ac = new AbortController();
    const run = vi.fn(async (opts: { signal?: AbortSignal }) => {
      ac.abort();
      if (opts.signal?.aborted) throw new AiBddError('ABORTED', 'run aborted by signal');
      throw new Error('signal was not forwarded');
    });
    const h = await runCli(['run'], { engine: { run: run as never }, deps: { signal: ac.signal } });
    expect(h.code).toBe(3);
    expect(h.stderr).toBe('ai-bdd: error [ABORTED]: run aborted by signal\n');
    expect(h.engine.close).toHaveBeenCalledOnce();
  });

  it('a foreign-module AiBddError from the engine keeps its mapped exit code through main', async () => {
    const h = await runCli(['status'], { engine: throwing(new ForeignAiBddError('PLAN_STALE', 'frozen')) });
    expect(h.code).toBe(4);
    expect(h.stderr).toBe('ai-bdd: error [PLAN_STALE]: frozen\n');
  });
});
