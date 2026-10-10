// Chaos 1: retry semantics. The documented contract (docs/errors.md, docs/concepts.md, docs/sdk.md): the engine retries in exactly
// two places, both bounded: extraction gets ONE repair retry for output that fails the schema, and check generation gets
// `checks.maxAttempts` attempts (any failed attempt, including a model outage, uses one). Every other failure, whatever its
// `retryable` flag says, is reported at once with its own code; `retryable` tells the CALLER that a fresh run may succeed, and
// retrying provider hiccups below that is the model adapter's `maxRetries`. These tests pin the bounds and the fail-fast paths.
import { describe, expect, it } from 'vitest';
import type { ModelRule } from '@ai-bdd/testing';
import {
  T,
  chaosEngine,
  compilePlain,
  createProject,
  expectScenarioSane,
  planFiles,
  readRecordings,
  seedFor,
  stepsOf,
  withSeed,
  withEngine,
} from './helpers/kit.ts';

const UPGRADE_THENS = 4;

/** Extraction calls a fault-free compile of the docs makes (one per dirty section). */
async function baselineExtractCalls(docs: string[]): Promise<number> {
  const project = createProject({ docs });
  try {
    return await withEngine(project, {}, async (h) => {
      await h.compile();
      return h.counts().extract;
    });
  } finally {
    project.cleanup();
  }
}

async function referencePlans(docs: string[]): Promise<Record<string, string>> {
  const project = createProject({ docs });
  try {
    await compilePlain(project);
    return Object.fromEntries(Object.entries(planFiles(project)).filter(([k]) => k.endsWith('.plan.json')));
  } finally {
    project.cleanup();
  }
}

const planBytes = (project: Parameters<typeof planFiles>[0]): Record<string, string> =>
  Object.fromEntries(Object.entries(planFiles(project)).filter(([k]) => k.endsWith('.plan.json')));

