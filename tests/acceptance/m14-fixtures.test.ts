import { afterEach, describe, expect, it } from 'vitest';
import { openEngine } from './helpers/engine.ts';
import { findScenario, readPlans, T } from './helpers/plans.ts';
import { createProject, type Project } from './helpers/project.ts';

let project: Project | undefined;
afterEach(() => {
  project?.cleanup();
  project = undefined;
});

describe('M14 data preconditions need fixtures', () => {
  it('M14 R-FX1: without a configured fixture the scenario is blocked with FIXTURE_REQUIRED and a stub, and nothing else runs', async () => {
    const p = createProject({ docs: ['billing'], options: { fixtures: false } });
    project = p;
    const h = await openEngine(p);
    const compiled = await h.compile();
    // the catalog is empty, so the extractor's seedAccount call is removed and the step keeps requiresState
    expect(compiled.docs[0]?.diagnostics.some((d) => d.code === 'EXTRACT_FIXTURE_INVALID')).toBe(true);
    const given = findScenario(readPlans(p), T.blocked).scenario.steps[0];
    expect(given?.fixture).toBeUndefined();
    expect(given?.requiresState).toBe(true);

    const result = await h.runScenario(T.blocked);
    expect(result.status).toBe('blocked');
    const step = result.steps[0];
    expect(step?.status).toBe('blocked');
    expect(step?.error?.code).toBe('FIXTURE_REQUIRED');
    const stub = (step?.error?.details as { stub?: string } | undefined)?.stub;
    expect(typeof stub).toBe('string');
    expect(stub).toContain('FixtureDefinition');
    expect(/name:\s*['"]([a-z][A-Za-z0-9]{0,39})['"]/.test(stub ?? ''), stub).toBe(true);
    expect(result.steps.slice(1).every((s) => s.status === 'skipped')).toBe(true);
    expect(h.counts().act).toBe(0);
    await h.close();
  });

  it('M14 R-FX1 R-CH3: with acmeFixtures seedAccount({plan:"pro", unpaid:2}) runs and the alert assertion passes; a second run replays', async () => {
    const p = createProject({ docs: ['billing'] });
    project = p;
    const h1 = await openEngine(p);
    await h1.compile();
    const given = findScenario(await h1.plans(), T.blocked).scenario.steps[0];
    expect(given?.fixture).toEqual({ name: 'seedAccount', args: { plan: 'pro', unpaid: 2 } });
    const first = await h1.runScenario(T.blocked);
    await h1.close();
    expect(first.status).toBe('passed');
    expect(first.steps[0]?.path).toBe('fixture');
    expect(first.steps[0]?.determinism).toBe('deterministic');
    // reloading the page through the navigation has no observable effect on the fake driver: the step is honestly fuzzy
    expect(first.steps[1]?.status).toBe('passed');
    expect(first.steps[1]?.fuzzyReasons).toContain('no-observable-effect');
    expect(first.steps[2]?.path).toBe('agent');
    expect(first.steps[3]?.path).toBe('check+judge');
    expect(first.recording).toBe('created');
    expect(first.confirm?.failed).toBe(false);

    const h2 = await openEngine(p);
    const second = await h2.runScenario(T.blocked);
    const allowed = await h2.runScenario(T.allowed);
    await h2.close();
    expect(second.status).toBe('passed');
    expect(second.mode).toBe('replay');
    expect(second.steps.map((s) => s.path)).toEqual(['fixture', 'agent', 'replay', 'check']);
    expect(allowed.status).toBe('passed');
    expect(allowed.steps.map((s) => s.kind)).toEqual(['given', 'when', 'when', 'then', 'then']);
  });
});
