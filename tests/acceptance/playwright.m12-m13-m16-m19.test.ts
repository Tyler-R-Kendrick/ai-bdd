import { beforeAll, expect, it } from 'vitest';
import { statusSummary } from './helpers/engine.ts';
import {
  expectCheckout,
  expectLogin,
  expectRelease,
  expectReports,
  flowCheckout,
  flowLogin,
  flowRelease,
  flowReports,
  type CheckoutRuns,
  type LoginRuns,
  type ReleaseRuns,
  type ReportRuns,
} from './helpers/flows.ts';
import { describePlaywright } from './helpers/parity.ts';
import { fakeTarget, playwrightTarget } from './helpers/targets.ts';
import { expectTaintProbe, taintProbe } from './helpers/taint.ts';

describePlaywright('M12/M13/M16/M19 [P] ambiguity, secrets, injection and settle under real Chromium', () => {
  let checkout: { fake: CheckoutRuns; pw: CheckoutRuns };
  let login: { fake: LoginRuns; pw: LoginRuns };
  let release: { fake: ReleaseRuns; pw: ReleaseRuns };
  let reports: { fake: ReportRuns; pw: ReportRuns };
  beforeAll(async () => {
    checkout = { fake: await flowCheckout(fakeTarget), pw: await flowCheckout(playwrightTarget) };
    login = { fake: await flowLogin(fakeTarget), pw: await flowLogin(playwrightTarget) };
    release = { fake: await flowRelease(fakeTarget), pw: await flowRelease(playwrightTarget) };
    reports = { fake: await flowReports(fakeTarget), pw: await flowReports(playwrightTarget) };
  }, 600_000);

  it('M12 [P] R-AG2: "Submit the form" is ACT_TARGET_AMBIGUOUS with two candidates; "Save the shipping street" passes', () => {
    expectCheckout(checkout.pw);
    expect(statusSummary(checkout.pw.ambiguous)).toEqual(statusSummary(checkout.fake.ambiguous));
    expect(statusSummary(checkout.pw.saved)).toEqual(statusSummary(checkout.fake.saved));
  });

  it('M13 [P] R-SE1: the secret never reaches .ai-bdd, reports, the fake log, results or the config', () => {
    expectLogin(login.pw);
    expect(statusSummary(login.pw.first)).toEqual(statusSummary(login.fake.first));
    expect(statusSummary(login.pw.second)).toEqual(statusSummary(login.fake.second));
  });

  it('M13 [P] R-SE2: the Playwright session is tainted after a secret fill, with masked screenshots and proven masking', async () => {
    expectTaintProbe(await taintProbe(playwrightTarget));
  });

  it('M16 [P] R-AG3 R-AG4: the denied navigation to evil.example is never performed and the injected page text cannot pass a step', () => {
    expectRelease(release.pw);
    expect(statusSummary(release.pw.result)).toEqual(statusSummary(release.fake.result));
  });

  it('M19 [P] R-RN1: the slow report page never settles within 500 ms: SCREEN_NOT_SETTLED, no judge call', () => {
    expectReports(reports.pw);
    expect(statusSummary(reports.pw.unsettled)).toEqual(statusSummary(reports.fake.unsettled));
  });
});
