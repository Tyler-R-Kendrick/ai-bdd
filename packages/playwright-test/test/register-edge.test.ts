import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEngine, loadConfig, loadPlansSync } from '@ai-bdd/sdk';
import { sessionFromPage } from '@ai-bdd/driver-playwright';
import type { DriverSession, SessionOptions } from '@ai-bdd/sdk/contracts';
import { closeAiBddEngines, registerAiBddScenarios } from '../src/index.ts';
import { fakeConfig, fakeEngine, fakeTestInfo, feature, plan, recordingTest, result, scenario, type FakeEngine } from './helpers/doubles.ts';

vi.mock('@ai-bdd/sdk', () => ({ loadPlansSync: vi.fn(), loadConfig: vi.fn(), createEngine: vi.fn() }));
vi.mock('@ai-bdd/driver-playwright', () => ({ sessionFromPage: vi.fn() }));

const loadPlans = vi.mocked(loadPlansSync);
const loadCfg = vi.mocked(loadConfig);
const makeEngine = vi.mocked(createEngine);
const toSession = vi.mocked(sessionFromPage);

const sessionOpts = (config = fakeConfig()) => ({ scenarioId: 's', policy: config.policy, resolveValue: () => '' }) as SessionOptions;
const hostPageWith = (browser: unknown) => ({ context: () => ({ browser: () => browser }) }) as unknown as Parameters<typeof sessionFromPage>[0];

let engine: FakeEngine;

beforeEach(() => {
  engine = fakeEngine(() => Promise.resolve(result()));
  loadPlans.mockReset().mockReturnValue([plan('docs/billing.md', [feature('docs-billing--upgrading', 'Upgrading', [scenario('docs-billing--upgrading/up', 'Up')])])]);
  loadCfg.mockReset().mockResolvedValue(fakeConfig());
  makeEngine.mockReset().mockResolvedValue(engine);
  toSession.mockReset().mockResolvedValue({} as DriverSession);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  await closeAiBddEngines();
  vi.restoreAllMocks();
});

describe('sessions beyond the first (R-SDK3)', () => {
  it('without a browser handle (a persistent context) every session reuses the test page', async () => {
    const calls: unknown[] = [];
    engine = fakeEngine(async (_id, opts) => {
      await opts?.sessionFactory?.(sessionOpts());
      await opts?.sessionFactory?.(sessionOpts());
      await opts?.sessionFactory?.(sessionOpts());
      return result();
    });
    makeEngine.mockResolvedValue(engine);
    toSession.mockImplementation(async (p) => {
      calls.push(p);
      return {} as DriverSession;
    });
    const page = hostPageWith(null);
    const rec = recordingTest();
    registerAiBddScenarios({ test: rec.test });
    await rec.tests[0]?.body({ page }, fakeTestInfo());
    expect(calls).toEqual([page, page, page]);
  });

  it('a context that fails to close does not fail the test, and the remaining contexts are still closed', async () => {
    const closeBad = vi.fn(() => Promise.reject(new Error('already closed')));
    const closeGood = vi.fn(() => Promise.resolve());
    const contexts = [
      { newPage: () => Promise.resolve({ n: 1 }), close: closeBad },
      { newPage: () => Promise.resolve({ n: 2 }), close: closeGood },
    ];
    const newContext = vi.fn(() => Promise.resolve(contexts.shift()));
    engine = fakeEngine(async (_id, opts) => {
      await opts?.sessionFactory?.(sessionOpts());
      await opts?.sessionFactory?.(sessionOpts());
      await opts?.sessionFactory?.(sessionOpts());
      return result();
    });
    makeEngine.mockResolvedValue(engine);
    const rec = recordingTest();
    registerAiBddScenarios({ test: rec.test });
    await expect(rec.tests[0]?.body({ page: hostPageWith({ newContext }) }, fakeTestInfo())).resolves.toBeUndefined();
    expect(newContext).toHaveBeenCalledTimes(2);
    expect(closeBad).toHaveBeenCalledTimes(1);
    expect(closeGood).toHaveBeenCalledTimes(1);
  });

  it('fresh contexts are closed even when the scenario run itself throws, and the original error is what the test reports', async () => {
    const close = vi.fn(() => Promise.resolve());
    const newContext = vi.fn(() => Promise.resolve({ newPage: () => Promise.resolve({}), close }));
    const boom = new Error('driver exploded');
    engine = fakeEngine(async (_id, opts) => {
      await opts?.sessionFactory?.(sessionOpts());
      await opts?.sessionFactory?.(sessionOpts());
      throw boom;
    });
    makeEngine.mockResolvedValue(engine);
    const rec = recordingTest();
    registerAiBddScenarios({ test: rec.test });
    await expect(rec.tests[0]?.body({ page: hostPageWith({ newContext }) }, fakeTestInfo())).rejects.toBe(boom);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('error shapes from the engine (R-SDK3)', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'plain string'],
    ['an object with another code', { code: 'DRIVER_ERROR' }],
  ])('a thrown %s is rethrown unchanged', async (_label, thrown) => {
    engine = fakeEngine(() => Promise.reject(thrown));
    makeEngine.mockResolvedValue(engine);
    const rec = recordingTest();
    registerAiBddScenarios({ test: rec.test });
    await expect(rec.tests[0]?.body({ page: hostPageWith(null) }, fakeTestInfo())).rejects.toBe(thrown);
  });

  it('the plan mismatch message keeps the engine error as its cause and names the scenario and both plan dirs', async () => {
    const cause = Object.assign(new Error('unknown scenario'), { code: 'SCENARIO_NOT_FOUND' });
    engine = fakeEngine(() => Promise.reject(cause), fakeConfig({ planDir: '/engine/plans' }));
    makeEngine.mockResolvedValue(engine);
    const rec = recordingTest();
    registerAiBddScenarios({ test: rec.test, planDir: '/collected/plans' });
    const error = await rec.tests[0]?.body({ page: hostPageWith(null) }, fakeTestInfo()).catch((e: unknown) => e as Error);
    expect((error as Error).message).toBe(
      'ai-bdd scenario "docs-billing--upgrading/up" is in the plans read at collection time (/collected/plans) but not in the plans of the engine (/engine/plans). Pass the matching planDir to registerAiBddScenarios.',
    );
    expect((error as Error).cause).toBe(cause);
  });
});

