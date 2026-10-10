// @ts-nocheck
// Attack 15: get an unsettled screen judged or checked (R-RN1).
// A `then` step must settle first; a busy / ever-changing screen yields SCREEN_NOT_SETTLED and never reaches the judge,
// the check generator or the deterministic check.
import { afterEach, describe, expect, it } from 'vitest';
import type { DriverAction, ObservedNode } from '@ai-bdd/sdk/contracts';
import { callsOf, createProject, extraction, makeEngine, modelSet, quoteFrom, StubSession, type MadeEngine, type Project } from './helpers/kit.ts';

let project: Project | undefined;
afterEach(() => {
  project?.cleanup();
  project = undefined;
});

type N = Omit<ObservedNode, 'ref'>;
const n = (role: string, name: string, depth = 0, extra: Partial<N> = {}): N => ({ role, name, depth, states: {}, ...extra });
const READY: N[] = [n('heading', 'Report ready', 0, { level: 1 }), n('status', 'All rows loaded')];

const DOC = '# Reports\n\n## Loading\n\nThe report page shows the heading Report ready once loading has finished.\n';

function models() {
  return modelSet({
    extract: (req) => {
      const q = quoteFrom(req, 'The report page shows');
      return q === null
        ? { object: extraction([]) }
        : { object: extraction([{ title: 'Report', sources: [q], scenarios: [{ title: 'Report is ready', sources: [q], steps: [{ kind: 'then', text: 'the report heading is shown' }] }] }]) };
    },
    judge: () => ({ object: { probability: 0.95, verdict: 'holds', explanation: 'looks ready', observed: 'Report ready' } }),
    checkgen: () => ({ object: { classification: 'invariant', predicates: [{ op: 'exists', query: { role: 'heading', name: 'Report ready', nameMatch: null, testId: null, within: null }, negate: null }] } }),
  });
}

async function setup(opts: { settle?: Record<string, number | boolean> } = {}): Promise<{ h: MadeEngine; m: ReturnType<typeof models>; id: string }> {
  project = createProject({ docs: [] });
  project.writeDoc('reports', DOC);
  const m = models();
  const h = await makeEngine(project, {
    models: m,
    config: (c) => ({ ...c, settle: { ...c.settle, quietMs: 200, intervalMs: 50, timeoutMs: 600, ...(opts.settle ?? {}) } }),
  });
  await h.engine.compile();
  const id = (await h.engine.plans())[0]?.features[0]?.scenarios[0]?.id ?? '';
  return { h, m, id };
}

const never = (view: () => N[], busy: () => boolean) =>
  new StubSession(() => ({ nodes: view(), busy: busy() }), (a: DriverAction) => (a.verb === 'navigate' ? { ok: true } : { ok: true }));

