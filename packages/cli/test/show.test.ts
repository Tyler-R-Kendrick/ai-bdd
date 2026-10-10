import { describe, expect, it, vi } from 'vitest';
import { AiBddError, type ChunkRef, type DocPlan, type Feature, type Scenario, type ScenarioRecording, type Step, type StepRecording } from '@ai-bdd/sdk/contracts';
import { renderSelection, selectPlans, sourceLines } from '../src/commands/show.ts';
import { makePlan, runCli } from './helpers.ts';

const H = 'a'.repeat(64);
const ref = (chunkId: string, over: Partial<ChunkRef> = {}): ChunkRef => ({ chunkId, hash: H, relation: 'source', ...over });
const range = (startLine: number) => ({ startLine, startColumn: 1, endLine: startLine, endColumn: 9 });
const step = (key: string, over: Partial<Step> = {}): Step => ({ key, kind: 'given', text: `text of ${key}`, grounding: 'quoted', sources: [], params: {}, ...over });
const scenario = (id: string, over: Partial<Scenario> = {}): Scenario => ({
  id, featureId: 'f1', title: `Title ${id}`, tags: [], sources: [], steps: [], review: 'unreviewed', fingerprint: H, ...over,
});
const feature = (id: string, scenarios: Scenario[], over: Partial<Feature> = {}): Feature => ({
  id, docUri: 'docs/a.md', sectionId: 'docs/a.md#s', title: `Feature ${id}`, tags: [], sources: [], scenarios, review: 'unreviewed', fingerprint: H, ...over,
});
const plan = (docUri: string, features: Feature[], over: Partial<DocPlan> = {}): DocPlan => ({
  schemaVersion: 1, docUri, docSha256: H, extractor: { modelId: 'm', promptVersion: 'p' }, sections: [],
  chunks: [{ id: 'c1', hash: H, kind: 'paragraph', range: range(4), excerpt: 'Hello   world\nsecond  line' }],
  features, notTestable: [], rejected: [], uncovered: [], ...over,
});

describe('selectPlans', () => {
  const a = plan('docs/a.md', [feature('docs-a--one', [scenario('docs-a--one/s1'), scenario('docs-a--one/s2')]), feature('docs-a--two', [scenario('docs-a--two/s1')])]);
  const b = plan('docs/b.md', [feature('docs-b--three', [scenario('docs-b--three/s1')])]);
  const ids = (sels: ReturnType<typeof selectPlans>) => sels.map((s) => [s.plan.docUri, s.features.map((f) => [f.id, f.scenarios.map((x) => x.id)])]);

  it('no query or an empty query selects every plan as a whole document', () => {
    for (const q of [undefined, '']) {
      const sels = selectPlans([a, b], q);
      expect(sels.map((s) => s.plan.docUri)).toEqual(['docs/a.md', 'docs/b.md']);
      expect(sels.every((s) => s.wholeDoc)).toBe(true);
      expect(sels[0]?.features).toBe(a.features);
    }
  });

  it('a doc path selects that document; ./ prefixes and backslashes are normalized', () => {
    for (const q of ['docs/b.md', './docs/b.md', 'docs\\b.md', '.\\docs\\b.md']) {
      const sels = selectPlans([a, b], q);
      expect(sels).toHaveLength(1);
      expect(sels[0]).toMatchObject({ wholeDoc: true, plan: b });
    }
  });

  it('an exact feature id selects that feature with all its scenarios, not the whole document', () => {
    const sels = selectPlans([a, b], 'docs-a--two');
    expect(ids(sels)).toEqual([['docs/a.md', [['docs-a--two', ['docs-a--two/s1']]]]]);
    expect(sels[0]?.wholeDoc).toBe(false);
    expect(sels[0]?.scenarioId).toBeUndefined();
  });

  it('an exact scenario id selects only that scenario and records its id', () => {
    const sels = selectPlans([a, b], 'docs-a--one/s2');
    expect(ids(sels)).toEqual([['docs/a.md', [['docs-a--one', ['docs-a--one/s2']]]]]);
    expect(sels[0]).toMatchObject({ scenarioId: 'docs-a--one/s2', wholeDoc: false });
  });

  it('a feature id prefix selects the matching features with all their scenarios', () => {
    const sels = selectPlans([a, b], 'docs-a--');
    expect(ids(sels)).toEqual([['docs/a.md', [['docs-a--one', ['docs-a--one/s1', 'docs-a--one/s2']], ['docs-a--two', ['docs-a--two/s1']]]]]);
  });

  it('a scenario id prefix keeps only the matching scenarios, per feature, across plans', () => {
    const sels = selectPlans([a, b], 'docs-a--one/s');
    expect(ids(sels)).toEqual([['docs/a.md', [['docs-a--one', ['docs-a--one/s1', 'docs-a--one/s2']]]]]);
    const slash = selectPlans([a, b], 'docs-b--three/');
    expect(ids(slash)).toEqual([['docs/b.md', [['docs-b--three', ['docs-b--three/s1']]]]]);
  });

  it('an exact match takes precedence over prefix matches', () => {
    const p = plan('docs/p.md', [feature('x', [scenario('x/1')]), feature('x-long', [scenario('x-long/1')])]);
    expect(ids(selectPlans([p], 'x'))).toEqual([['docs/p.md', [['x', ['x/1']]]]]);
  });

  it('a doc path beats a feature id of the same text', () => {
    const p = plan('same', [feature('same', [scenario('same/1')])]);
    expect(selectPlans([p], 'same')[0]?.wholeDoc).toBe(true);
  });

  it('nothing matching is SCENARIO_NOT_FOUND naming the query as typed', () => {
    let error: unknown;
    try {
      selectPlans([a, b], './nope');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AiBddError);
    expect((error as AiBddError).code).toBe('SCENARIO_NOT_FOUND');
    expect((error as AiBddError).message).toBe('No document, feature or scenario matches "./nope".');
  });
});

