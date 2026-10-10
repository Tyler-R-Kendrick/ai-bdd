import { describe, expect, it } from 'vitest';
import type { ActProgram, CheckGenResult } from '../../src/contracts/index.ts';
import { existsProgram, actProgramFor } from './doubles/collaborators.ts';
import { createHarness, thenStep, when, type Harness } from './doubles/harness.ts';

const ACT = 'the user clicks Upgrade to Pro';
const CHECK = 'Plan: Pro';
const SECRET = 'Zq7-uniq/Secret+Value!99';

function upgradeHarness(over: Partial<Parameters<typeof createHarness>[0]> = {}): Harness {
  const h = createHarness({ steps: [when(ACT), thenStep(CHECK)], ...over });
  h.effectShows(ACT, CHECK);
  return h;
}

describe('unsettled baseline (F-14, R-AS1, R-RN1)', () => {
  it('R-AS1: when the screen before the action never settled, no check is generated; the step is judge-only and fuzzy (unsettled-baseline)', async () => {
    const h = upgradeHarness();
    // settle calls: 1 = session setup, 2 = "before" of the action; both unsettled. Later calls settle.
    h.settler.settledWhen = (_obs, n) => n > 2;
    const r = await h.run();
    expect(r.status).toBe('passed');
    expect(h.asserter.generations).toHaveLength(0);
    expect(r.steps[1]).toMatchObject({ status: 'passed', path: 'judge', determinism: 'fuzzy' });
    expect(r.steps[1]?.fuzzyReasons).toContain('unsettled-baseline');
    // the action's effect was measured against a screen that was still loading, so it is not trusted either
    expect(r.steps[0]?.determinism).toBe('fuzzy');
    expect(r.steps[0]?.fuzzyReasons).toContain('unsettled-baseline');
    expect(h.saved?.steps[1]?.check).toBeUndefined();
    expect(h.saved?.steps[1]?.fuzzyReasons).toContain('unsettled-baseline');
  });

  it('R-AS1: checks.requireDeterministic turns the unsettled baseline into CHECK_GENERATION_FAILED', async () => {
    const h = upgradeHarness({ config: { checks: { requireDeterministic: true, maxAttempts: 3, maxPredicates: 8 } } });
    h.settler.settledWhen = (_obs, n) => n > 2;
    const r = await h.run();
    expect(r.steps[1]?.error?.code).toBe('CHECK_GENERATION_FAILED');
    expect(h.asserter.generations).toHaveLength(0);
  });

  it('R-AS1: a settled baseline still generates a deterministic check (control)', async () => {
    const h = upgradeHarness();
    const r = await h.run();
    expect(r.steps[1]).toMatchObject({ path: 'check+judge', determinism: 'deterministic' });
    expect(h.asserter.generations).toHaveLength(1);
  });

  it('R-RN1: settle.requireSettled=false is the explicit opt-out: the unsettled baseline is used', async () => {
    const h = upgradeHarness({ config: { settle: { quietMs: 300, intervalMs: 100, timeoutMs: 5000, requireSettled: false } } });
    h.settler.settledWhen = (_obs, n) => n > 2;
    const r = await h.run();
    expect(h.asserter.generations).toHaveLength(1);
    expect(r.steps[1]?.path).toBe('check+judge');
  });

  it('R-AS1: an unsettled start does not matter when no action preceded the check (invariant)', async () => {
    const h = createHarness({ steps: [thenStep('Billing')] });
    h.settler.settledWhen = (_obs, n) => n > 1;
    await h.run();
    expect(h.asserter.generations).toHaveLength(1);
  });
});

