// @ts-nocheck
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEngine, loadConfig, loadPlansSync } from '@ai-bdd/sdk';
import { sessionFromPage } from '@ai-bdd/driver-playwright';
import type { DriverSession, ScenarioResult, SessionOptions } from '@ai-bdd/sdk/contracts';
import { closeAiBddEngines, registerAiBddScenarios, resolvePlanDir } from '../src/index.ts';
import {
  fakeConfig,
  fakeEngine,
  fakeTestInfo,
  feature,
  plan,
  recordingTest,
  result,
  scenario,
  step,
  type FakeEngine,
} from './helpers/doubles.ts';

vi.mock('@ai-bdd/sdk', () => ({ loadPlansSync: vi.fn(), loadConfig: vi.fn(), createEngine: vi.fn() }));
vi.mock('@ai-bdd/driver-playwright', () => ({ sessionFromPage: vi.fn() }));

const loadPlans = vi.mocked(loadPlansSync);
const loadCfg = vi.mocked(loadConfig);
const makeEngine = vi.mocked(createEngine);
const toSession = vi.mocked(sessionFromPage);

const UPGRADE_ID = 'docs-billing--upgrading/upgrade-to-pro';
const billing = () =>
  plan('docs/billing.md', [
    feature('docs-billing--upgrading', 'Upgrading to Pro', [
      scenario(UPGRADE_ID, 'Upgrade to Pro', { tags: ['billing', 'smoke'] }),
      scenario('docs-billing--upgrading/rejected-one', 'A rejected scenario', { review: 'rejected' }),
    ]),
    feature('docs-billing--downgrading', 'Downgrading', [
      scenario('docs-billing--downgrading/downgrade', 'Downgrade to Free', { tags: ['@billing'] }),
    ]),
  ]);

let engine: FakeEngine;
const page = { fakePage: true } as unknown as Parameters<typeof sessionFromPage>[0];

beforeEach(() => {
  engine = fakeEngine(() => Promise.resolve(result()));
  loadPlans.mockReset().mockReturnValue([billing()]);
  loadCfg.mockReset().mockResolvedValue(fakeConfig());
  makeEngine.mockReset().mockResolvedValue(engine);
  toSession.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  await closeAiBddEngines();
  vi.restoreAllMocks();
});

async function runFirst(rec: ReturnType<typeof recordingTest>, index = 0) {
  const info = fakeTestInfo();
  const t = rec.tests[index];
  if (t === undefined) throw new Error('no such test');
  await t.body({ page }, info);
  return info;
}