describe('sourceLines', () => {
  const p = plan('docs/a.md', []);
  it('resolves the line from the chunk range and prefers the quote over the chunk excerpt, with whitespace collapsed', () => {
    expect(sourceLines(p, [ref('c1', { quote: '  a   quoted\n text ' })])).toEqual(['# source: docs/a.md:4 "a quoted text"']);
    expect(sourceLines(p, [ref('c1')])).toEqual(['# source: docs/a.md:4 "Hello world second line"']);
  });
  it('uses "?" for an unknown chunk and an empty quote when there is nothing to quote', () => {
    expect(sourceLines(p, [ref('missing')])).toEqual(['# source: docs/a.md:? ""']);
    expect(sourceLines(p, [ref('missing', { quote: 'q' })])).toEqual(['# source: docs/a.md:? "q"']);
  });
  it('labels context refs and appends the note', () => {
    expect(sourceLines(p, [ref('c1', { relation: 'context', quote: 'q' })], ' [n]')).toEqual(['# source: docs/a.md:4 "q" (context) [n]']);
    expect(sourceLines(p, [ref('c1', { quote: 'q' })], ' [n]')).toEqual(['# source: docs/a.md:4 "q" [n]']);
  });
  it('returns one line per ref, in order, and none for no refs', () => {
    expect(sourceLines(p, [ref('c1', { quote: 'one' }), ref('missing', { quote: 'two' })])).toEqual(['# source: docs/a.md:4 "one"', '# source: docs/a.md:? "two"']);
    expect(sourceLines(p, [])).toEqual([]);
  });
});