describe('secrets never reach a committed recording (F-05, F-06, R-SE1)', () => {
  function leaky(h: Harness, build: (step: string) => ActProgram): void {
    h.recorder.toRecording = (performed, before, after, probe, step) => {
      h.recorder.recordings.push({ performed, before, after, probe, step, capabilities: undefined });
      return { act: build(step.text), fuzzyReasons: [] };
    };
  }

  it('F-06: a literal fill equal to a secret value is recorded as {secret: name}', async () => {
    const h = upgradeHarness({ secrets: { pw: SECRET } });
    leaky(h, (text) => ({
      ...actProgramFor(text),
      actions: [{ verb: 'fill', target: { role: 'textbox', name: 'Password', ancestors: [], index: 0, of: 1 }, value: { literal: SECRET } }],
    }));
    const r = await h.run();
    expect(r.recording).toBe('created');
    const action = h.saved?.steps[0]?.act?.actions[0];
    expect(action).toMatchObject({ verb: 'fill', value: { secret: 'pw' } });
    expect(JSON.stringify(h.saved)).not.toContain(SECRET);
  });

  it('F-05: effect entries that reflect a secret (node names, field values) are dropped, and an emptied effect makes the step fuzzy', async () => {
    const h = upgradeHarness({ secrets: { pw: SECRET } });
    leaky(h, (text) => ({
      ...actProgramFor(text),
      effect: {
        routeBefore: '/', routeAfter: '/',
        appeared: [{ role: 'status', name: `Hello ${SECRET}` }],
        disappeared: [],
        changed: [{ key: { role: 'textbox', name: 'Email' }, state: 'value', from: '', to: SECRET }],
      },
    }));
    const r = await h.run();
    expect(r.recording).toBe('created');
    expect(JSON.stringify(h.saved)).not.toContain(SECRET);
    expect(h.saved?.steps[0]?.act?.effect.appeared).toEqual([]);
    expect(h.saved?.steps[0]?.act?.effect.changed).toEqual([]);
    expect(h.saved?.steps[0]?.determinism).toBe('fuzzy');
    expect(h.saved?.steps[0]?.fuzzyReasons).toContain('no-observable-effect');
  });

  it('F-05: a selector name that holds a secret is redacted and the step turns fuzzy', async () => {
    const h = upgradeHarness({ secrets: { pw: SECRET } });
    leaky(h, (text) => ({ ...actProgramFor(text), actions: [{ verb: 'click', target: { role: 'button', name: `Sign in as ${SECRET}`, ancestors: [], index: 0, of: 1 } }] }));
    await h.run();
    expect(JSON.stringify(h.saved)).not.toContain(SECRET);
    expect(h.saved?.steps[0]?.determinism).toBe('fuzzy');
    expect(h.saved?.steps[0]?.fuzzyReasons).toContain('secret-in-recording');
  });

  it('F-05: a URL-encoded or base64 variant is caught too', async () => {
    const h = upgradeHarness({ secrets: { pw: SECRET } });
    leaky(h, (text) => ({
      ...actProgramFor(text),
      effect: {
        routeBefore: '/', routeAfter: '/',
        appeared: [{ role: 'status', name: encodeURIComponent(SECRET) }, { role: 'status', name: Buffer.from(SECRET).toString('base64') }],
        disappeared: [], changed: [],
      },
    }));
    await h.run();
    const text = JSON.stringify(h.saved);
    expect(text).not.toContain(encodeURIComponent(SECRET));
    expect(text).not.toContain(Buffer.from(SECRET).toString('base64'));
  });

  it('F-05: the save guard fails closed: a check literal that holds a secret discards the recording, warns, and writes nothing', async () => {
    const h = upgradeHarness({ secrets: { pw: SECRET } });
    h.asserter.generateHandler = (): CheckGenResult => ({
      program: existsProgram('status', `Welcome ${SECRET}`),
      fuzzyReasons: [], attempts: 1, usage: { modelCalls: 1, inputTokens: 1, outputTokens: 1 }, errors: [],
    });
    const r = await h.run();
    expect(r.recording).toBe('discarded');
    expect(h.store.saves).toHaveLength(0);
    expect(h.saved).toBeNull();
    const warn = h.events.find((e) => e.type === 'log' && e.level === 'warn');
    expect(warn).toBeDefined();
    expect(JSON.stringify(h.events)).not.toContain(SECRET);
  });

  it('F-05: no secret reaches the evidence log (events are redacted before they are recorded)', async () => {
    const h = upgradeHarness({ secrets: { pw: SECRET } });
    h.asserter.generateHandler = (): CheckGenResult => ({
      program: existsProgram('status', `Welcome ${SECRET}`),
      fuzzyReasons: [], attempts: 1, usage: { modelCalls: 1, inputTokens: 1, outputTokens: 1 }, errors: [],
    });
    await h.run();
    expect(JSON.stringify(h.evidence)).not.toContain(SECRET);
  });
});
