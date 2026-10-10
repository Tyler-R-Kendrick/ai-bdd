// Chaos 4: the driver hands back damaged observations (stale, shuffled, duplicate refs, missing fields, wrong types, missing or
// no nodes). Nothing may throw out of the runner, a contract-breaking observation is reported as a driver problem with a precise
// message (not a TypeError from deep inside), replays heal or fail cleanly, and a check never passes just because the page it
// looked at was garbage.
import { describe, expect, it } from 'vitest';
import { GARBLE_MODES, type DriverRule, type GarbleMode } from '@ai-bdd/testing';
import {
  T,
  chaosEngine,
  compilePlain,
  createProject,
  expectScenarioSane,
  expectStoreFilesValid,
  readRecordings,
  stepsOf,
  type Project,
} from './helpers/kit.ts';

const MALFORMED: GarbleMode[] = ['duplicate-refs', 'drop-fields', 'wrong-types'];

async function withRecorded<T>(title: string, fn: (project: Project) => Promise<T>, layers?: Parameters<typeof createProject>[0] extends infer O ? (O extends { layers?: infer L } ? L : never) : never): Promise<T> {
  const project = createProject({ docs: ['billing'], ...(layers === undefined ? {} : { layers }) });
  try {
    await compilePlain(project);
    const first = await chaosEngine(project);
    const r = await first.h.runScenario(title);
    expect(r.status, 'the clean characterization passes').toBe('passed');
    await first.h.close();
    return await fn(project);
  } finally {
    project.cleanup();
  }
}

async function runUpgrade(project: Project, rules: DriverRule[], opts: { strict?: boolean; noAgent?: boolean; title?: string } = {}) {
  const ce = await chaosEngine(project, { driverPlan: { seed: 'garble', rules } });
  const { strict, noAgent, title } = opts;
  const result = await ce.h.runScenario(title ?? T.upgrade, { ...(strict ? { strict } : {}), ...(noAgent ? { noAgent } : {}) });
  const open = ce.driver?.stats.openSessions() ?? ['not tracked'];
  const acts = ce.h.counts().act;
  await ce.h.close();
  return { result, open, acts };
}

describe('chaos 4: garbled observations during characterization', () => {
  for (const mode of GARBLE_MODES) {
    for (const [label, shape] of [
      ['a burst of 3', { from: 3, times: 3 }],
      ['everything from the 4th observation on', { from: 4 }],
    ] as const) {
      it(`${mode}, ${label}: no exception escapes, the result is sane, sessions are closed, and nothing is recorded that did not pass`, async () => {
        const project = createProject({ docs: ['billing'] });
        try {
          await compilePlain(project);
          const { result, open } = await runUpgrade(project, [{ at: 'observe', ...shape, fault: { kind: 'garble', mode } }]);
          expectScenarioSane(result, 6);
          expect(open).toEqual([]);
          const recordings = readRecordings(project);
          if (result.status === 'passed') expect(recordings).toHaveLength(1);
          else expect(recordings, `status ${result.status}: ${stepsOf(result)}`).toEqual([]);
          if (shape.times === undefined && result.status === 'passed') {
            // garbage that never ends can only be survived when it carries the same information
            expect(['shuffle', 'stale']).toContain(mode);
          }
          await expectStoreFilesValid(project);
        } finally {
          project.cleanup();
        }
      });
    }
  }

  for (const mode of MALFORMED) {
    it(`${mode} is a driver contract violation: the scenario errors with DRIVER_ERROR and a message naming the defect`, async () => {
      const project = createProject({ docs: ['billing'] });
      try {
        await compilePlain(project);
        const { result } = await runUpgrade(project, [{ at: 'observe', from: 4, fault: { kind: 'garble', mode } }]);
        expect(result.status).toBe('error');
        expect(result.error).toMatchObject({ code: 'DRIVER_ERROR', retryable: false });
        expect(result.error?.message).toContain('malformed observation');
        expect(result.error?.message).toMatch(mode === 'duplicate-refs' ? /duplicates an earlier node/ : /nodes\[\d+\]\.\w+ is not a (string|number|object)/);
        expect(result.error?.message).not.toMatch(/Cannot read|is not a function|undefined/);
      } finally {
        project.cleanup();
      }
    });
  }
});

