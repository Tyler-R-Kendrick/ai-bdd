// Chaos 3: hostile and broken model output during compile (extraction) and characterization (act, checkgen, judge). Whatever a
// model returns is untrusted: it is validated, rejected with a diagnostic that names the cause, and never reaches a plan, a
// recording or a verdict. A judge that fails can never turn into a pass.
import { readFileSync, rmSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ModelFault, ModelRule } from '@ai-bdd/testing';
import {
  T,
  chaosEngine,
  compilePlain,
  createProject,
  expectScenarioSane,
  expectStoreFilesValid,
  planFiles,
  readPlans,
  readRecordings,
  stepsOf,
  walkFiles,
} from './helpers/kit.ts';

const BROKEN: ModelFault[] = [{ kind: 'malformed-json' }, { kind: 'schema-invalid' }, { kind: 'empty' }, { kind: 'truncated' }];

const planBytes = (project: Parameters<typeof planFiles>[0]): Record<string, string> =>
  Object.fromEntries(Object.entries(planFiles(project)).filter(([k]) => k.endsWith('.plan.json')));

describe('chaos 3: extraction output that is not trustworthy', () => {
  for (const fault of BROKEN) {
    it(`${fault.kind} from every call: every section fails with EXTRACT_MODEL_OUTPUT_INVALID, the plan is valid and empty of features, a healthy compile then converges`, async () => {
      const reference = createProject({ docs: ['billing'] });
      const project = createProject({ docs: ['billing'] });
      try {
        await compilePlain(reference);
        const refPlans = planBytes(reference);
        const ce = await chaosEngine(project, { modelPlan: { seed: 'e', rules: [{ at: 'extract', fault }] } });
        const result = await ce.h.compile();
        const entry = result.docs[0];
        expect(entry?.extractedSections).toEqual([]);
        expect(entry?.failedSections.length).toBeGreaterThan(0);
        const diags = (entry?.diagnostics ?? []).filter((d) => d.code === 'EXTRACT_MODEL_OUTPUT_INVALID');
        expect(diags, 'one diagnostic per failed section, naming the cause').toHaveLength(entry?.failedSections.length ?? -1);
        for (const d of diags) {
          expect(d.severity).toBe('error');
          expect(d.message).toContain('did not match the extraction schema after 2 attempts');
          expect(d.details).toMatchObject({ attempts: 2 });
        }
        expect(result.exitCode).toBe(1);
        // nothing untrusted was planned
        const plans = readPlans(project);
        expect(plans.flatMap((p) => p.features)).toEqual([]);
        expect(plans.every((p) => p.sections.every((s) => s.failed === true))).toBe(true);
        await ce.h.close();

        const healthy = await chaosEngine(project);
        const again = await healthy.h.compile();
        expect(again.exitCode).toBe(0);
        expect(planBytes(project)).toEqual(refPlans);
        await healthy.h.close();
      } finally {
        reference.cleanup();
        project.cleanup();
      }
    });
  }

  it('hostile output on a section of an EXISTING plan keeps that section\'s previous features untouched and the section dirty', async () => {
    const project = createProject({ docs: ['billing'] });
    try {
      await compilePlain(project);
      const before = readPlans(project)[0];
      const featureIds = before?.features.map((f) => f.id).sort() ?? [];
      expect(featureIds.length).toBeGreaterThan(2);
      project.editDoc('billing', 'The upgrade button is visible while the account is on the Free plan.', 'The upgrade button is always visible while the account is on the Free plan.');

      const ce = await chaosEngine(project, { modelPlan: { seed: 'e', rules: [{ at: 'extract', fault: { kind: 'schema-invalid' } }] } });
      const result = await ce.h.compile();
      expect(result.exitCode).toBe(1);
      await ce.h.close();
      const after = readPlans(project)[0];
      expect(after?.features.map((f) => f.id).sort(), 'no feature lost or invented').toEqual(featureIds);
      expect(after?.features.map((f) => f.fingerprint).sort()).toEqual(before?.features.map((f) => f.fingerprint).sort());
      expect(after?.sections.some((s) => s.failed === true)).toBe(true);

      // the section is still dirty, so a healthy compile redoes it
      const healthy = await chaosEngine(project);
      expect((await healthy.h.compile()).exitCode).toBe(0);
      expect(healthy.h.counts().extract, 'only the dirty section is extracted again').toBe(1);
      await healthy.h.close();
    } finally {
      project.cleanup();
    }
  });

  it('a hostile doc plus a hostile model: an oversized answer cannot corrupt the plan file (it stays valid JSON that loads)', async () => {
    const project = createProject({ docs: ['billing'] });
    try {
      const ce = await chaosEngine(project, { modelPlan: { seed: 'big', rules: [{ at: 'extract', probability: 0.5, fault: { kind: 'oversized', chars: 300_000 } }] } });
      await ce.h.compile();
      await ce.h.close();
      expect(readPlans(project)).toHaveLength(1); // loads and validates
      await expectStoreFilesValid(project);
    } finally {
      project.cleanup();
    }
  });
});

