import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openEngine } from './helpers/engine.ts';
import { expectReports, flowReports, type ReportRuns } from './helpers/flows.ts';
import { T } from './helpers/plans.ts';
import { createProject, type Project } from './helpers/project.ts';
import { fakeTarget } from './helpers/targets.ts';

describe('M19 slow report page, settle timeout 500 ms (fake driver)', () => {
  let res: ReportRuns;
  beforeAll(async () => {
    res = await flowReports(fakeTarget);
  });

  it('M19 R-RN1: the page never settles within 500 ms, the assertion fails with SCREEN_NOT_SETTLED and no checkgen or judge call is made', () => {
    expectReports(res);
  });
});

describe('M19 settled report page', () => {
  let project: Project | undefined;
  afterEach(() => {
    project?.cleanup();
    project = undefined;
  });

  it('M19 R-RN1: with a long enough settle timeout the same scenario waits for the spinner, then passes', async () => {
    const p = createProject({ docs: ['reports'] });
    project = p;
    const h = await openEngine(p, { overrides: { settle: { timeoutMs: 60_000 } } });
    await h.compile();
    const result = await h.runScenario(T.report);
    await h.close();
    expect(result.status).toBe('passed');
    expect(result.steps[0]?.path).toBe('check+judge');
  });
});