describe('registration (R-SDK1)', () => {
  it('R-SDK1 registers every test synchronously and touches no engine, model, driver or config', () => {
    const rec = recordingTest();
    registerAiBddScenarios({ test: rec.test, planDir: '/p/plans' });
    // No await happened: the tests already exist.
    expect(rec.tests.map((t) => t.fullTitle)).toEqual([
      'Upgrading to Pro > Upgrade to Pro',
      'Downgrading > Downgrade to Free',
    ]);
    expect(loadPlans).toHaveBeenCalledTimes(1);
    expect(loadPlans).toHaveBeenCalledWith('/p/plans');
    expect(loadCfg).not.toHaveBeenCalled();
    expect(makeEngine).not.toHaveBeenCalled();
    expect(toSession).not.toHaveBeenCalled();
  });

  it('R-SDK1 declares test.describe(feature.title) around test(scenario.title) with @-prefixed tags', () => {
    const rec = recordingTest();
    registerAiBddScenarios({ test: rec.test });
    expect(rec.describes).toEqual(['Upgrading to Pro', 'Downgrading']);
    const [first, second] = rec.tests;
    expect(first?.path).toEqual(['Upgrading to Pro']);
    expect(first?.details).toEqual({ tag: ['@billing', '@smoke'] });
    // A tag that already carries the @ is not doubled.
    expect(second?.details).toEqual({ tag: ['@billing'] });
  });

  it('R-SDK1 normalizes, sanitizes and de-duplicates tags', () => {
    loadPlans.mockReturnValue([
      plan('docs/a.md', [feature('a--f', 'F', [scenario('a--f/s', 'S', { tags: ['smoke', '@smoke', 'two words', ' ', '@@x'] })])]),
    ]);
    const rec = recordingTest();
    registerAiBddScenarios({ test: rec.test });
    expect(rec.tests[0]?.details.tag).toEqual(['@smoke', '@two-words', '@x']);
  });

  it('R-SDK1 skips rejected scenarios and rejected features', () => {
    const p = billing();
    p.features.push(
      feature('docs-billing--gone', 'Rejected feature', [scenario('docs-billing--gone/x', 'X', { review: 'rejected' })], {
        review: 'rejected',
      }),
    );
    loadPlans.mockReturnValue([p]);
    const rec = recordingTest();
    registerAiBddScenarios({ test: rec.test });
    expect(rec.tests.map((t) => t.title)).toEqual(['Upgrade to Pro', 'Downgrade to Free']);
    expect(rec.describes).not.toContain('Rejected feature');
  });

  it('R-SDK1 honors the filter (selectors, tags, grep) and never resurrects a rejected scenario', () => {
    const titles = (filter: Parameters<typeof registerAiBddScenarios>[0]['filter']) => {
      const rec = recordingTest();
      registerAiBddScenarios({ test: rec.test, filter });
      return rec.tests.map((t) => t.title);
    };
    expect(titles({ selectors: [UPGRADE_ID] })).toEqual(['Upgrade to Pro']);
    expect(titles({ selectors: ['docs-billing--downgrading/'] })).toEqual(['Downgrade to Free']);
    expect(titles({ selectors: ['docs-billing--'] })).toEqual(['Upgrade to Pro', 'Downgrade to Free']);
    expect(titles({ selectors: ['docs/*.md'] })).toEqual(['Upgrade to Pro', 'Downgrade to Free']);
    expect(titles({ selectors: ['docs/other.md'] })).toEqual([]);
    expect(titles({ tags: ['smoke'] })).toEqual(['Upgrade to Pro']);
    expect(titles({ tags: ['@billing'] })).toEqual(['Upgrade to Pro', 'Downgrade to Free']);
    expect(titles({ grep: 'DOWNGRADE' })).toEqual(['Downgrade to Free']);
    expect(titles({ grep: 'rejected' })).toEqual([]);
    expect(titles({ selectors: [], tags: [], grep: '' })).toEqual(['Upgrade to Pro', 'Downgrade to Free']);
  });

  it('R-SDK1 keeps titles unique and stable when titles repeat across features, docs and scenarios', () => {
    loadPlans.mockReturnValue([
      plan('docs/a.md', [
        feature('a--login', 'Login', [scenario('a--login/ok', 'Works'), scenario('a--login/ok-2', 'Works')]),
      ]),
      plan('docs/b.md', [feature('b--login', 'Login', [scenario('b--login/ok', 'Works')])]),
    ]);
    const full = () => {
      const rec = recordingTest();
      registerAiBddScenarios({ test: rec.test });
      return rec.tests.map((t) => t.fullTitle);
    };
    const first = full();
    expect(new Set(first).size).toBe(3);
    expect(first).toEqual([
      'Login > Works',
      'Login > Works (a--login/ok-2)',
      'Login (docs/b.md) > Works',
    ]);
    expect(full()).toEqual(first);
  });

  it('R-SDK1 resolves the plan directory without loading any config', () => {
    const cwd = process.cwd();
    expect(resolvePlanDir({})).toBe(resolve(cwd, '.ai-bdd/plans'));
    expect(resolvePlanDir({ planDir: 'custom/plans' })).toBe(resolve(cwd, 'custom/plans'));
    expect(resolvePlanDir({ configPath: '/proj/sub/ai-bdd.config.mjs' })).toBe('/proj/sub/.ai-bdd/plans');
    expect(resolvePlanDir({ configPath: '/proj/sub/ai-bdd.config.mjs', planDir: 'p' })).toBe('/proj/sub/p');
    expect(resolvePlanDir({ configPath: '/proj/ai-bdd.config.mjs', planDir: '/abs/plans' })).toBe('/abs/plans');
  });

  it('R-SDK1 propagates plan loading errors at collection time (PLAN_CORRUPT)', () => {
    loadPlans.mockImplementation(() => {
      throw Object.assign(new Error('bad plan'), { code: 'PLAN_CORRUPT' });
    });
    expect(() => registerAiBddScenarios({ test: recordingTest().test })).toThrow('bad plan');
  });

  it('R-SDK1 warns instead of silently registering nothing, and registers no teardown then', () => {
    loadPlans.mockReturnValue([]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const rec = recordingTest();
    registerAiBddScenarios({ test: rec.test, planDir: '/empty' });
    expect(rec.tests).toEqual([]);
    expect(rec.afterAll).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no scenarios registered from /empty'));
  });
});

describe('engine and session wiring (R-SDK3)', () => {
  it('R-SDK3 runs the scenario through engine.runScenario with a sessionFactory adopting the Playwright page', async () => {
    const config = fakeConfig({ baseURL: 'http://localhost:3999', policy: { allowHosts: ['localhost'], denyVerbs: ['hover'] } });
    engine = fakeEngine(() => Promise.resolve(result()), config);
    loadCfg.mockResolvedValue(config);
    makeEngine.mockResolvedValue(engine);
    const adopted = { id: 'pw-1' } as unknown as DriverSession;
    toSession.mockResolvedValue(adopted);

    const rec = recordingTest();
    registerAiBddScenarios({ test: rec.test, configPath: '/proj/ai-bdd.config.mjs' });
    await runFirst(rec);

    expect(loadCfg).toHaveBeenCalledWith({ cwd: process.cwd(), configPath: '/proj/ai-bdd.config.mjs' });
    expect(makeEngine).toHaveBeenCalledWith(config);
    expect(engine.runCalls).toHaveLength(1);
    const call = engine.runCalls[0];
    expect(call?.id).toBe(UPGRADE_ID);
    expect(Object.keys(call?.opts ?? {})).toEqual(['sessionFactory']);

    const sessionOpts = { scenarioId: UPGRADE_ID, policy: config.policy, resolveValue: () => '' } as SessionOptions;
    await expect(call?.opts?.sessionFactory?.(sessionOpts)).resolves.toBe(adopted);
    expect(toSession).toHaveBeenCalledWith(page, sessionOpts, { policy: config.policy, baseURL: 'http://localhost:3999' });
  });

  it('R-SDK3 gives the second and later sessions of a scenario a page in a fresh browser context, and closes it', async () => {
    const config = fakeConfig();
    const closeContext = vi.fn(() => Promise.resolve());
    engine = fakeEngine(async (_id, opts) => {
      const o = { scenarioId: 's', policy: config.policy, resolveValue: () => '' } as SessionOptions;
      await opts?.sessionFactory?.(o);
      await opts?.sessionFactory?.(o);
      expect(closeContext).not.toHaveBeenCalled();
      return result();
    }, config);
    loadCfg.mockResolvedValue(config);
    makeEngine.mockResolvedValue(engine);
    const freshPage = { fresh: true };
    const newContext = vi.fn(() => Promise.resolve({ newPage: () => Promise.resolve(freshPage), close: closeContext }));
    const hostPage = { context: () => ({ browser: () => ({ newContext }) }) } as unknown as Parameters<typeof sessionFromPage>[0];
    toSession.mockResolvedValue({} as DriverSession);

    const rec = recordingTest();
    registerAiBddScenarios({ test: rec.test });
    await rec.tests[0]?.body({ page: hostPage }, fakeTestInfo());

    expect(toSession.mock.calls[0]?.[0]).toBe(hostPage);
    expect(toSession.mock.calls[1]?.[0]).toBe(freshPage);
    expect(newContext).toHaveBeenCalledTimes(1);
    expect(closeContext).toHaveBeenCalledTimes(1);
  });

  it('R-SDK3 omits baseURL from the session context when the config has none', async () => {
    toSession.mockResolvedValue({} as DriverSession);
    const rec = recordingTest();
    registerAiBddScenarios({ test: rec.test });
    await runFirst(rec);
    await engine.runCalls[0]?.opts?.sessionFactory?.({ scenarioId: 's', policy: fakeConfig().policy, resolveValue: () => '' });
    expect(toSession.mock.calls[0]?.[2]).toEqual({ policy: fakeConfig().policy });
    expect(Object.hasOwn(toSession.mock.calls[0]?.[2] ?? {}, 'baseURL')).toBe(false);
  });

  it('R-SDK3 memoizes one engine per worker, creating it lazily on the first test', async () => {
    const rec = recordingTest();
    registerAiBddScenarios({ test: rec.test });
    expect(makeEngine).not.toHaveBeenCalled();
    await runFirst(rec, 0);
    await runFirst(rec, 1);
    expect(loadCfg).toHaveBeenCalledTimes(1);
    expect(makeEngine).toHaveBeenCalledTimes(1);
    expect(engine.runCalls.map((c) => c.id)).toEqual([UPGRADE_ID, 'docs-billing--downgrading/downgrade']);
  });

  it('R-SDK3 shares the engine between concurrent first tests', async () => {
    const rec = recordingTest();
    registerAiBddScenarios({ test: rec.test });
    await Promise.all([runFirst(rec, 0), runFirst(rec, 1)]);
    expect(makeEngine).toHaveBeenCalledTimes(1);
  });

  it('R-SDK3 closes the engine in a file-level afterAll and recreates it for later tests', async () => {
    const rec = recordingTest();
    registerAiBddScenarios({ test: rec.test });
    expect(rec.afterAll).toHaveLength(1);
    await runFirst(rec, 0);
    await rec.afterAll[0]?.();
    expect(engine.closed).toBe(1);
    await rec.afterAll[0]?.(); // idempotent
    expect(engine.closed).toBe(1);
    await runFirst(rec, 1);
    expect(makeEngine).toHaveBeenCalledTimes(2);
  });

  it('R-SDK3 works with a test object that has no afterAll', () => {
    const rec = recordingTest({ withAfterAll: false });
    expect(() => registerAiBddScenarios({ test: rec.test })).not.toThrow();
    expect(rec.tests).toHaveLength(2);
  });

  it('R-SDK3 does not memoize a failed engine creation', async () => {
    loadCfg.mockRejectedValueOnce(Object.assign(new Error('no config'), { code: 'CONFIG_NOT_FOUND' }));
    const rec = recordingTest();
    registerAiBddScenarios({ test: rec.test });
    await expect(runFirst(rec, 0)).rejects.toThrow('no config');
    await runFirst(rec, 1);
    expect(loadCfg).toHaveBeenCalledTimes(2);
    await expect(closeAiBddEngines()).resolves.toBeUndefined();
  });

  it('R-SDK3 reports a failing engine.close from the teardown', async () => {
    const rec = recordingTest();
    registerAiBddScenarios({ test: rec.test });
    await runFirst(rec, 0);
    engine.close = () => Promise.reject(new Error('close failed'));
    await expect(rec.afterAll[0]?.()).rejects.toThrow('close failed');
  });

  it('R-SDK3 explains plan mismatches when the engine does not know the scenario', async () => {
    engine = fakeEngine(() => Promise.reject(Object.assign(new Error('unknown'), { code: 'SCENARIO_NOT_FOUND' })));
    makeEngine.mockResolvedValue(engine);
    const rec = recordingTest();
    registerAiBddScenarios({ test: rec.test, planDir: '/p/plans' });
    await expect(runFirst(rec)).rejects.toThrow(/\/p\/plans.*\/proj\/\.ai-bdd\/plans.*planDir/s);
  });

  it('R-SDK3 lets other engine errors through unchanged', async () => {
    const boom = new Error('driver exploded');
    engine = fakeEngine(() => Promise.reject(boom));
    makeEngine.mockResolvedValue(engine);
    const rec = recordingTest();
    registerAiBddScenarios({ test: rec.test });
    await expect(runFirst(rec)).rejects.toBe(boom);
  });
});

describe('outcome, annotations and evidence (M22)', () => {
  const withResult = (r: ScenarioResult) => {
    engine = fakeEngine(() => Promise.resolve(r));
    makeEngine.mockResolvedValue(engine);
  };

  it('M22 a passed scenario passes and attaches the step results as JSON and text', async () => {
    const r = result({ steps: [step(), step({ kind: 'then', text: 'the plan is Pro', path: 'check' })] });
    withResult(r);
    const rec = recordingTest();
    registerAiBddScenarios({ test: rec.test });
    const info = await runFirst(rec);
    const json = info.attachments.find((a) => a.name === 'ai-bdd-result.json');
    expect(json?.contentType).toBe('application/json');
    expect(JSON.parse(String(json?.body))).toEqual(JSON.parse(JSON.stringify(r)));
    const text = String(info.attachments.find((a) => a.name === 'ai-bdd-steps.txt')?.body);
    expect(text).toContain('1. [passed] given a customer on the Free plan');
    expect(text).toContain('2. [passed] then the plan is Pro');
    expect(info.annotations).toContainEqual({ type: 'ai-bdd:scenario', description: UPGRADE_ID });
    expect(info.annotations).toContainEqual({ type: 'ai-bdd:source', description: 'docs/billing.md' });
  });

  it('M22 annotates healed and fuzzy steps (a healed scenario passes by default)', async () => {
    withResult(
      result({
        status: 'healed',
        steps: [
          step({ kind: 'when', text: 'the user clicks Upgrade', status: 'healed', path: 'heal' }),
          step({ kind: 'then', text: 'the sync indicator shows the time', path: 'judge', determinism: 'fuzzy', fuzzyReasons: ['volatile-content'] }),
          step({ kind: 'then', text: 'it feels friendly', path: 'judge', determinism: 'fuzzy' }),
        ],
      }),
    );
    const rec = recordingTest();
    registerAiBddScenarios({ test: rec.test });
    const info = await runFirst(rec);
    const types = info.annotations.filter((a) => a.type === 'healed' || a.type === 'fuzzy');
    expect(types).toEqual([
      { type: 'healed', description: 'step 1 when: the user clicks Upgrade' },
      { type: 'fuzzy', description: 'step 2 then: the sync indicator shows the time [volatile-content]' },
      { type: 'fuzzy', description: 'step 3 then: it feels friendly' },
    ]);
  });

  it('M22 failOnHealed turns a healed scenario into a failure naming the healed step', async () => {
    withResult(result({ status: 'healed', steps: [step({ kind: 'when', text: 'the user clicks Upgrade', status: 'healed', path: 'heal' })] }));
    const rec = recordingTest();
    registerAiBddScenarios({ test: rec.test, failOnHealed: true });
    const info = fakeTestInfo();
    await expect(rec.tests[0]?.body({ page }, info)).rejects.toThrow(/ended healed[\s\S]*step 1 \[when\] "the user clicks Upgrade" ended healed/);
    // Evidence and annotations are still recorded for the failing test.
    expect(info.attachments.map((a) => a.name)).toContain('ai-bdd-result.json');
    expect(info.annotations.some((a) => a.type === 'healed')).toBe(true);
  });

  it('M22 a failed scenario reports the failing step, its error code, details and source quote', async () => {
    withResult(
      result({
        status: 'failed',
        recording: 'discarded',
        steps: [
          step(),
          step({
            kind: 'then',
            text: 'the plan is Pro',
            status: 'failed',
            path: 'check',
            error: { code: 'CHECK_FAILED', message: 'predicate not satisfied', retryable: false, details: { actual: 'Plan: Free' } },
            sources: [{ chunkId: 'docs/billing.md#upgrading/p2', hash: 'a'.repeat(64), relation: 'source', quote: 'the plan is Pro' }],
          }),
          step({ kind: 'then', text: 'a message appears', status: 'skipped', path: 'none' }),
        ],
      }),
    );
    const rec = recordingTest();
    registerAiBddScenarios({ test: rec.test });
    const err = await runFirst(rec).catch((e: unknown) => e as Error);
    const message = String((err as Error).message);
    expect(message).toContain('"Upgrading to Pro > Upgrade to Pro" ended failed');
    expect(message).toContain('step 2 [then] "the plan is Pro" ended failed');
    expect(message).toContain('CHECK_FAILED: predicate not satisfied');
    expect(message).toContain('{"actual":"Plan: Free"}');
    expect(message).toContain('docs/billing.md#upgrading/p2 "the plan is Pro"');
    expect(message).toContain('1 later step(s) skipped');
    expect(message).toContain('recording was discarded');
  });

  it.each(['failed', 'blocked', 'inconclusive', 'error', 'skipped'] as const)('M22 status %s fails the test', async (status) => {
    withResult(
      result({
        status,
        error: { code: 'DRIVER_ERROR', message: 'browser gone', retryable: true },
        steps: [step({ status: status === 'skipped' ? 'skipped' : status, error: { code: 'FIXTURE_REQUIRED', message: 'needs state', retryable: false } })],
      }),
    );
    const rec = recordingTest();
    registerAiBddScenarios({ test: rec.test });
    await expect(runFirst(rec)).rejects.toThrow(new RegExp(`ended ${status}`));
  });

  it('M22 attaches screenshot artifacts read from the run directory and ignores missing or unsafe ones', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pwtest-evidence-'));
    try {
      const sha = 'ab'.repeat(32);
      const other = 'cd'.repeat(32);
      mkdirSync(join(root, 'run-0001', 'artifacts'), { recursive: true });
      mkdirSync(join(root, 'run-0002', 'artifacts'), { recursive: true });
      writeFileSync(join(root, 'run-0001', 'artifacts', `${sha}.png`), Buffer.from([1, 2, 3]));
      writeFileSync(join(root, 'run-0002', 'artifacts', `${other}.png`), Buffer.from([9]));
      writeFileSync(join(root, 'secret.png'), Buffer.from([7]));
      const ref = (s: string, path: string, kind: 'screenshot' | 'observation' = 'screenshot') => ({ sha256: s, path, kind, bytes: 1 });
      const config = fakeConfig({ runsDir: root });
      engine = fakeEngine(
        () =>
          Promise.resolve(
            result({
              steps: [
                step({ evidence: [ref(sha, `artifacts/${sha}.png`), ref(sha, `artifacts/${sha}.png`), ref(sha, 'artifacts/obs.json', 'observation')] }),
                step({ evidence: [ref(other, `artifacts/${other}.png`), ref('ee'.repeat(32), 'artifacts/missing.png'), ref('ff'.repeat(32), '../secret.png'), ref('11'.repeat(32), '/etc/hostname')] }),
              ],
            }),
          ),
        config,
      );
      makeEngine.mockResolvedValue(engine);
      loadCfg.mockResolvedValue(config);
      const rec = recordingTest();
      registerAiBddScenarios({ test: rec.test });
      const info = await runFirst(rec);
      const shots = info.attachments.filter((a) => a.contentType === 'image/png');
      expect(shots.map((s) => s.name)).toEqual([`step-1-screenshot-${sha.slice(0, 8)}.png`, `step-2-screenshot-${other.slice(0, 8)}.png`]);
      expect(shots.map((s) => [...(s.body as Buffer)])).toEqual([[1, 2, 3], [9]]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('M22 a missing runs directory never fails the test', async () => {
    const config = fakeConfig({ runsDir: join(tmpdir(), 'pwtest-does-not-exist') });
    const shot = { sha256: 'ab'.repeat(32), path: `artifacts/${'ab'.repeat(32)}.png`, kind: 'screenshot' as const, bytes: 1 };
    engine = fakeEngine(() => Promise.resolve(result({ steps: [step({ evidence: [shot] })] })), config);
    makeEngine.mockResolvedValue(engine);
    const rec = recordingTest();
    registerAiBddScenarios({ test: rec.test });
    const info = await runFirst(rec);
    expect(info.attachments.map((a) => a.name)).toEqual(['ai-bdd-result.json', 'ai-bdd-steps.txt']);
  });
});
