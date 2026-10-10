// @ts-nocheck
import { describe } from 'vitest';
import { cuaUnavailableReason, playwrightUnavailableReason } from './targets.ts';

/** `describe` for real-browser tests: skipped with a visible reason when Chromium is not available (AI_BDD_REQUIRE_PW=1 forces them). */
export function describePlaywright(name: string, fn: () => void): void {
  const reason = playwrightUnavailableReason();
  describe.skipIf(reason !== null)(reason === null ? name : `${name} [SKIPPED: ${reason}]`, fn);
}

/** `describe` for the real Cua Driver (cua.ai) on a real desktop: skipped with a visible reason when the environment is not there. */
export function describeCua(name: string, fn: () => void): void {
  const reason = cuaUnavailableReason();
  describe.skipIf(reason !== null)(reason === null ? name : `${name} [SKIPPED: ${reason}]`, fn);
}
