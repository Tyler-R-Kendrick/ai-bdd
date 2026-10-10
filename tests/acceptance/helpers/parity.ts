import { describe } from 'vitest';
import { playwrightUnavailableReason } from './targets.ts';

/** `describe` for real-browser tests: skipped with a visible reason when Chromium is not available (AI_BDD_REQUIRE_PW=1 forces them). */
export function describePlaywright(name: string, fn: () => void): void {
  const reason = playwrightUnavailableReason();
  describe.skipIf(reason !== null)(reason === null ? name : `${name} [SKIPPED: ${reason}]`, fn);
}
