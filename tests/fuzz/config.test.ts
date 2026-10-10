import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig, resolveConfig } from '@ai-bdd/sdk';
import type { ChatModel, DriverFactory, FixtureDefinition, ModelSet, ResolvedConfig, UserConfig } from '@ai-bdd/sdk/contracts';
import { AiBddError } from '@ai-bdd/sdk/contracts';
import { assertPrototypeClean, hostileKey, hostileString, jsonEqual, jsonValue, params } from './helpers.ts';
import { loadConfigWith } from '../../packages/sdk/src/config/load.ts';

const ROOT = resolvePath(tmpdir(), 'ai-bdd-fuzz-root');
const OPTS = { projectRoot: ROOT, env: {} as Record<string, string | undefined> };

const nonEmpty = fc.string({ minLength: 1, maxLength: 16 });
const driver = (id: string): DriverFactory => ({ id, create: () => Promise.reject(new Error('not used')) });
const model = (id: string): ChatModel => ({ id, generate: () => Promise.reject(new Error('not used')) });
const modelSet: ModelSet = { extract: model('e'), act: model('a'), checkgen: model('c'), judge: model('j') };
const fixture: FixtureDefinition = { name: 'seed', description: 'seed data', params: {}, run: () => Promise.resolve() };

const posInt = fc.integer({ min: 1, max: 1_000_000 });
const nonNegInt = fc.integer({ min: 0, max: 1_000_000 });
const unit = fc.double({ min: 0, max: 1, noNaN: true });

/** A judge section that is valid whichever half of the defaults (pass 0.8, fail 0.3) it is merged with. */
const judgeArb = fc.oneof(
  fc.record({ samples: fc.integer({ min: 1, max: 9 }), vision: fc.boolean(), maxSpread: unit, maxTreeChars: posInt }, { requiredKeys: [] }),
  fc.tuple(fc.double({ min: 0, max: 0.299, noNaN: true }), fc.double({ min: 0.301, max: 1, noNaN: true })).map(([failThreshold, passThreshold]) => ({ failThreshold, passThreshold })),
  fc.double({ min: 0.301, max: 1, noNaN: true }).map((passThreshold) => ({ passThreshold })),
  fc.double({ min: 0, max: 0.799, noNaN: true }).map((failThreshold) => ({ failThreshold })),
);

const validUser: fc.Arbitrary<UserConfig> = fc
  .record(
    {
      docs: fc.array(nonEmpty, { maxLength: 3 }),
      exclude: fc.array(nonEmpty, { maxLength: 3 }),
      planDir: nonEmpty,
      recordingsDir: nonEmpty,
      runsDir: nonEmpty,
      cacheDir: nonEmpty,
      baseURL: fc.oneof(fc.constantFrom('http://localhost:3000', 'https://App.Example.com/base/', 'http://[::1]:8080', 'http://127.0.0.1'), fc.webUrl().filter((u) => !u.includes('@'))),
      drivers: fc.dictionary(fc.stringMatching(/^[a-z]{1,6}$/), fc.stringMatching(/^[a-z]{1,6}$/).map(driver), { maxKeys: 3 }),
      defaultDriver: fc.stringMatching(/^[a-z]{1,6}$/),
      models: fc.constant(modelSet),
      fixtures: fc.constant([fixture]),
      secrets: fc.dictionary(fc.stringMatching(/^[A-Za-z0-9_.-]{1,10}$/).filter((k) => k !== '__proto__'), fc.record({ env: nonEmpty }), { maxKeys: 3 }),
      context: hostileString({ maxLength: 40 }),
      extract: fc.record({ sectionDepth: fc.integer({ min: 1, max: 6 }), maxSectionChars: posInt, minQuoteChars: posInt, concurrency: posInt }, { requiredKeys: [] }),
      characterize: fc.record({ confirmRuns: nonNegInt, probeMs: nonNegInt, healThreshold: posInt }, { requiredKeys: [] }),
      judge: judgeArb,
      agent: fc.record({ maxActions: posInt, maxModelCalls: posInt, maxWaitMs: nonNegInt }, { requiredKeys: [] }),
      checks: fc.record({ maxAttempts: posInt, maxPredicates: posInt, requireDeterministic: fc.boolean() }, { requiredKeys: [] }),
      settle: fc.record({ quietMs: nonNegInt, intervalMs: posInt, timeoutMs: posInt, requireSettled: fc.boolean() }, { requiredKeys: [] }),
      policy: fc.record(
        { allowHosts: fc.array(fc.constantFrom('localhost', 'LOCALHOST', '*.example.org', 'app.example.com', '127.0.0.1'), { maxLength: 4 }), denyVerbs: fc.array(fc.constantFrom('navigate', 'fill', 'press', 'wait'), { maxLength: 3 }) },
        { requiredKeys: [] },
      ),
      concurrency: fc.record({ scenarios: posInt }, { requiredKeys: [] }),
      reporters: fc.array(fc.constantFrom('json', 'junit', 'markdown'), { maxLength: 3 }),
      prices: fc.dictionary(fc.stringMatching(/^[a-z-]{1,8}$/), fc.record({ inputPerMTok: fc.double({ min: 0, max: 100, noNaN: true }), outputPerMTok: fc.double({ min: 0, max: 100, noNaN: true }) }), { maxKeys: 2 }),
    },
    { requiredKeys: [] },
  )
  .map((c) => c as unknown as UserConfig);