describe('renderSelection', () => {
  const whole = (p: DocPlan) => ({ plan: p, features: p.features, wholeDoc: true });

  it('renders a feature without story, flags or tags minimally, and a scenario with no sources or steps', () => {
    const p = plan('docs/a.md', [feature('f1', [scenario('f1/s1', { review: 'accepted' })], { review: 'accepted' })]);
    expect(renderSelection(whole(p), new Map(), false)).toEqual([
      '# docs/a.md',
      '',
      'Feature: Feature f1  [accepted]',
      '  # id: f1',
      '',
      '  Scenario: Title f1/s1  [accepted]',
      '    # id: f1/s1',
      '',
    ]);
  });

  it('renders tags with @ added where missing, story with and without "So that", a one-line description and feature sources', () => {
    const f = feature('f1', [], {
      tags: ['@smoke', 'billing'], pinned: true, review: 'accepted', description: 'Some\n   multi line   text',
      story: { asA: 'admin', iWant: 'to export' }, sources: [ref('c1', { quote: 'feature quote' })],
    });
    const g = feature('f2', [], { story: { asA: 'user', iWant: 'to log in', soThat: 'I can work' } });
    const out = renderSelection(whole(plan('docs/a.md', [f, g])), new Map(), false);
    expect(out).toEqual([
      '# docs/a.md',
      '',
      '@smoke @billing',
      'Feature: Feature f1  [accepted, pinned]',
      '  # id: f1',
      '  As a admin',
      '  I want to export',
      '  Some multi line text',
      '  # source: docs/a.md:4 "feature quote"',
      '',
      'Feature: Feature f2  [unreviewed]',
      '  # id: f2',
      '  As a user',
      '  I want to log in',
      '  So that I can work',
      '',
    ]);
  });

  it('renders scenario tags, driver and start url in the state, and every step annotation', () => {
    const s = scenario('f1/s1', {
      tags: ['@a', 'b'], driver: 'web', startUrl: '/start', review: 'accepted', sources: [ref('c1', { quote: 'scenario quote' })],
      steps: [
        step('given:1', { kind: 'given', grounding: 'inferred' }),
        step('when:2', { kind: 'when', sources: [ref('c1', { quote: 'own quote' })], params: { plan: 'Pro', n: '3' } }),
        step('then:3', { kind: 'then', nature: 'subjective', requiresState: true }),
        step('then:4', { kind: 'then', nature: 'objective', fixture: { name: 'seed', args: { a: 1 } }, requiresState: true }),
      ],
    });
    const out = renderSelection({ plan: plan('docs/a.md', [feature('f1', [s])]), features: [feature('f1', [s])], wholeDoc: false }, new Map(), false);
    const i = out.indexOf('  @a @b');
    expect(out.slice(i)).toEqual([
      '  @a @b',
      '  Scenario: Title f1/s1  [accepted, driver=web, start=/start]',
      '    # id: f1/s1',
      '    # source: docs/a.md:4 "scenario quote"',
      '    Given text of given:1',
      '      # source: docs/a.md:4 "scenario quote" [scenario source]',
      '      # inferred step (no verbatim quote)',
      '    When text of when:2',
      '      # source: docs/a.md:4 "own quote"',
      '      # params: plan="Pro" n="3"',
      '    Then text of then:3',
      '      # source: docs/a.md:4 "scenario quote" [scenario source]',
      '      # subjective: judged by the model on every run',
      '      # requires state: no fixture configured, scenario will be blocked',
      '    Then text of then:4',
      '      # source: docs/a.md:4 "scenario quote" [scenario source]',
      '      # fixture: seed {"a":1}',
      '',
    ]);
  });

  it('marks a step without any source (own or scenario) as "(none)"', () => {
    const s = scenario('f1/s1', { steps: [step('given:1')] });
    const out = renderSelection(whole(plan('docs/a.md', [feature('f1', [s])])), new Map(), false);
    expect(out).toContain('      # source: (none)');
  });

  it('only a whole-document selection lists not-testable and uncovered chunks', () => {
    const p = plan('docs/a.md', [], { notTestable: [{ chunkId: 'c1', reason: 'latency target' }, { chunkId: 'c2', reason: 'vague' }], uncovered: ['c3'] });
    expect(renderSelection(whole(p), new Map(), false)).toEqual([
      '# docs/a.md', '', 'Not testable:', '  - c1: latency target', '  - c2: vague', '', 'Uncovered:', '  - c3', '',
    ]);
    expect(renderSelection({ ...whole(p), wholeDoc: false }, new Map(), false)).toEqual(['# docs/a.md', '']);
    const onlyUncovered = plan('docs/a.md', [], { uncovered: ['c3'] });
    expect(renderSelection(whole(onlyUncovered), new Map(), false)).toEqual(['# docs/a.md', '', 'Uncovered:', '  - c3', '']);
  });

  describe('with recordings', () => {
    const rec = (steps: Partial<StepRecording>[]): ScenarioRecording => ({
      schemaVersion: 1, scenarioId: 'f1/s1', scenarioFingerprint: H, driver: { id: 'web', major: 1 },
      promptVersions: { act: 'a', checkgen: 'c', judge: 'j' },
      steps: steps.map((s, i) => ({ stepKey: `k${i}`, stepTextHash: H, kind: 'given' as const, determinism: 'deterministic' as const, fuzzyReasons: [], stats: { healCount: 0 }, ...s })),
    });
    const s = scenario('f1/s1', { steps: [step('k0'), step('k1'), step('k2')] });
    const p = plan('docs/a.md', [feature('f1', [s])]);
    const notes = (r: ScenarioRecording | undefined) =>
      renderSelection({ plan: p, features: p.features, wholeDoc: false }, new Map(r ? [['f1/s1', r]] : []), true)
        .filter((l) => /^ {6}# (recording|determinism|replay|check|healed)/.test(l))
        .map((l) => l.trim());

    it('without a recording every step says "# recording: none"', () => {
      expect(notes(undefined)).toEqual(['# recording: none', '# recording: none', '# recording: none']);
    });

    it('renders determinism, fuzzy reasons, replay actions, check summary and heal counts for recorded steps', () => {
      const r = rec([
        { determinism: 'deterministic', act: { actions: [{}, {}] } as never, check: { classification: 'change', predicates: [{}, {}, {}] } as never },
        { determinism: 'fuzzy', fuzzyReasons: ['subjective', 'volatile-content'], stats: { healCount: 2 } },
        { determinism: 'deterministic' },
      ]);
      expect(notes(r)).toEqual([
        '# determinism: deterministic',
        '# replay: 2 action(s)',
        '# check: change, 3 predicate(s)',
        '# determinism: fuzzy (subjective, volatile-content)',
        '# healed: 2 time(s)',
        '# determinism: deterministic',
      ]);
    });

    it('steps after the first divergence from the recording are reported as not recorded or invalidated', () => {
      const r = rec([{}, { stepKey: 'other-key', determinism: 'fuzzy', fuzzyReasons: ['subjective'] }, {}]);
      expect(notes(r)).toEqual([
        '# determinism: deterministic',
        '# recording: none (not recorded or invalidated by an earlier change)',
        '# recording: none (not recorded or invalidated by an earlier change)',
      ]);
    });

    it('a recording that is shorter than the scenario leaves the extra steps unrecorded', () => {
      expect(notes(rec([{}]))).toEqual([
        '# determinism: deterministic',
        '# recording: none (not recorded or invalidated by an earlier change)',
        '# recording: none (not recorded or invalidated by an earlier change)',
      ]);
    });

    it('a recording that is longer than the scenario does not add notes', () => {
      expect(notes(rec([{}, {}, {}, {}]))).toHaveLength(3);
    });

    it('without --recordings no recording notes are printed even if one exists', () => {
      const out = renderSelection({ plan: p, features: p.features, wholeDoc: false }, new Map([['f1/s1', rec([{}, {}, {}])]]), false);
      expect(out.join('\n')).not.toContain('recording');
      expect(out.join('\n')).not.toContain('determinism');
    });
  });
});

describe('show command', () => {
  const engine = () => ({ plans: vi.fn(async () => [makePlan()]) });

  it('prints a hint when there are no plans and no query (exit 0)', async () => {
    const h = await runCli(['show']);
    expect(h.code).toBe(0);
    expect(h.stdout).toBe('No plans found. Run `ai-bdd compile` first.\n');
  });

  it('a query with no plans at all is SCENARIO_NOT_FOUND (exit 2)', async () => {
    const h = await runCli(['show', 'anything']);
    expect(h.code).toBe(2);
    expect(h.stderr).toBe('ai-bdd: error [SCENARIO_NOT_FOUND]: No document, feature or scenario matches "anything".\n');
  });

  it('--json with no plans prints an empty docs list and no query key', async () => {
    const h = await runCli(['show', '--json']);
    expect(h.code).toBe(0);
    expect(JSON.parse(h.stdout)).toStrictEqual({ docs: [] });
  });

  it('--json includes the query as typed, and notTestable/uncovered only for a whole-document selection', async () => {
    const whole = await runCli(['show', 'docs/billing.md', '--json'], { engine: engine() });
    const w = JSON.parse(whole.stdout);
    expect(w.query).toBe('docs/billing.md');
    expect(w.docs[0].notTestable).toEqual(makePlan().notTestable);
    expect(w.docs[0].uncovered).toEqual(makePlan().uncovered);
    expect(w.docs[0].features).toHaveLength(1);
    const one = await runCli(['show', 'docs-billing--upgrading', '--json'], { engine: engine() });
    const o = JSON.parse(one.stdout);
    expect(o.query).toBe('docs-billing--upgrading');
    expect(o.docs[0]).not.toHaveProperty('notTestable');
    expect(o.docs[0]).not.toHaveProperty('uncovered');
    const all = await runCli(['show', '--json'], { engine: engine() });
    expect(JSON.parse(all.stdout)).not.toHaveProperty('query');
  });

  describe('--recordings store lookup', () => {
    const recording = (scenarioId: string, mark: string): ScenarioRecording => ({
      schemaVersion: 1, scenarioId, scenarioFingerprint: H, driver: { id: mark, major: 1 }, promptVersions: { act: 'a', checkgen: 'c', judge: 'j' }, steps: [],
    });
    const store = (listed: { driverId: string; scenarioId: string }[], recs: Record<string, ScenarioRecording | null> = {}) => {
      const load = vi.fn(async (driverId: string, id: string) => recs[`${driverId}/${id}`] ?? null);
      const create = vi.fn(() => ({ dir: 'x', mode: 'read-only' as const, load, save: vi.fn(), remove: vi.fn(), list: vi.fn(async () => listed) }));
      return { load, create };
    };
    const ID = 'docs-billing--upgrading/upgrade-to-pro';
    const show = (s: ReturnType<typeof store>, config: Parameters<typeof runCli>[1] = {}) =>
      runCli(['show', ID, '--json', '--recordings'], { engine: engine(), deps: { createRecordingStore: s.create as never }, ...config });

    it('prefers the scenario driver, then the default driver, then the first recorded driver', async () => {
      const listed = [{ driverId: 'mobile', scenarioId: ID }, { driverId: 'web', scenarioId: ID }];
      const recs = { [`web/${ID}`]: recording(ID, 'web'), [`mobile/${ID}`]: recording(ID, 'mobile') };

      const byDefault = store(listed, recs);
      const a = await show(byDefault, { config: { defaultDriver: 'web' } });
      expect(byDefault.load).toHaveBeenCalledWith('web', ID);
      expect(JSON.parse(a.stdout).recordings[ID].driver.id).toBe('web');

      const first = store(listed, recs);
      await show(first, { config: { defaultDriver: 'other' } });
      expect(first.load).toHaveBeenCalledWith('mobile', ID);

      const undef = store(listed, recs);
      await show(undef, { config: { defaultDriver: undefined } as never });
      expect(undef.load).toHaveBeenCalledWith('mobile', ID);

      const plan2 = makePlan();
      const scn = plan2.features[0]?.scenarios[0];
      if (scn) scn.driver = 'mobile';
      const bySc = store(listed, recs);
      const b = await runCli(['show', ID, '--json', '--recordings'], {
        engine: { plans: vi.fn(async () => [plan2]) }, deps: { createRecordingStore: bySc.create as never }, config: { defaultDriver: 'web' },
      });
      expect(bySc.load).toHaveBeenCalledWith('mobile', ID);
      expect(JSON.parse(b.stdout).recordings[ID].driver.id).toBe('mobile');
    });

    it('does not load anything for a scenario that has no recording, and tolerates a store that returns null', async () => {
      const none = store([]);
      const a = await show(none);
      expect(none.load).not.toHaveBeenCalled();
      expect(JSON.parse(a.stdout).recordings).toEqual({});
      const missing = store([{ driverId: 'web', scenarioId: ID }], { [`web/${ID}`]: null });
      const b = await show(missing);
      expect(missing.load).toHaveBeenCalledOnce();
      expect(JSON.parse(b.stdout).recordings).toEqual({});
    });

    it('opens the store read-only on the configured recordings dir, exactly once, and not at all without --recordings', async () => {
      const s = store([]);
      await show(s, { config: { recordingsDir: '/custom/rec' } });
      expect(s.create).toHaveBeenCalledOnce();
      expect(s.create).toHaveBeenCalledWith({ dir: '/custom/rec', mode: 'read-only' });
      const unused = store([]);
      await runCli(['show', ID], { engine: engine(), deps: { createRecordingStore: unused.create as never } });
      expect(unused.create).not.toHaveBeenCalled();
    });

    it('sorts the recordings by scenario id in --json output', async () => {
      const ids = ['docs-billing--upgrading/upgrade-to-pro', 'docs-billing--upgrading/upgrade-needs-account'];
      const s = store(ids.map((scenarioId) => ({ driverId: 'web', scenarioId })), Object.fromEntries(ids.map((i) => [`web/${i}`, recording(i, 'web')])));
      const h = await runCli(['show', 'docs-billing--upgrading', '--json', '--recordings'], { engine: engine(), deps: { createRecordingStore: s.create as never } });
      expect(Object.keys(JSON.parse(h.stdout).recordings)).toEqual([...ids].sort());
    });

    it('sorts any number of recordings, whatever the plan order', async () => {
      const p = makePlan();
      const base = p.features[0]?.scenarios[0];
      if (!base) throw new Error('fixture has no scenario');
      const mk = (name: string): Scenario => ({ ...base, id: `docs-billing--upgrading/${name}` });
      const first = p.features[0];
      if (first) first.scenarios = ['m', 'z', 'a', 'q', 'b'].map(mk);
      const sid = (n: string) => `docs-billing--upgrading/${n}`;
      const s = store(['m', 'z', 'a', 'q', 'b'].map((n) => ({ driverId: 'web', scenarioId: sid(n) })), Object.fromEntries(['m', 'z', 'a', 'q', 'b'].map((n) => [`web/${sid(n)}`, recording(sid(n), 'web')])));
      const h = await runCli(['show', '--json', '--recordings'], { engine: { plans: vi.fn(async () => [p]) }, deps: { createRecordingStore: s.create as never } });
      expect(Object.keys(JSON.parse(h.stdout).recordings)).toEqual(['a', 'b', 'm', 'q', 'z'].map(sid));
    });
  });
});