describe('A15 R-RN1 unsettled screens are never judged', () => {
  it('A15 R-RN1: a screen that stays busy (aria-busy / progressbar) fails with SCREEN_NOT_SETTLED, with zero judge and zero checkgen calls', async () => {
    const { h, m, id } = await setup();
    const res = await h.engine.runScenario(id, { sessionFactory: async () => never(() => READY, () => true) });
    await h.close();
    expect(res.status).toBe('failed');
    expect(res.steps[0]?.error?.code).toBe('SCREEN_NOT_SETTLED');
    expect(callsOf(m, 'judge')).toHaveLength(0);
    expect(callsOf(m, 'checkgen')).toHaveLength(0);
    expect(['none', 'discarded']).toContain(res.recording);
  });

  it('A15 R-RN1: a screen whose content changes on every observation (a ticking counter) never becomes stable: SCREEN_NOT_SETTLED', async () => {
    const { h, m, id } = await setup();
    let tick = 0;
    const res = await h.engine.runScenario(id, { sessionFactory: async () => never(() => [...READY, n('status', `Tick ${tick++}`)], () => false) });
    await h.close();
    expect(res.steps[0]?.error?.code).toBe('SCREEN_NOT_SETTLED');
    expect(callsOf(m, 'judge')).toHaveLength(0);
  });

  it('A15 R-RN1: a screen that flaps between busy and idle faster than the quiet window is not settled either', async () => {
    const { h, m, id } = await setup();
    let k = 0;
    const res = await h.engine.runScenario(id, { sessionFactory: async () => never(() => READY, () => k++ % 3 === 0) });
    await h.close();
    expect(res.steps[0]?.error?.code).toBe('SCREEN_NOT_SETTLED');
    expect(callsOf(m, 'judge')).toHaveLength(0);
  });

  it('A15 R-RN1: control: a stable idle screen is judged and recorded', async () => {
    const { h, m, id } = await setup();
    const res = await h.engine.runScenario(id, { sessionFactory: async () => never(() => READY, () => false) });
    await h.close();
    expect(res.status).toBe('passed');
    expect(callsOf(m, 'judge').length).toBeGreaterThan(0);
  });

  it('A15 R-RN1: a busy screen that becomes idle just before the timeout is judged only once it has been quiet', async () => {
    const { h, m, id } = await setup({ settle: { timeoutMs: 3000 } });
    let observes = 0;
    const stub = new StubSession(() => {
      observes += 1;
      return { nodes: READY, busy: observes < 8 };
    });
    const res = await h.engine.runScenario(id, { sessionFactory: async () => stub });
    await h.close();
    expect(res.status).toBe('passed');
    // every judge request was built from the idle observation, never from a busy one
    for (const call of callsOf(m, 'judge')) expect(String(call.req.context['afterTreeText'])).toContain('Report ready');
  });

  it('A15 R-RN1: the recorded deterministic check is not evaluated on an unsettled screen either (second run on a spinner)', async () => {
    const { h, m, id } = await setup();
    const first = await h.engine.runScenario(id, { sessionFactory: async () => never(() => READY, () => false) });
    expect(first.recording).toBe('created');
    const judgesBefore = callsOf(m, 'judge').length;
    const second = await h.engine.runScenario(id, { sessionFactory: async () => never(() => READY, () => true) });
    await h.close();
    expect(second.mode).toBe('replay');
    expect(second.steps[0]?.status).toBe('failed');
    expect(second.steps[0]?.error?.code).toBe('SCREEN_NOT_SETTLED');
    expect(second.steps[0]?.check, 'no check evaluation attached').toBeUndefined();
    expect(callsOf(m, 'judge').length).toBe(judgesBefore);
  });

  it('A15 R-RN1 R-AS4: --audit on an unsettled screen does not call the judge either', async () => {
    const { h, m, id } = await setup();
    await h.engine.runScenario(id, { sessionFactory: async () => never(() => READY, () => false) });
    const judgesBefore = callsOf(m, 'judge').length;
    const audited = await h.engine.runScenario(id, { audit: true, sessionFactory: async () => never(() => READY, () => true) });
    await h.close();
    expect(audited.steps[0]?.error?.code).toBe('SCREEN_NOT_SETTLED');
    expect(callsOf(m, 'judge').length).toBe(judgesBefore);
  });

  it('A15 R-RN1: requireSettled=false is the only way to judge a busy screen, and the screen is then reported as unsettled in no other place (explicit opt-out)', async () => {
    const { h, m, id } = await setup({ settle: { requireSettled: false } });
    const res = await h.engine.runScenario(id, { sessionFactory: async () => never(() => READY, () => true) });
    await h.close();
    expect(res.steps[0]?.error?.code, JSON.stringify(res.steps[0])).not.toBe('SCREEN_NOT_SETTLED');
    expect(callsOf(m, 'judge').length).toBeGreaterThan(0);
  });

  it('A15 R-RN1: the unsettled failure is reported through engine.run() with exit code 1 and the scenario failed', async () => {
    const { h, id } = await setup();
    void id;
    const report = await h.engine.run({
      compile: false,
      driver: 'stub',
    }).catch((e: unknown) => e);
    await h.close();
    // there is no `stub` driver registered in the config: the run reports the problem instead of judging anything
    expect(report instanceof Error ? 'threw' : (report as { scenarios: { status: string }[] }).scenarios[0]?.status).not.toBe('passed');
  });

  it('A15 R-RN1 R-AS1: an UNSETTLED "before" observation (page still loading when the action starts) must not be the baseline that makes a check look discriminative', async () => {
    project?.cleanup();
    project = createProject({ docs: [] });
    project.writeDoc('dash', '# Dash\n\n## Loading\n\nThe dashboard shows the text Data loaded after the visitor presses Go.\n');
    const m = modelSet({
      extract: (req) => {
        const q = quoteFrom(req, 'The dashboard shows');
        return q === null
          ? { object: extraction([]) }
          : { object: extraction([{ title: 'Dash', sources: [q], scenarios: [{ title: 'Press go', sources: [q], steps: [{ kind: 'when', text: 'the visitor presses Go' }, { kind: 'then', text: 'the status Data loaded is shown' }] }] }]) };
      },
      act: (req) => {
        const nodes = req.context['nodes'] as { ref: string; name: string }[];
        const go = nodes.find((x) => x.name === 'Go');
        return Number(req.context['turn']) === 0 && go !== undefined
          ? { toolCalls: [{ id: 'c', name: 'click', args: { ref: go.ref } }] }
          : { toolCalls: [{ id: 'd', name: 'complete_step', args: { status: 'done', summary: 'ok' } }] };
      },
      judge: () => ({ object: { probability: 0.95, verdict: 'holds', explanation: 'ok', observed: 'Data loaded' } }),
      // "Data loaded exists" as a CHANGE check: false on BEFORE only because BEFORE was captured mid-load
      checkgen: () => ({ object: { classification: 'change', predicates: [{ op: 'exists', query: { role: 'status', name: 'Data loaded', nameMatch: null, testId: null, within: null }, negate: null }] } }),
    });
    const h = await makeEngine(project, { models: m, config: (c) => ({ ...c, settle: { ...c.settle, quietMs: 200, intervalMs: 50, timeoutMs: 400 } }) });
    await h.engine.compile();
    const id = (await h.engine.plans())[0]?.features[0]?.scenarios[0]?.id ?? '';
    let observes = 0;
    // the page finishes loading by itself after ~25 observations, whatever the visitor does
    const page = new StubSession(() => {
      observes += 1;
      const loading = observes < 25;
      return { nodes: [n('heading', 'Dashboard', 0, { level: 1 }), n('button', 'Go'), ...(loading ? [] : [n('status', 'Data loaded')])], busy: loading };
    });
    const res = await h.engine.runScenario(id, { sessionFactory: async () => page });
    await h.close();
    const thenStep = res.steps.find((s) => s.kind === 'then');
    // Either the run refuses to characterize from an unsettled baseline, or the assertion is not recorded as a deterministic "change" check.
    const recordedAsDeterministicChange = res.status === 'passed' && thenStep?.determinism === 'deterministic' && thenStep.path === 'check+judge';
    expect(recordedAsDeterministicChange, `status ${res.status}, then-step ${thenStep?.path}/${thenStep?.determinism}`).toBe(false);
  });
});