describe('chaos 3: act output that is not trustworthy', () => {
  async function upgradeWith(rules: ModelRule[], overrides = {}) {
    const project = createProject({ docs: ['billing'] });
    try {
      await compilePlain(project);
      const ce = await chaosEngine(project, { overrides, modelPlan: { seed: 'act', rules }, driverPlan: { seed: 'act', rules: [] } });
      const result = await ce.h.runScenario(T.upgrade);
      const recordings = readRecordings(project);
      await ce.h.close();
      return { result, ce, recordings };
    } finally {
      project.cleanup();
    }
  }

  it('tool calls for tools that do not exist are refused every turn: no action reaches the driver, the budget ends the step, nothing is recorded', async () => {
    const { result, ce, recordings } = await upgradeWith([{ at: 'act', fault: { kind: 'bad-tool-call', mode: 'unknown-tool' } }], { agent: { maxModelCalls: 4 } });
    expect(result.status).toBe('failed');
    expect(result.steps[0]).toMatchObject({ status: 'failed', error: { code: 'ACT_BUDGET_EXHAUSTED' } });
    expect(ce.models?.stats.calls.act, 'bounded by agent.maxModelCalls').toBe(4);
    expect(ce.driver?.stats.calls.perform, 'only the start navigation reached the driver').toBe(1);
    expect(recordings).toEqual([]);
    expectScenarioSane(result, 6);
  });

  it('tool calls with garbage arguments are refused with MODEL_OUTPUT_INVALID results and end on the same budget', async () => {
    for (const fault of [{ kind: 'bad-tool-call', mode: 'bad-args' }, { kind: 'schema-invalid' }] as ModelFault[]) {
      const { result, ce, recordings } = await upgradeWith([{ at: 'act', fault }], { agent: { maxModelCalls: 3 } });
      expect(result.status, fault.kind).toBe('failed');
      expect(result.steps[0]?.error?.code, fault.kind).toBe('ACT_BUDGET_EXHAUSTED');
      expect(ce.models?.stats.calls.act, fault.kind).toBe(3);
      expect(ce.driver?.stats.calls.perform, fault.kind).toBe(1);
      expect(recordings).toEqual([]);
    }
  });

  it('an extra unknown call after a valid one: the valid call runs, the unknown one is refused, the scenario still passes', async () => {
    const { result, recordings } = await upgradeWith([{ at: 'act', fault: { kind: 'bad-tool-call', mode: 'extra-unknown' } }]);
    expect(result.status).toBe('passed');
    expect(recordings).toHaveLength(1);
    expect(JSON.stringify(recordings[0]?.recording)).not.toContain('format_disk');
  });

  it('answers without any tool call (empty, malformed, truncated) end the step after exactly two empty turns with MODEL_OUTPUT_INVALID', async () => {
    for (const fault of [{ kind: 'empty' }, { kind: 'malformed-json' }, { kind: 'truncated' }] as ModelFault[]) {
      const { result, ce, recordings } = await upgradeWith([{ at: 'act', fault }]);
      expect(result.status, fault.kind).toBe('failed');
      expect(result.steps[0]?.error, fault.kind).toMatchObject({ code: 'MODEL_OUTPUT_INVALID' });
      expect(result.steps[0]?.error?.message).toContain('no tool call in 2 consecutive turns');
      expect(ce.models?.stats.calls.act, fault.kind).toBe(2);
      expect(recordings).toEqual([]);
    }
  });

  it('oversized prose around valid tool calls is harmless and never reaches the recording', async () => {
    const { result, recordings } = await upgradeWith([{ at: 'act', fault: { kind: 'oversized', chars: 200_000, where: 'text' } }]);
    expect(result.status).toBe('passed');
    expect(JSON.stringify(recordings[0]?.recording).length).toBeLessThan(50_000);
  });
});

describe('chaos 3: check generation output that is not trustworthy', () => {
  it('garbage checks are never recorded: the step falls back to a fuzzy step judged every time, after exactly checks.maxAttempts tries', async () => {
    for (const fault of [...BROKEN, { kind: 'oversized', chars: 50_000 }] as ModelFault[]) {
      const project = createProject({ docs: ['billing'] });
      try {
        await compilePlain(project);
        const ce = await chaosEngine(project, { modelPlan: { seed: 'cg', rules: [{ at: 'checkgen', fault }] } });
        const result = await ce.h.runScenario(T.upgrade);
        expect(result.status, fault.kind).toBe('passed'); // the judge decided each then-step
        const thens = result.steps.filter((s) => s.kind === 'then');
        expect(thens.every((s) => s.determinism === 'fuzzy' && s.path === 'judge'), fault.kind).toBe(true);
        expect(thens.every((s) => s.fuzzyReasons.length === 1 && s.fuzzyReasons[0] !== undefined), fault.kind).toBe(true);
        expect(ce.models?.stats.calls.checkgen, fault.kind).toBe(4 * 3);
        const recording = readRecordings(project)[0]?.recording;
        expect(recording?.steps.filter((s) => s.kind === 'then').every((s) => s.check === undefined && s.determinism === 'fuzzy'), fault.kind).toBe(true);
        await ce.h.close();
        await expectStoreFilesValid(project);
      } finally {
        project.cleanup();
      }
    }
  });
});