describe('closeAiBddEngines (R-SDK3)', () => {
  it('skips an engine whose creation is still pending and then fails, without throwing, and closes the healthy ones', async () => {
    let failCreation: (e: Error) => void = () => undefined;
    loadCfg.mockReset().mockReturnValueOnce(new Promise((_resolve, reject) => { failCreation = reject; }));
    const rec = recordingTest();
    registerAiBddScenarios({ test: rec.test });
    const running = rec.tests[0]?.body({ page: hostPageWith(null) }, fakeTestInfo());
    const rejected = expect(running).rejects.toThrow('no such config');
    await Promise.resolve();
    const closing = closeAiBddEngines();
    failCreation(new Error('no such config'));
    await expect(closing).resolves.toBeUndefined();
    await rejected;
    expect(engine.closed).toBe(0);
  });

  it('closes every engine even when an earlier close fails, and reports the first failure only', async () => {
    const first = fakeEngine(() => Promise.resolve(result()));
    const second = fakeEngine(() => Promise.resolve(result()));
    const third = fakeEngine(() => Promise.resolve(result()));
    first.close = () => Promise.reject(new Error('first close failed'));
    second.close = () => Promise.reject(new Error('second close failed'));
    makeEngine.mockReset().mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockResolvedValueOnce(third);
    for (const configPath of ['a.config.ts', 'b.config.ts', 'c.config.ts']) {
      const rec = recordingTest();
      registerAiBddScenarios({ test: rec.test, configPath });
      await rec.tests[0]?.body({ page: hostPageWith(null) }, fakeTestInfo());
    }
    await expect(closeAiBddEngines()).rejects.toThrow('first close failed');
    expect(third.closed).toBe(1);
    // everything was forgotten: closing again is a no-op
    await expect(closeAiBddEngines()).resolves.toBeUndefined();
    expect(third.closed).toBe(1);
  });

  it('one engine per config path: tests with different config paths do not share an engine', async () => {
    const a = fakeEngine(() => Promise.resolve(result()));
    const b = fakeEngine(() => Promise.resolve(result()));
    makeEngine.mockReset().mockResolvedValueOnce(a).mockResolvedValueOnce(b);
    const one = recordingTest();
    const two = recordingTest();
    registerAiBddScenarios({ test: one.test, configPath: 'one.config.ts' });
    registerAiBddScenarios({ test: two.test, configPath: 'two.config.ts' });
    await one.tests[0]?.body({ page: hostPageWith(null) }, fakeTestInfo());
    await two.tests[0]?.body({ page: hostPageWith(null) }, fakeTestInfo());
    await one.tests[0]?.body({ page: hostPageWith(null) }, fakeTestInfo());
    expect(makeEngine).toHaveBeenCalledTimes(2);
    expect(a.runCalls).toHaveLength(2);
    expect(b.runCalls).toHaveLength(1);
    const paths = loadCfg.mock.calls.map((c) => (c[0] as { configPath?: string }).configPath ?? '');
    expect(paths[0]).toMatch(/one\.config\.ts$/);
    expect(paths[1]).toMatch(/two\.config\.ts$/);
  });
});