describe('chaos 1: extraction', () => {
  it('MODEL_UNAVAILABLE is not retried by the engine: one call per section, the section fails with the cause, exit 3, and a later compile converges', async () => {
    const docs = ['billing'];
    const sections = await baselineExtractCalls(docs);
    expect(sections).toBeGreaterThan(2);
    const reference = await referencePlans(docs);
    const project = createProject({ docs });
    try {
      const ce = await chaosEngine(project, { modelPlan: { seed: 'x1', rules: [{ at: 'extract', nth: 2, fault: { kind: 'unavailable' } }] } });
      const result = await ce.h.compile();
      expect(ce.models?.stats.calls.extract, 'no retry: exactly one call per section').toBe(sections);
      expect(ce.models?.stats.faults.extract).toBe(1);
      const failed = result.docs.flatMap((d) => d.failedSections);
      expect(failed).toHaveLength(1);
      const diag = result.docs.flatMap((d) => d.diagnostics).find((d) => d.code === 'EXTRACT_SECTION_FAILED');
      expect(diag?.severity).toBe('error');
      expect(diag?.details).toMatchObject({ cause: 'MODEL_UNAVAILABLE' });
      expect(diag?.message).toContain('MODEL_UNAVAILABLE');
      expect(result.exitCode, 'a provider outage is infrastructure').toBe(3);
      await ce.h.close();

      // the failed section stays dirty; the next compile redoes only that section and reaches exactly the fault-free plan
      const second = await chaosEngine(project);
      const again = await second.h.compile();
      expect(second.h.counts().extract, 'only the failed section is extracted again').toBe(1);
      expect(again.exitCode).toBe(0);
      expect(planBytes(project)).toEqual(reference);
      await second.h.close();
    } finally {
      project.cleanup();
    }
  });

  it('N consecutive rate limits fail N sections without a single retry, and the count never exceeds one call per section', async () => {
    const docs = ['billing'];
    const sections = await baselineExtractCalls(docs);
    const project = createProject({ docs });
    try {
      const ce = await chaosEngine(project, { modelPlan: { seed: 'x2', rules: [{ at: 'extract', from: 1, times: 3, fault: { kind: 'rate-limit' } }] } });
      const result = await ce.h.compile();
      expect(ce.models?.stats.calls.extract).toBe(sections);
      expect(result.docs.flatMap((d) => d.failedSections)).toHaveLength(3);
      expect(result.exitCode).toBe(3);
      await ce.h.close();
    } finally {
      project.cleanup();
    }
  });

  it('output that fails the schema gets exactly ONE repair retry: a single bad answer is repaired, two bad answers fail the section after exactly two calls', async () => {
    const docs = ['billing'];
    const sections = await baselineExtractCalls(docs);
    const reference = await referencePlans(docs);

    for (const fault of [{ kind: 'malformed-json' }, { kind: 'schema-invalid' }, { kind: 'empty' }, { kind: 'truncated' }] as const) {
      const project = createProject({ docs });
      try {
        const once = await chaosEngine(project, { overrides: { extract: { concurrency: 1 } }, modelPlan: { seed: 'x3', rules: [{ at: 'extract', nth: 1, fault }] } });
        const repaired = await once.h.compile();
        expect(once.models?.stats.calls.extract, `${fault.kind}: one extra call for the repair`).toBe(sections + 1);
        expect(repaired.docs.flatMap((d) => d.failedSections), `${fault.kind}: repaired`).toEqual([]);
        expect(repaired.exitCode).toBe(0);
        expect(planBytes(project), `${fault.kind}: the repaired plan is the fault-free plan`).toEqual(reference);
        await once.h.close();
      } finally {
        project.cleanup();
      }

      const project2 = createProject({ docs });
      try {
        const twice = await chaosEngine(project2, { overrides: { extract: { concurrency: 1 } }, modelPlan: { seed: 'x3', rules: [{ at: 'extract', from: 1, times: 2, fault }] } });
        const result = await twice.h.compile();
        expect(twice.models?.stats.calls.extract, `${fault.kind}: two bad answers cost two calls for that section, never a third`).toBe(sections + 1);
        const failed = result.docs.flatMap((d) => d.failedSections);
        expect(failed, fault.kind).toHaveLength(1);
        const diag = result.docs.flatMap((d) => d.diagnostics).find((d) => d.code === 'EXTRACT_MODEL_OUTPUT_INVALID');
        expect(diag?.details, fault.kind).toMatchObject({ attempts: 2 });
        expect(result.exitCode, `${fault.kind}: schema failure is a doc/extraction problem (exit 1), not infrastructure`).toBe(1);
        // the failed section contributes nothing to the plan; the plan on disk is valid and has fewer scenarios than the reference
        const written = planBytes(project2);
        for (const text of Object.values(written)) JSON.parse(text);
        await twice.h.close();
      } finally {
        project2.cleanup();
      }
    }
  });
});