describe('chaos 3: judge output that is not trustworthy never becomes a pass', () => {
  const JUDGE_FAULTS: ModelFault[] = [
    ...BROKEN,
    { kind: 'oversized', chars: 100_000 },
    { kind: 'unavailable' },
    { kind: 'rate-limit' },
    { kind: 'timeout', ms: 120_000 },
    { kind: 'throw-raw', message: 'socket hang up' },
    { kind: 'throw', code: 'MODEL_OUTPUT_INVALID' },
  ];

  for (const fault of JUDGE_FAULTS) {
    it(`${fault.kind}: the first judged step errors, later steps are skipped, no recording, the diagnostics name the cause`, async () => {
      const project = createProject({ docs: ['billing'] });
      try {
        await compilePlain(project);
        const ce = await chaosEngine(project, { modelPlan: { seed: 'j', rules: [{ at: 'judge', fault }] } });
        const result = await ce.h.runScenario(T.upgrade);
        expect(result.status).toBe('error');
        const bad = result.steps.find((s) => s.status === 'error');
        expect(bad?.kind).toBe('then');
        expect(bad?.judge, 'no verdict was made up').toBeUndefined();
        expect(bad?.error?.code).toMatch(/^(MODEL_OUTPUT_INVALID|MODEL_UNAVAILABLE|INTERNAL)$/);
        expect(bad?.error?.message.length ?? 0).toBeGreaterThan(5);
        if (['malformed-json', 'schema-invalid', 'empty', 'truncated', 'oversized'].includes(fault.kind)) {
          expect(bad?.error?.code).toBe('MODEL_OUTPUT_INVALID');
          expect(bad?.error?.message).toMatch(/judge sample \d is not valid judgment JSON/);
        }
        if (fault.kind === 'throw-raw') expect(bad?.error).toMatchObject({ code: 'INTERNAL', message: 'socket hang up' });
        const idx = result.steps.indexOf(bad as NonNullable<typeof bad>);
        expect(result.steps.slice(idx + 1).every((s) => s.status === 'skipped')).toBe(true);
        expect(result.steps.filter((s) => s.status === 'passed').length).toBe(idx);
        expect(readRecordings(project)).toEqual([]);
        expect(result.recording).toBe('discarded');
        expectScenarioSane(result, 6);
        await ce.h.close();
      } finally {
        project.cleanup();
      }
    });
  }

  it('on replay, a judge that breaks cannot pass a fuzzy step, and the recording file is byte-identical afterwards', async () => {
    const project = createProject({ docs: ['billing'] });
    try {
      await compilePlain(project);
      const first = await chaosEngine(project);
      const characterized = await first.h.runScenario(T.tone);
      expect(characterized.status).toBe('passed');
      await first.h.close();
      const file = readRecordings(project)[0]?.path ?? '';
      const bytes = readFileSync(file, 'utf8');
      expect(readRecordings(project)[0]?.recording.steps.some((s) => s.determinism === 'fuzzy')).toBe(true);

      for (const fault of [{ kind: 'schema-invalid' }, { kind: 'empty' }, { kind: 'unavailable' }] as ModelFault[]) {
        rmSync(project.cacheDir, { recursive: true, force: true }); // a cached verdict would legitimately answer without asking the model
        const ce = await chaosEngine(project, { modelPlan: { seed: 'r', rules: [{ at: 'judge', fault }] } });
        const replay = await ce.h.runScenario(T.tone);
        expect(replay.mode).toBe('replay');
        expect(replay.status, fault.kind).toBe('error');
        expect(stepsOf(replay).some((s) => s.startsWith('passed:') || s === 'passed')).toBe(true);
        expect(replay.steps.filter((s) => s.determinism === 'fuzzy').every((s) => s.status !== 'passed'), fault.kind).toBe(true);
        expect(readFileSync(file, 'utf8'), `${fault.kind}: recording untouched`).toBe(bytes);
        await ce.h.close();
      }
    } finally {
      project.cleanup();
    }
  });

  it('no artifact written by a hostile run is large enough to matter beyond the evidence it is: recordings and plans stay small', async () => {
    const project = createProject({ docs: ['billing'] });
    try {
      await compilePlain(project);
      const ce = await chaosEngine(project, {
        modelPlan: {
          seed: 'sizes',
          rules: [
            { at: 'act', fault: { kind: 'oversized', chars: 500_000, where: 'text' } },
            { at: 'checkgen', fault: { kind: 'oversized', chars: 500_000 } },
          ],
        },
      });
      await ce.h.runScenario(T.upgrade);
      await ce.h.close();
      for (const f of walkFiles(project.recordingsDir).concat(walkFiles(project.plansDir))) expect(statSync(f).size, f).toBeLessThan(100_000);
    } finally {
      project.cleanup();
    }
  });
});
