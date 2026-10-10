// @ts-nocheck
import { stableStringify } from './serialize.ts';
import { verifyValue } from './verify.ts';
import type { VerifyOptions } from './verify.ts';

/**
 * Verify `value` against the committed snapshot of the running vitest test:
 *
 *   it('renders the plan', async () => { await verify(plan); });
 *
 * Files are `__verified__/<test file>.<test name>[.<name>].verified.<ext>` next to the test.
 */
export async function verify(value: unknown, opts: VerifyOptions = {}): Promise<void> {
  const { expect } = await import('vitest');
  const state = expect.getState();
  if (state.testPath === undefined || state.currentTestName === undefined) throw new Error('verify() must be called inside a running vitest test');
  verifyValue({ testPath: state.testPath, testName: state.currentTestName }, value, opts);
}

/** Same as `verify`, forcing a `json` snapshot (a string becomes a JSON string). */
export async function verifyJson(value: unknown, opts: VerifyOptions = {}): Promise<void> {
  await verify(stableStringify(value), { ...opts, extension: opts.extension ?? 'json' });
}