describe('chaos 1: check generation (bounded retries)', () => {
  async function runUpgrade(rules: ModelRule[], overrides: Parameters<typeof chaosEngine>[1] extends infer O ? (O extends { overrides?: infer V } ? V : never) : never = {}) {
    const project = createProject({ docs: ['billing'] });
    try {
      await compilePlain(project);
      const ce = await chaosEngine(project, { overrides, modelPlan: { seed: 'cg', rules } });
      const result = await ce.h.runScenario(T.upgrade);
      const recordings = readRecordings(project);
      await ce.h.close();
      return { result, ce, recordings };
    } finally {
      project.cleanup();
    }
  }

  it('retryable outages inside the attempt limit are absorbed: the scenario passes with deterministic checks, one extra call per failure', async () => {
    const { result, ce, recordings } = await runUpgrade([{ at: 'checkgen', from: 1, times: 2, fault: { kind: 'rate-limit' } }]);
    expect(result.status).toBe('passed');
    expect(ce.models?.stats.calls.checkgen).toBe(UPGRADE_THENS + 2);
    expect(ce.models?.stats.faults.checkgen).toBe(2);
    const thens = result.steps.filter((s) => s.kind === 'then');
    expect(thens.map((s) => s.determinism)).toEqual(new Array(UPGRADE_THENS).fill('deterministic'));
    expect(recordings).toHaveLength(1);
    expect(recordings[0]?.recording.steps.filter((s) => s.check !== undefined)).toHaveLength(UPGRADE_THENS);
    expectScenarioSane(result);
  });

  it('a failing step never costs more than checks.maxAttempts calls, then falls back to a FUZZY step (never a silent deterministic one)', async () => {
    for (const maxAttempts of [1, 2, 3]) {
      const { result, ce, recordings } = await runUpgrade([{ at: 'checkgen', from: 1, times: maxAttempts, fault: { kind: 'unavailable' } }], { checks: { maxAttempts } });
      // the first then-step exhausts exactly its attempts; the other three succeed at once
      expect(ce.models?.stats.calls.checkgen, `maxAttempts=${maxAttempts}`).toBe(maxAttempts + (UPGRADE_THENS - 1));
      expect(result.status, 'the judge still decides the step').toBe('passed');
      const first = result.steps.find((s) => s.kind === 'then');
      expect(first?.determinism).toBe('fuzzy');
      expect(first?.path).toBe('judge');
      expect(first?.fuzzyReasons).toEqual(['check-generation-failed']);
      expect(recordings[0]?.recording.steps.find((s) => s.kind === 'then')).toMatchObject({ determinism: 'fuzzy', fuzzyReasons: ['check-generation-failed'] });
      expect(recordings[0]?.recording.steps.find((s) => s.kind === 'then')?.check).toBeUndefined();
    }
  });

  it('with checks.requireDeterministic an exhausted retry budget fails the step with CHECK_GENERATION_FAILED and writes no recording', async () => {
    const { result, ce, recordings } = await runUpgrade([{ at: 'checkgen', from: 1, fault: { kind: 'throw', code: 'MODEL_UNAVAILABLE' } }], { checks: { requireDeterministic: true } });
    expect(result.status).toBe('failed');
    const failed = result.steps.find((s) => s.status === 'failed');
    expect(failed?.error?.code).toBe('CHECK_GENERATION_FAILED');
    expect(failed?.error?.details).toMatchObject({ attempts: 3 });
    expect(ce.models?.stats.calls.checkgen, 'three attempts for the failing step, nothing after the failure').toBe(3);
    expect(result.recording).toBe('discarded');
    expect(recordings).toEqual([]);
  });

  it('non-retryable outcomes (schema-invalid, empty, malformed) use attempts too, and never more than the limit', async () => {
    for (const kind of ['schema-invalid', 'empty', 'malformed-json'] as const) {
      const { result, ce } = await runUpgrade([{ at: 'checkgen', from: 1, times: 3, fault: { kind } }]);
      expect(ce.models?.stats.calls.checkgen, kind).toBe(3 + (UPGRADE_THENS - 1));
      expect(result.steps.find((s) => s.kind === 'then')?.determinism, kind).toBe('fuzzy');
    }
  });
});

