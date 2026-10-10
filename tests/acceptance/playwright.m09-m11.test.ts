import { beforeAll, expect, it } from 'vitest';
import { statusSummary } from './helpers/engine.ts';
import {
  expectBugAfterRecording,
  expectBugFirstRun,
  expectHeal,
  flowBugAfterRecording,
  flowBugFirstRun,
  flowHeal,
  type BugAfterRecording,
  type BugFirstRun,
  type HealRuns,
} from './helpers/flows.ts';
import { describePlaywright } from './helpers/parity.ts';
import { fakeTarget, playwrightTarget } from './helpers/targets.ts';

describePlaywright('M9/M10/M11 [P] regressions under real Chromium, identical statuses to the fake driver', () => {
  let heal: { fake: HealRuns; pw: HealRuns };
  let first: { fake: BugFirstRun; pw: BugFirstRun };
  let after: { fake: BugAfterRecording; pw: BugAfterRecording };
  beforeAll(async () => {
    heal = { fake: await flowHeal(fakeTarget), pw: await flowHeal(playwrightTarget) };
    first = { fake: await flowBugFirstRun(fakeTarget), pw: await flowBugFirstRun(playwrightTarget) };
    after = { fake: await flowBugAfterRecording(fakeTarget), pw: await flowBugAfterRecording(playwrightTarget) };
  }, 600_000);

  it('M9 [P] R-CH5: flag v2 -> target-missing -> healed; --strict fails with REPLAY_DIVERGED; two heals demote the step to fuzzy (heal-threshold)', () => {
    expectHeal(heal.pw);
    for (const key of ['strict', 'heal1', 'heal2', 'third'] as const) expect(statusSummary(heal.pw[key])).toEqual(statusSummary(heal.fake[key]));
  });

  it('M10 [P] R-CH1: a buggy first run fails at the judge, the recording is discarded and no file is written', () => {
    expectBugFirstRun(first.pw);
    expect(statusSummary(first.pw.result)).toEqual(statusSummary(first.fake.result));
  });

  it('M11 [P] R-AS4 R-CH1: after recordings exist the deterministic check fails with CHECK_FAILED and zero judge calls; --audit also runs the judge', () => {
    expectBugAfterRecording(after.pw);
    expect(statusSummary(after.pw.result)).toEqual(statusSummary(after.fake.result));
    expect(statusSummary(after.pw.audit)).toEqual(statusSummary(after.fake.audit));
  });
});
