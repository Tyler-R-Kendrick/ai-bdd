import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ofPurpose, readFakeLog } from './helpers/calls.ts';
import { cliOutput, runCli } from './helpers/cli.ts';
import { openEngine } from './helpers/engine.ts';
import { expectLogin, flowLogin, SPECIAL_PASSWORD, type LoginRuns } from './helpers/flows.ts';
import { ACME_DEFAULT_ADMIN_PASSWORD } from './helpers/paths.ts';
import { T } from './helpers/plans.ts';
import { createProject, FAST_REAL, type Project } from './helpers/project.ts';
import { findSecret, secretForms } from './helpers/scan.ts';
import { fakeTarget } from './helpers/targets.ts';
import { taintProbe, expectTaintProbe } from './helpers/taint.ts';
import { withoutProvenMasking } from './helpers/unmasked.ts';

describe('M13 login with <secret:adminPassword> (fake driver)', () => {
  let res: LoginRuns;
  beforeAll(async () => {
    res = await flowLogin(fakeTarget);
  });

  it('M13 R-SE1: the scenario passes, replays, and the secret in raw, URL-encoded and base64 form appears nowhere under .ai-bdd, in reports, in the fake log, in results or in the config object', () => {
    expect(secretForms(SPECIAL_PASSWORD).urlEncoded).not.toBe(SPECIAL_PASSWORD);
    expectLogin(res);
  });

  it('M13 R-SE2: observations after a secret fill are tainted; screenshots are masked and masking is proven', async () => {
    expectTaintProbe(await taintProbe(fakeTarget));
  });
});

describe('M13 secrets through the CLI and the judge screenshot gate', () => {
  let project: Project | undefined;
  afterEach(() => {
    project?.cleanup();
    project = undefined;
  });

  it('M13 R-SE1: ai-bdd run on login.md exits 0 and leaves no trace of the default admin password under .ai-bdd, in stdout/stderr or in the fake log', async () => {
    const p = createProject({ docs: ['login'], options: FAST_REAL });
    project = p;
    const out = await runCli(p, ['run', 'docs/login.md', '--reporter', 'json', '--reporter', 'junit', '--reporter', 'markdown']);
    expect(out.code, cliOutput(out)).toBe(0);
    const again = await runCli(p, ['run', 'docs/login.md']);
    expect(again.code, cliOutput(again)).toBe(0);
    expect(findSecret([p.aiBddDir, p.logPath], ACME_DEFAULT_ADMIN_PASSWORD)).toEqual([]);
    for (const text of [out.stdout, out.stderr, again.stdout, again.stderr]) expect(text).not.toContain(ACME_DEFAULT_ADMIN_PASSWORD);
    expect(readFakeLog(p.logPath).length).toBeGreaterThan(0);
  });

  it('M13 R-SE1: replaying a recorded login without the secret in the environment fails the scenario with SECRET_MISSING and does not heal', async () => {
    const p = createProject({ docs: ['login'], options: FAST_REAL });
    project = p;
    const first = await runCli(p, ['run', 'docs/login.md']);
    expect(first.code, cliOutput(first)).toBe(0);
    const again = await runCli(p, ['run', 'docs/login.md'], { env: { ACME_ADMIN_PASSWORD: undefined } });
    const text = cliOutput(again);
    expect(again.code, text).not.toBe(0);
    expect(text).toContain('SECRET_MISSING');
    expect(text).toContain('0 healed');
  });

  it('M13 R-SE2 R-JU3: when masking is not proven, no model request after the secret fill carries a screenshot', async () => {
    const p = createProject({ docs: ['login'] });
    project = p;
    const h = await openEngine(p, { wrapFactory: withoutProvenMasking });
    await h.compile();
    const result = await h.runScenario(T.login);
    expect(result.status).toBe('passed');
    const afterFill = [...ofPurpose(h.calls, 'judge'), ...ofPurpose(h.calls, 'checkgen')];
    expect(afterFill.length).toBeGreaterThan(0);
    for (const c of afterFill) expect(JSON.stringify(c.request?.messages ?? []), 'image part in a tainted, unmasked request').not.toContain('"image"');
    // the act turns that come after the fill are tainted as well
    const actAfterFill = ofPurpose(h.calls, 'act').filter((c) => ['the administrator presses Sign in'].includes(String(c.request?.context?.['stepText'])));
    for (const c of actAfterFill) expect(JSON.stringify(c.request?.messages ?? [])).not.toContain('"image"');
    await h.close();
  });
});