const configKeys = ['docs', 'exclude', 'planDir', 'recordingsDir', 'runsDir', 'cacheDir', 'baseURL', 'drivers', 'defaultDriver', 'models', 'fixtures', 'secrets', 'context', 'extract', 'characterize', 'judge', 'agent', 'checks', 'settle', 'policy', 'concurrency', 'reporters', 'prices', '$schema'];

/** Valid config with some values swapped for arbitrary JSON, or random keys added: the near-miss inputs that reach deep validation. */
const nearMiss = fc
  .tuple(validUser, fc.array(fc.tuple(fc.oneof(fc.constantFrom(...configKeys), hostileKey), jsonValue({ maxDepth: 3, maxKeys: 4 })), { minLength: 1, maxLength: 3 }))
  .map(([base, mutations]) => {
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of mutations) Object.defineProperty(out, k, { value: v, enumerable: true, configurable: true, writable: true });
    return out;
  });

const anyInput = fc.oneof({ weight: 3, arbitrary: jsonValue({ maxDepth: 4, maxKeys: 6 }) }, { weight: 4, arbitrary: nearMiss }, { weight: 1, arbitrary: hostileString() });

/** Deep copy that keeps functions (drivers, models) by reference, which `structuredClone` refuses to do. */
function snapshot<T>(value: T): T {
  if (Array.isArray(value)) return value.map(snapshot) as T;
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, snapshot(v)])) as T;
  return value;
}

function describeThrown(e: unknown): string {
  return e instanceof Error ? `${e.name}:${(e as { code?: string }).code}: ${e.message.slice(0, 200)}` : String(e);
}

describe('fuzz: resolveConfig', () => {
  it('on arbitrary input either resolves or throws AiBddError(CONFIG_INVALID); it never throws anything else and never mutates the input', () => {
    fc.assert(
      fc.property(anyInput, (input) => {
        const before = snapshot(input);
        try {
          const r = resolveConfig(input as UserConfig, OPTS);
          // A success is a complete ResolvedConfig
          expect(r.projectRoot).toBe(ROOT);
          expect(r.judge.failThreshold).toBeLessThan(r.judge.passThreshold);
          expect(r.policy.allowHosts.length).toBeGreaterThan(0);
        } catch (e) {
          expect(e instanceof AiBddError, describeThrown(e)).toBe(true);
          expect((e as AiBddError).code, describeThrown(e)).toBe('CONFIG_INVALID');
          expect((e as AiBddError).message.length).toBeGreaterThan(0);
        }
        expect(jsonEqual(input, before)).toBe(true);
        assertPrototypeClean();
      }),
      params(),
    );
  });

  it('a valid config resolves, keeps every value the user gave, and never loses a driver, secret or price entry', () => {
    fc.assert(
      fc.property(validUser, (user) => {
        const before = snapshot(user);
        const r = resolveConfig(user, OPTS);
        expect(r.docs).toEqual(user.docs ?? ['docs/**/*.md']);
        expect(r.context).toBe(user.context ?? '');
        expect(r.reporters).toEqual(user.reporters ?? ['json', 'junit', 'markdown']);
        expect(Object.keys(r.drivers).sort()).toEqual(Object.keys(user.drivers ?? {}).sort());
        expect(Object.keys(r.secrets).sort()).toEqual(Object.keys(user.secrets ?? {}).sort());
        expect(Object.keys(r.prices).sort()).toEqual(Object.keys(user.prices ?? {}).sort());
        expect(r.baseURL).toBe(user.baseURL);
        if (user.baseURL !== undefined) expect(r.policy.allowHosts.map((h) => h.toLowerCase())).toContain(new URL(user.baseURL).hostname.toLowerCase());
        for (const [k, v] of Object.entries(user.extract ?? {})) expect(r.extract[k as keyof typeof r.extract]).toBe(v);
        for (const [k, v] of Object.entries(user.judge ?? {})) expect(r.judge[k as keyof typeof r.judge]).toBe(v);
        // absolute directories
        for (const d of [r.planDir, r.recordingsDir, r.runsDir, r.cacheDir]) expect(resolvePath(d)).toBe(d);
        // resolving does not change what the caller passed
        expect(user).toEqual(before);
      }),
      params(),
    );
  });

  it('round trip: resolving the user-visible fields of a resolved config again gives the same resolved config', () => {
    const asUser = (r: ResolvedConfig): UserConfig => ({
      docs: r.docs, exclude: r.exclude, planDir: r.planDir, recordingsDir: r.recordingsDir, runsDir: r.runsDir, cacheDir: r.cacheDir,
      ...(r.baseURL === undefined ? {} : { baseURL: r.baseURL }),
      drivers: r.drivers,
      ...(r.defaultDriver === undefined ? {} : { defaultDriver: r.defaultDriver }),
      ...(r.models === undefined ? {} : { models: r.models }),
      fixtures: r.fixtures, secrets: r.secrets, context: r.context,
      extract: r.extract, characterize: r.characterize, judge: r.judge, agent: r.agent, checks: r.checks, settle: r.settle,
      policy: r.policy, concurrency: r.concurrency, reporters: r.reporters, prices: r.prices,
    });
    fc.assert(
      fc.property(validUser, (user) => {
        const once = resolveConfig(user, OPTS);
        const twice = resolveConfig(asUser(once), OPTS);
        expect(twice).toEqual(once);
        expect(resolveConfig(user, OPTS)).toEqual(once);
      }),
      params(),
    );
  });

  it('CI and AI_BDD_RECORDINGS environments pick a recordings mode or fail with CONFIG_INVALID', () => {
    fc.assert(
      fc.property(fc.oneof(hostileString({ maxLength: 12 }), fc.constantFrom('true', '1', '0', 'false', 'TRUE', ' 1', '')), fc.oneof(hostileString({ maxLength: 12 }), fc.constantFrom('read-write', 'read-only', 'off', 'OFF', '', 'on')), (ci, rec) => {
        try {
          const r = resolveConfig({}, { projectRoot: ROOT, env: { CI: ci, AI_BDD_RECORDINGS: rec } });
          expect(['read-write', 'read-only', 'off']).toContain(r.recordingsMode);
          expect(r.ci).toBe(ci === 'true' || ci === '1');
          if (rec !== '') expect(r.recordingsMode).toBe(rec);
        } catch (e) {
          expect(e instanceof AiBddError && e.code === 'CONFIG_INVALID', describeThrown(e)).toBe(true);
        }
      }),
      params(),
    );
  });

  it('secret environment values: short values are SECRET_TOO_SHORT, never echoed in the error', () => {
    fc.assert(
      fc.property(hostileString({ maxLength: 12 }), (value) => {
        const secret = 'TOPSECRETSHORT';
        try {
          resolveConfig({ secrets: { pw: { env: 'PW' } } }, { projectRoot: ROOT, env: { PW: value } });
          expect(value === '' || value.length >= 4).toBe(true);
        } catch (e) {
          expect(e instanceof AiBddError && e.code === 'SECRET_TOO_SHORT', describeThrown(e)).toBe(true);
          expect(value.length).toBeLessThan(4);
          if (value.length > 0) expect(JSON.stringify(e instanceof AiBddError ? { m: e.message, d: e.details } : '')).not.toContain(JSON.stringify(value).slice(1, -1) + secret);
        }
      }),
      params(),
    );
  });
});

