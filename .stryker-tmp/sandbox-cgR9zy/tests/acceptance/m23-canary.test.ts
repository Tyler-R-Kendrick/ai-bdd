// @ts-nocheck
import { afterEach, describe, expect, it } from 'vitest';
import { callText, ofPurpose } from './helpers/calls.ts';
import { openEngine } from './helpers/engine.ts';
import { CANARY } from './helpers/paths.ts';
import { T } from './helpers/plans.ts';
import { createProject, type Project } from './helpers/project.ts';
import { artifactsOfKind, latestRunDir } from './helpers/runs.ts';

let project: Project | undefined;
afterEach(() => {
  project?.cleanup();
  project = undefined;
});

describe('M23 the judge never sees actor output', () => {
  it('M23 R-JU1: a canary in the act rules (tool-call summary) never appears in any judge request, request artifact or the page', async () => {
    const p = createProject({ docs: ['billing'], layers: ['canary', 'base'] });
    project = p;
    const h = await openEngine(p);
    await h.compile();
    const result = await h.runScenario(T.upgrade);
    expect(result.status).toBe('passed');
    const acts = ofPurpose(h.calls, 'act');
    const judges = ofPurpose(h.calls, 'judge');
    await h.close();

    // control: the canary really was produced by the actor and travelled through the act transcript
    expect(acts.some((c) => callText(c).includes(CANARY)), 'canary reached the act log').toBe(true);
    const dir = latestRunDir(p);
    expect(artifactsOfKind(dir, 'act-transcript').some((a) => a.text.includes(CANARY))).toBe(true);

    expect(judges.length).toBeGreaterThan(0);
    for (const c of judges) expect(callText(c), `judge call ${c.ruleId ?? ''}`).not.toContain(CANARY);
    for (const a of [...artifactsOfKind(dir, 'judge-request'), ...artifactsOfKind(dir, 'judge-response')]) expect(a.text).not.toContain(CANARY);
    // the page does not show it either, so a leak could only come from actor output
    for (const c of judges) expect(String(c.request?.context?.['afterTreeText'])).not.toContain(CANARY);
  });
});