describe('chaos 4: garbled observations during replay', () => {
  it('a transient burst of any garbage during replay never throws; the scenario passes, heals or fails cleanly, and its recording stays valid', async () => {
    await withRecorded(T.upgrade, async (project) => {
      for (const mode of GARBLE_MODES) {
        for (const from of [2, 3, 5, 8]) {
          const { result, open } = await runUpgrade(project, [{ at: 'observe', from, times: 2, fault: { kind: 'garble', mode } }]);
          expectScenarioSane(result, 6);
          expect(open, `${mode} @${from}`).toEqual([]);
          expect(['passed', 'healed', 'failed', 'error', 'inconclusive', 'blocked'], `${mode} @${from}: ${stepsOf(result)}`).toContain(result.status);
        }
      }
      await expectStoreFilesValid(project);
      expect(readRecordings(project)).toHaveLength(1);
    });
  });

  it('a shuffled order during a short burst does not hurt a replay (selectors resolve by role and name, not by position); an order that never stops changing is an unsettled screen, and no check is evaluated on it', async () => {
    await withRecorded(T.upgrade, async (project) => {
      const burst = await runUpgrade(project, [{ at: 'observe', from: 2, times: 2, fault: { kind: 'garble', mode: 'shuffle' } }], { strict: true });
      expect(burst.result.status).toBe('passed');
      expect(burst.result.mode).toBe('replay');
      expect(burst.acts, 'no agent call was needed').toBe(0);

      const forever = await runUpgrade(project, [{ at: 'observe', from: 1, fault: { kind: 'garble', mode: 'shuffle' } }], { strict: true });
      expect(forever.result.status).toBe('failed');
      const stuck = forever.result.steps.find((s) => s.status === 'failed');
      expect(stuck?.error?.code).toBe('SCREEN_NOT_SETTLED');
      expect(stuck?.check, 'the check was not evaluated on an unsettled screen').toBeUndefined();
    });
  });

  for (const mode of ['empty', 'drop-nodes'] as const) {
    it(`${mode} observations forever: a strict replay fails with REPLAY_DIVERGED and never reaches the agent; a --no-agent replay fails with ACT_NO_AGENT; neither passes`, async () => {
      await withRecorded(T.upgrade, async (project) => {
        const rules: DriverRule[] = [{ at: 'observe', from: 1, fault: { kind: 'garble', mode } }];
        const strict = await runUpgrade(project, rules, { strict: true });
        expect(strict.result.status).toBe('failed');
        expect(strict.result.steps[0]?.error?.code).toBe('REPLAY_DIVERGED');
        expect(strict.acts).toBe(0);
        const noAgent = await runUpgrade(project, rules, { noAgent: true });
        expect(noAgent.result.status).toBe('failed');
        expect(noAgent.result.steps[0]?.error?.code).toBe('ACT_NO_AGENT');
        expect(readRecordings(project)).toHaveLength(1);
      });
    });
  }

  it('stale observations (the page moved on, the driver keeps answering with an old tree): replays do not pass on stale data', async () => {
    await withRecorded(T.upgrade, async (project) => {
      const { result } = await runUpgrade(project, [{ at: 'observe', from: 6, fault: { kind: 'garble', mode: 'stale' } }]);
      expectScenarioSane(result, 6);
      expect(result.status).not.toBe('passed');
    });
  });
});

describe('chaos 4: a check never passes vacuously on garbage', () => {
  // A recorded check that asserts the ABSENCE of something is true on any page that shows nothing. The invariant check below says
  // "there is no Downgrade button" on the Free plan; it must not hold on a blank page, an empty tree, or a driver that lost the page.
  const ABSENCE = {
    inline: [
      {
        id: 'absence-check',
        purpose: 'checkgen',
        when: { criterion: { contains: 'the upgrade button is visible' } },
        respond: {
          object: {
            classification: 'invariant',
            predicates: [{ op: 'exists', negate: true, query: { role: 'button', name: 'Downgrade to Free' } }],
          },
        },
      },
    ],
    name: 'absence',
  };

  it('replaying the absence check on a normal page passes (the guard does not block honest absence)', async () => {
    await withRecorded(
      T.upgradeVisible,
      async (project) => {
        const { result } = await runUpgrade(project, [], { title: T.upgradeVisible });
        expect(result.status).toBe('passed');
        expect(result.steps[0]).toMatchObject({ path: 'check', determinism: 'deterministic' });
        expect(result.steps[0]?.check?.passed).toBe(true);
      },
      [ABSENCE, 'base'],
    );
  });

  it('on an observation without a single node the same check fails (unknown), instead of passing because nothing is there', async () => {
    await withRecorded(
      T.upgradeVisible,
      async (project) => {
        const recorded = readRecordings(project)[0]?.recording.steps[0]?.check;
        expect(recorded?.predicates).toEqual([{ op: 'exists', negate: true, query: { role: 'button', name: 'Downgrade to Free' } }]);
        const { result } = await runUpgrade(project, [{ at: 'observe', from: 1, fault: { kind: 'garble', mode: 'empty' } }], { title: T.upgradeVisible });
        expect(result.status).toBe('failed');
        expect(result.steps[0]?.error?.code).toBe('CHECK_FAILED');
        expect(result.steps[0]?.check?.results[0]).toMatchObject({ satisfied: 'unknown', actual: { blank: true } });
      },
      [ABSENCE, 'base'],
    );
  });

  it('positive checks fail on every kind of garbage that removes the node, and a missing field makes the check unknown, never true', async () => {
    await withRecorded(T.upgradeVisible, async (project) => {
      for (const mode of ['empty', 'drop-nodes'] as const) {
        const { result } = await runUpgrade(project, [{ at: 'observe', from: 1, fault: { kind: 'garble', mode } }], { title: T.upgradeVisible });
        expect(result.status, mode).not.toBe('passed');
      }
      for (const mode of MALFORMED) {
        const { result } = await runUpgrade(project, [{ at: 'observe', from: 1, fault: { kind: 'garble', mode } }], { title: T.upgradeVisible });
        expect(result.status, mode).toBe('error');
        expect(result.error?.code).toBe('DRIVER_ERROR');
      }
    });
  });
});