describe('fuzz: loadConfig', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-bdd-fuzz-config-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const fileText = fc.oneof(
    { weight: 3, arbitrary: jsonValue({ maxDepth: 4, maxKeys: 6 }).map((v) => JSON.stringify(v)) },
    { weight: 4, arbitrary: nearMiss.map((v) => JSON.stringify(v)) },
    { weight: 2, arbitrary: hostileString() },
    { weight: 1, arbitrary: fc.constantFrom('', ' ', 'null', '[]', '{}', '{"drivers":{"x":{"use":"./nope.mjs"}}}', '{"models":{"use":"nope"}}', '{"drivers":{"__proto__":{"use":"x"}}}', '\ufeff{}') },
  );

  it('a config file with arbitrary content loads or fails with AiBddError(CONFIG_INVALID); a `use` entry never escapes as another error', async () => {
    const importer = (spec: string): Promise<Record<string, unknown>> => Promise.reject(new Error(`cannot import ${spec}`));
    await fc.assert(
      fc.asyncProperty(fileText, async (text) => {
        writeFileSync(join(dir, 'ai-bdd.config.json'), text);
        try {
          const r = await loadConfigWith({ cwd: dir, env: {} }, importer);
          expect(r.projectRoot).toBe(dir);
        } catch (e) {
          expect(e instanceof AiBddError, describeThrown(e)).toBe(true);
          expect((e as AiBddError).code, describeThrown(e)).toBe('CONFIG_INVALID');
        }
        assertPrototypeClean();
      }),
      params({ scale: 0.5 }),
    );
  });

  it('the exported loadConfig behaves the same for configs without `use` entries', async () => {
    const noUse = nearMiss.filter((c) => !JSON.stringify(c).includes('"use"')).map((v) => JSON.stringify(v));
    await fc.assert(
      fc.asyncProperty(noUse, async (text) => {
        writeFileSync(join(dir, 'ai-bdd.config.json'), text);
        try {
          await loadConfig({ cwd: dir, env: {} });
        } catch (e) {
          expect(e instanceof AiBddError && e.code === 'CONFIG_INVALID', describeThrown(e)).toBe(true);
        }
      }),
      params({ scale: 0.3 }),
    );
  });
});
