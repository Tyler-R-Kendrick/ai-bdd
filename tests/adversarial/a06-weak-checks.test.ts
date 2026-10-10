// Attack 6: get a volatile or non-discriminative check accepted (R-AS1, R-AS2, R-AS3).
import { afterEach, describe, expect, it } from 'vitest';
import { createAsserter, createRedactor, evaluatePredicates, resolveConfig } from '@ai-bdd/sdk';
import type { CheckGenRequest, JsonObject, ModelRequest, ObservedNode, Predicate } from '@ai-bdd/sdk/contracts';
import { callsOf, createProject, modelSet, observation, openEngine, overriding, readRecordings, scenarioId, type Project } from './helpers/kit.ts';
import { bestCpuMs } from '../../packages/sdk/test/kit/budget.ts';

type N = Omit<ObservedNode, 'ref'>;
const n = (role: string, name: string, depth = 0, extra: Partial<N> = {}): N => ({ role, name, depth, states: {}, ...extra });

const config = resolveConfig({}, { projectRoot: '/tmp/x', env: {} });
const redactor = createRedactor({});

const BEFORE: N[] = [n('heading', 'Billing', 0, { level: 1 }), n('region', 'Plan'), n('status', 'Plan: Free', 1), n('button', 'Upgrade', 1)];
const AFTER: N[] = [n('heading', 'Billing', 0, { level: 1 }), n('region', 'Plan'), n('status', 'Plan: Pro', 1), n('button', 'Downgrade', 1), n('status', 'Synced at 12:34:56', 0), n('status', 'Saved 3 minutes ago', 0)];