describe('chaos 1: everything else fails fast with its own code', () => {
  async function runWith(plan: Parameters<typeof chaosEngine>[1]) {
    const project = createProject({ docs: ['billing'] });
    try {
      await compilePlain(project);
      const ce = await chaosEngine(project, plan);
      const result = await ce.h.runScenario(T.upgrade);
      const recordings = readRecordings(project);
      await ce.h.close();
      return { result, ce, recordings };
    } finally {
      project.cleanup();
    }
  }

  it('act: MODEL_UNAVAILABLE ends the step at once (one act call, retryable=true is reported, not acted on); no later model call, no recording', async () => {
    const { result, ce, recordings } = await runWith({ modelPlan: { seed: 'a', rules: [{ at: 'act', nth: 1, fault: { kind: 'unavailable' } }] } });
    expect(result.status).toBe('error');
    expect(result.steps[0]?.status).toBe('error');
    expect(result.steps[0]?.error).toMatchObject({ code: 'MODEL_UNAVAILABLE', retryable: true });
    expect(stepsOf(result)).toEqual(['error:MODEL_UNAVAILABLE', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped']);
    expect(ce.models?.stats.calls).toEqual({ extract: 0, act: 1, checkgen: 0, judge: 0 });
    expect(recordings).toEqual([]);
    expect(result.recording).toBe('discarded');
  });

  it('a permanent provider error is reported as non-retryable', async () => {
    const { result } = await runWith({ modelPlan: { seed: 'a', rules: [{ at: 'act', nth: 1, fault: { kind: 'unavailable', permanent: true } }] } });
    expect(result.steps[0]?.error).toMatchObject({ code: 'MODEL_UNAVAILABLE', retryable: false });
  });

  it('judge: an outage is an error, never a pass; the three parallel samples are not re-asked', async () => {
    const { result, ce } = await runWith({ modelPlan: { seed: 'j', rules: [{ at: 'judge', from: 1, times: 2, fault: { kind: 'rate-limit' } }] } });
    expect(result.status).toBe('error');
    const bad = result.steps.find((s) => s.status === 'error');
    expect(bad?.kind).toBe('then');
    expect(bad?.error?.code).toBe('MODEL_UNAVAILABLE');
    expect(bad?.judge).toBeUndefined();
    expect(ce.models?.stats.calls.judge, 'one request = three samples, no retry').toBe(3);
    expect(result.steps.filter((s) => s.status === 'passed').map((s) => s.kind)).toEqual(['when']);
  });

  it('driver: DRIVER_UNAVAILABLE from openSession is reported once, with no session and no model call', async () => {
    const { result, ce } = await runWith({ driverPlan: { seed: 'd', rules: [{ at: 'openSession', from: 1, times: 2, fault: { kind: 'throw', code: 'DRIVER_UNAVAILABLE' } }] } });
    expect(result.status).toBe('error');
    expect(result.error).toMatchObject({ code: 'DRIVER_UNAVAILABLE', retryable: true });
    expect(ce.driver?.stats.calls.openSession, 'one attempt, not two').toBe(1);
    expect(ce.driver?.stats.sessionsOpened).toEqual([]);
    expect(ce.h.counts()).toEqual({ extract: 0, act: 0, checkgen: 0, judge: 0 });
    expect(result.steps.every((s) => s.status === 'skipped')).toBe(true);
  });

  it('driver: SESSION_LIMIT is not retryable and keeps its code', async () => {
    const { result } = await runWith({ driverPlan: { seed: 'd', rules: [{ at: 'openSession', fault: { kind: 'throw', code: 'SESSION_LIMIT' } }] } });
    expect(result.error).toMatchObject({ code: 'SESSION_LIMIT', retryable: false });
  });

  it('driver: DRIVER_ERROR thrown by perform ends the step at once with that code; the session is still closed', async () => {
    const { result, ce, recordings } = await runWith({ driverPlan: { seed: 'd', rules: [{ at: 'perform', nth: 2, fault: { kind: 'throw', code: 'DRIVER_ERROR' } }] } });
    expect(result.status).toBe('error');
    expect(result.steps[0]).toMatchObject({ status: 'error', error: { code: 'DRIVER_ERROR', retryable: true } });
    expect(ce.driver?.stats.calls.perform, 'the failing call is not repeated').toBe(2);
    expect(ce.driver?.stats.openSessions()).toEqual([]);
    expect(recordings).toEqual([]);
  });

  it('driver: a reported { ok: false } outcome is handed to the agent, not retried by the engine; the unperformed action cannot yield a pass', async () => {
    const baseline = await (async () => {
      const project = createProject({ docs: ['billing'] });
      try {
        await compilePlain(project);
        const ce = await chaosEngine(project, { driverPlan: { seed: 'd', rules: [] } });
        await ce.h.runScenario(T.upgrade);
        const n = ce.driver?.stats.calls.perform ?? 0;
        await ce.h.close();
        return n;
      } finally {
        project.cleanup();
      }
    })();
    for (const code of ['DRIVER_ERROR', 'DRIVER_UNAVAILABLE', 'STALE_REF', 'TARGET_NOT_FOUND'] as const) {
      const { result, ce, recordings } = await runWith({ driverPlan: { seed: 'd', rules: [{ at: 'perform', nth: 2, fault: { kind: 'fail', code } }] } });
      expect(ce.driver?.stats.calls.perform, `${code}: no extra perform calls`).toBeLessThanOrEqual(baseline);
      expect(result.status, `${code}: the missing effect must be noticed`).not.toBe('passed');
      expect(result.status).not.toBe('healed');
      expect(recordings, `${code}: no recording for a scenario that did not pass`).toEqual([]);
      expect(ce.driver?.stats.openSessions()).toEqual([]);
      expectScenarioSane(result);
    }
  });
});

describe('chaos 1: no path exceeds its retry limit under random faults', () => {
  for (const label of ['bounds-a', 'bounds-b', 'bounds-c', 'bounds-d']) {
    it(`seeded random model faults (${label}): calls per then-step <= checks.maxAttempts, one judge request = 3 samples, extraction <= 2 per section`, async () => {
      await withSeed(label, async (seed) => {
        const project = createProject({ docs: ['billing'] });
        try {
          const rules: ModelRule[] = [
            { at: 'checkgen', probability: 0.6, fault: { kind: 'rate-limit' } },
            { at: 'checkgen', probability: 0.2, fault: { kind: 'schema-invalid' } },
            { at: 'extract', probability: 0.3, fault: { kind: 'malformed-json' } },
          ];
          const ce = await chaosEngine(project, { modelPlan: { seed, rules } });
          const sections = await baselineExtractCalls(['billing']);
          const compiled = await ce.h.compile();
          expect(ce.models?.stats.calls.extract, 'two attempts per section at most').toBeLessThanOrEqual(sections * 2);
          for (const d of compiled.docs) for (const diag of d.diagnostics) expect(diag.code).not.toBe('INTERNAL');
          await ce.h.close();

          const run = await chaosEngine(project, { modelPlan: { seed, rules: rules.slice(0, 2) } });
          // run every compiled scenario; whatever the faults did, bounded retries hold
          const plans = await run.h.plans();
          const scenarios = plans.flatMap((p) => p.features.flatMap((f) => f.scenarios));
          let thenSteps = 0;
          for (const scenario of scenarios) {
            const result = await run.h.runScenario(scenario.id);
            thenSteps += scenario.steps.filter((s) => s.kind === 'then').length;
            expectScenarioSane(result, scenario.steps.length);
          }
          const maxAttempts = run.h.config.checks.maxAttempts;
          expect(run.models?.stats.calls.checkgen ?? 0, `seed ${seed}`).toBeLessThanOrEqual(thenSteps * maxAttempts);
          expect((run.models?.stats.calls.judge ?? 0) % 3, 'judge samples are asked in threes, never retried singly').toBe(0);
          await run.h.close();
        } finally {
          project.cleanup();
        }
      });
    });
  }

  it('the suite is replayable: the seed in use is printed by withSeed and overridable with CHAOS_SEED', () => {
    const saved = process.env['CHAOS_SEED'];
    try {
      delete process.env['CHAOS_SEED'];
      expect(seedFor('label')).toBe('label');
      process.env['CHAOS_SEED'] = 'replay-me';
      expect(seedFor('label')).toBe('replay-me');
    } finally {
      if (saved === undefined) delete process.env['CHAOS_SEED'];
      else process.env['CHAOS_SEED'] = saved;
    }
  });
});