function generate(program: JsonObject, over: Partial<CheckGenRequest> = {}, afterProbe: N[] = AFTER) {
  const requests: ModelRequest[] = [];
  const model = {
    id: 'scripted:checkgen',
    async generate(req: ModelRequest) {
      requests.push(req);
      return { object: program, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' as const, modelId: 'scripted:checkgen' };
    },
  };
  const asserter = createAsserter({ model, redactor, config });
  const req: CheckGenRequest = {
    scenarioId: 's',
    stepKey: 'then:x',
    criterion: 'the plan changes to Pro',
    params: {},
    before: observation(BEFORE, { revision: 1 }),
    after: observation(AFTER, { revision: 2 }),
    afterProbe: observation(afterProbe, { revision: 3 }),
    actionPreceded: true,
    ...over,
  };
  return asserter.generate(req).then((res) => ({ res, requests }));
}

const q = (o: JsonObject): JsonObject => ({ role: null, name: null, nameMatch: null, testId: null, within: null, ...o });
const text = (query: JsonObject, literal: string, match: 'equals' | 'contains' = 'contains'): JsonObject => ({ op: 'text', query: q(query), match, value: { literal, param: null } });
const exists = (query: JsonObject, negate = false): JsonObject => ({ op: 'exists', query: q(query), negate });
const prog = (classification: 'change' | 'invariant', ...predicates: JsonObject[]): JsonObject => ({ classification, predicates });

describe('A6 R-AS2 volatile literals are rejected', () => {
  const volatiles: [string, string][] = [
    ['clock time', 'Synced at 12:34:56'],
    ['clock time with fraction', 'at 9:41:07.123'],
    ['iso date', 'on 2026-10-10 the'],
    ['us date', 'on 10/10/2026 the'],
    ['uuid', 'id 550e8400-e29b-41d4-a716-446655440000'],
    ['hex id', 'ref 3fa85f64'],
    ['long number', 'order 123456'],
    ['relative time', 'Saved 3 minutes ago'],
    ['upper case relative time', 'SAVED 3 MINUTES AGO'],
    ['just now', 'updated just now'],
    ['just   now with odd spaces', 'updated just   now'],
    ['clock time glued to letters is still a time', 'T12:34Z'],
  ];
  for (const [label, literal] of volatiles) {
    it(`A6 R-AS2: ${label} ("${literal}") in a text literal is rejected as volatile-content`, async () => {
      const { res } = await generate(prog('change', text({ role: 'status' }, literal)), {}, AFTER);
      expect(res.program, JSON.stringify(res.errors)).toBeUndefined();
      expect(res.fuzzyReasons.length).toBeGreaterThan(0);
    });
  }

  it('A6 R-AS2: the same volatile literal is allowed when the criterion itself states it (authored text)', async () => {
    const after = [...AFTER.filter((x) => !x.name.startsWith('Synced')), n('status', 'Report date 2026-10-10', 0)];
    const { res } = await generate(prog('change', text({ role: 'status', name: 'Report date 2026-10-10' }, 'Report date 2026-10-10', 'equals')), { criterion: 'the report date reads Report date 2026-10-10', after: observation(after, { revision: 2 }), afterProbe: observation(after, { revision: 3 }) }, after);
    expect(res.program).toBeDefined();
  });

  it('A6 R-AS2: a volatile literal smuggled through the name / within / route / testId parts of a query is also rejected', async () => {
    for (const p of [
      exists({ role: 'status', name: 'Synced at 12:34:56' }),
      exists({ role: 'status', name: 'x', within: { role: 'region', name: 'Saved 3 minutes ago' } }),
      { op: 'route', match: 'equals', value: '/orders/123456' },
      exists({ testId: '550e8400-e29b-41d4-a716-446655440000' }),
    ]) {
      const { res } = await generate(prog('change', p));
      expect(res.program, JSON.stringify(p)).toBeUndefined();
    }
  });

  it('A6 R-AS2: nodes that changed between the settled observation and the probe cannot be queried, by role-only, name-contains or exact name', async () => {
    const ticking = (s: string): N[] => [...AFTER.filter((x) => !x.name.startsWith('Synced')), n('status', s, 0)];
    const after = ticking('Clock tick alpha');
    const probe = ticking('Clock tick beta');
    for (const p of [text({ role: 'status', name: 'Clock tick alpha' }, 'Clock tick alpha', 'equals'), text({ role: 'status', name: 'Clock', nameMatch: 'contains' }, 'Clock', 'contains')]) {
      const { res } = await generate(prog('change', p), { after: observation(after, { revision: 2 }), afterProbe: observation(probe, { revision: 3 }) }, probe);
      expect(res.program, JSON.stringify(p)).toBeUndefined();
      expect(res.fuzzyReasons).toContain('volatile-content');
    }
  });

  it('A6 R-AS2: a program that holds on AFTER but not on the probe is rejected even when it names no volatile literal', async () => {
    const after = [...AFTER, n('status', 'Banner alpha')];
    const probe = [...AFTER];
    const { res } = await generate(prog('change', exists({ role: 'status', name: 'Banner alpha' })), { after: observation(after, { revision: 2 }), afterProbe: observation(probe, { revision: 3 }) }, probe);
    expect(res.program).toBeUndefined();
  });
});

describe('A6 R-AS1 non-discriminative checks', () => {
  it('A6 R-AS1: a "change" program that is already true on BEFORE is rejected (check-not-discriminative) on every attempt', async () => {
    const { res, requests } = await generate(prog('change', exists({ role: 'heading', name: 'Billing' })));
    expect(res.program).toBeUndefined();
    expect(res.fuzzyReasons).toContain('check-not-discriminative');
    expect(requests).toHaveLength(config.checks.maxAttempts);
  });

  it('A6 R-AS1: padding a trivial predicate with a discriminative one is fine, but a discriminative one with only vacuous companions still needs the discriminative part to be false before', async () => {
    const ok = await generate(prog('change', exists({ role: 'heading', name: 'Billing' }), text({ role: 'status', name: 'Plan: Pro' }, 'Pro', 'contains')));
    expect(ok.res.program?.classification).toBe('change');
    expect(ok.res.program?.verified.beforeFalse).toBe(true);
  });

  it('A6 R-AS1: with no preceding action the classification must be "invariant"; a "change" program is rejected', async () => {
    const { res } = await generate(prog('change', text({ role: 'status', name: 'Plan: Pro' }, 'Pro')), { actionPreceded: false });
    expect(res.program).toBeUndefined();
  });

  it('A6 R-AS1: a trivially true program labelled "invariant" AFTER an action is NOT accepted as a deterministic check (it would still pass if the action did nothing)', async () => {
    // The criterion is "the plan changes to Pro" (a change), the model calls the check "invariant" and asserts only
    // that the page heading exists: true before the action, true after, true after a regression.
    const { res } = await generate(prog('invariant', exists({ role: 'heading', name: 'Billing' })), { actionPreceded: true });
    expect(res.program, 'an invariant-labelled program that already holds BEFORE the action proves nothing about the action').toBeUndefined();
  });

  it('A6 R-AS1: vacuous predicates labelled "invariant" after an action (count >= 0, absent-element negation, route prefix "/") are not accepted either', async () => {
    const vacuous: JsonObject[] = [
      { op: 'count', query: q({ role: 'button' }), cmp: 'gte', value: 0 },
      exists({ role: 'dialog', name: 'Nothing like this exists' }, true),
      { op: 'route', match: 'prefix', value: '/' },
    ];
    for (const v of vacuous) {
      const { res } = await generate(prog('invariant', v), { actionPreceded: true });
      expect(res.program, JSON.stringify(v)).toBeUndefined();
    }
  });
});

describe('A6 R-AS3 the predicate DSL has no regex and evaluation is linear', () => {
  const obs = observation([n('heading', 'Billing (a+)+$ [x] .* ^start', 0, { level: 1 }), n('status', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!', 0)]);

  it('A6 R-AS3: regex metacharacters in names and literals are plain text', () => {
    const p = (op: Predicate): boolean => evaluatePredicates([op], obs, {})[0]?.satisfied === true;
    expect(p({ op: 'exists', query: { role: 'heading', name: '.*' } })).toBe(false);
    expect(p({ op: 'exists', query: { role: 'heading', name: 'g.*s', nameMatch: 'contains' } })).toBe(false);
    expect(p({ op: 'exists', query: { role: 'heading', name: 'billing (a+)+', nameMatch: 'contains' } })).toBe(true);
    expect(p({ op: 'exists', query: { role: 'heading', name: 'billing (a+)+$ [x] .* ^start' } })).toBe(true);
    expect(p({ op: 'text', query: { role: 'status' }, match: 'contains', value: { literal: '(a+)+$' } })).toBe(false);
    expect(p({ op: 'text', query: { role: 'status' }, match: 'equals', value: { literal: 'a*' } })).toBe(false);
    expect(p({ op: 'text', query: { role: 'status' }, match: 'contains', value: { literal: 'a!' } })).toBe(true);
  });

  it('A6 R-AS3: evaluation time grows linearly with tree size (no quadratic ancestor lookups, no backtracking)', () => {
    const build = (size: number): ReturnType<typeof observation> => {
      const nodes: N[] = [];
      for (let i = 0; i < size; i++) nodes.push(n(i % 3 === 0 ? 'region' : 'listitem', `item ${i % 50}`, Math.min(i % 400, 399)));
      return observation(nodes);
    };
    const preds: Predicate[] = Array.from({ length: 8 }, (_, i) => ({ op: 'count', query: { role: 'listitem', name: `item ${i}`, within: { role: 'region', name: `item ${i * 3}` } }, cmp: 'gte', value: 0 }));
    const time = (obsN: ReturnType<typeof observation>): number => {
      return bestCpuMs(3, () => void evaluatePredicates(preds, obsN, {}));
    };
    const small = time(build(5000));
    const big = time(build(40000));
    // 8x the nodes: a linear evaluator costs about 8x; a quadratic one 64x. Allow generous noise.
    expect(big).toBeLessThan(Math.max(small, 1) * 30);
    expect(big).toBeLessThan(10000);
  });

  it('A6 R-AS3: an unknown or regex-like predicate op never passes (unknown counts as failure)', async () => {
    const asserter = createAsserter({ model: { id: 'x', generate: async () => { throw new Error('no'); } }, redactor, config });
    const evaluation = asserter.evaluate(
      { classification: 'invariant', predicates: [{ op: 'regex', pattern: '.*', query: {} } as unknown as Predicate], generatedBy: { modelId: 'm', promptVersion: 'p' }, verified: { afterTrue: true, probeTrue: true, beforeFalse: null, judgePassed: true } },
      observation(AFTER),
      {},
    );
    expect(evaluation.passed).toBe(false);
    expect(asserter.evaluate({ classification: 'invariant', predicates: [], generatedBy: { modelId: 'm', promptVersion: 'p' }, verified: { afterTrue: true, probeTrue: true, beforeFalse: null, judgePassed: true } }, observation(AFTER), {}).passed).toBe(false);
  });
});

describe('A6 R-AS1 end to end: a vacuous check must not silently pass a regressed feature', () => {
  let project: Project | undefined;
  afterEach(() => {
    project?.cleanup();
    project = undefined;
  });

  it('A6 R-AS1 R-CH1: checkgen answers the "plan changes to Pro" assertion with an invariant heading check; the recorded check must not be the thing that later passes a regressed app', async () => {
    project = createProject({ docs: ['billing'] });
    const trivial = overriding('checkgen', (req) =>
      String(req.context['criterion']) === 'the plan changes to Pro'
        ? { object: { classification: 'invariant', predicates: [{ op: 'exists', query: q({ role: 'heading', name: 'Billing' }), negate: null }] } }
        : undefined,
    );
    const h1 = await openEngine(project, { models: trivial });
    await h1.compile();
    const id = scenarioId(await h1.plans(), 'Upgrade from Free to Pro');
    const first = await h1.runScenario(id);
    await h1.close();
    expect(first.status).toBe('passed');
    const rec = readRecordings(project)[0]?.recording;
    const step = rec?.steps.find((s) => s.stepKey.startsWith('then') && s.check?.predicates.some((p) => p.op === 'exists' && p.query.name === 'Billing'));

    // Regress the app. The act steps may heal; the assertion is the only guard of "the plan changes to Pro".
    const h2 = await openEngine(project, { prepare: { flags: ['bug-upgrade-noop'] }, layers: ['bug-heal-done', 'base'] });
    const second = await h2.runScenario(id);
    const planStep = second.steps.find((s) => s.text === 'the plan changes to Pro');
    await h2.close();
    expect(planStep?.status, 'the regressed app (plan stays Free) must not satisfy "the plan changes to Pro"').not.toBe('passed');
    void step;
    void callsOf;
    void modelSet;
  });
});
