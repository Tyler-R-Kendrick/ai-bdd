import { describe, expect, it } from 'vitest';
import { AiBddError, type ChatModel, type DriverFactory, type ModelSet, type UserConfig } from '../../src/contracts/index.ts';
import { defineConfig, resolveConfig } from '../../src/config/index.ts';

const chat = (id: string): ChatModel => ({
  id,
  generate: () => Promise.resolve({ toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, finishReason: 'stop', modelId: id }),
});
const models: ModelSet = { extract: chat('e'), act: chat('a'), checkgen: chat('c'), judge: chat('j') };
const driver: DriverFactory = { id: 'fake', create: () => Promise.reject(new Error('unused')) };

const resolve = (user: UserConfig, env: Record<string, string | undefined> = {}, root = '/proj') =>
  resolveConfig(user, { projectRoot: root, env });

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof AiBddError) return e.code;
    throw e;
  }
  return 'none';
}

describe('resolveConfig defaults (config defaults table)', () => {
  it('applies every default from the requirements table', () => {
    const c = resolve({});
    expect(c.projectRoot).toBe('/proj');
    expect(c.docs).toEqual(['docs/**/*.md']);
    expect(c.exclude).toEqual(['**/node_modules/**', '.ai-bdd/**']);
    expect(c.planDir).toBe('/proj/.ai-bdd/plans');
    expect(c.recordingsDir).toBe('/proj/.ai-bdd/recordings');
    expect(c.runsDir).toBe('/proj/.ai-bdd/runs');
    expect(c.cacheDir).toBe('/proj/.ai-bdd/cache');
    expect(c.extract).toEqual({ sectionDepth: 2, maxSectionChars: 12000, minQuoteChars: 12, concurrency: 4 });
    expect(c.characterize).toEqual({ confirmRuns: 1, probeMs: 500, healThreshold: 2 });
    expect(c.judge).toEqual({ passThreshold: 0.8, failThreshold: 0.3, samples: 3, maxSpread: 0.5, vision: true, maxTreeChars: 20000 });
    expect(c.agent).toEqual({ maxActions: 20, maxModelCalls: 15, maxWaitMs: 5000 });
    expect(c.checks).toEqual({ maxAttempts: 3, maxPredicates: 8, requireDeterministic: false });
    expect(c.settle).toEqual({ quietMs: 300, intervalMs: 100, timeoutMs: 5000, requireSettled: true });
    expect(c.policy).toEqual({ allowHosts: ['localhost', '127.0.0.1', '[::1]'], denyVerbs: [] });
    expect(c.concurrency).toEqual({ scenarios: 4 });
    expect(c.reporters).toEqual(['json', 'junit', 'markdown']);
    expect(c.context).toBe('');
    expect(c.secrets).toEqual({});
    expect(c.drivers).toEqual({});
    expect(c.fixtures).toEqual([]);
    expect(c.prices).toEqual({});
    expect(c.ci).toBe(false);
    expect(c.recordingsMode).toBe('read-write');
    expect(c.baseURL).toBeUndefined();
    expect(c.models).toBeUndefined();
  });

  it('merges partial sections key by key and resolves paths against projectRoot (absolute stays absolute)', () => {
    const c = resolve({ extract: { concurrency: 1 }, judge: { samples: 5 }, planDir: 'plans', runsDir: '/abs/runs' });
    expect(c.extract).toEqual({ sectionDepth: 2, maxSectionChars: 12000, minQuoteChars: 12, concurrency: 1 });
    expect(c.judge.samples).toBe(5);
    expect(c.judge.passThreshold).toBe(0.8);
    expect(c.planDir).toBe('/proj/plans');
    expect(c.runsDir).toBe('/abs/runs');
  });

  it('defineConfig is the identity', () => {
    const cfg: UserConfig = { docs: ['a.md'] };
    expect(defineConfig(cfg)).toBe(cfg);
  });

  it('picks the only driver as default and keeps an explicit defaultDriver', () => {
    expect(resolve({ drivers: { web: driver } }).defaultDriver).toBe('web');
    expect(resolve({ drivers: { web: driver, other: driver } }).defaultDriver).toBeUndefined();
    expect(resolve({ drivers: { web: driver, other: driver }, defaultDriver: 'other' }).defaultDriver).toBe('other');
  });

  it('keeps the model set and drivers by reference', () => {
    const c = resolve({ models, drivers: { web: driver } });
    expect(c.models).toBe(models);
    expect(c.drivers['web']).toBe(driver);
  });
});

describe('resolveConfig policy and baseURL (R-AG3)', () => {
  it('adds the baseURL host to allowHosts, once', () => {
    expect(resolve({ baseURL: 'https://app.example.com:8443/x' }).policy.allowHosts).toEqual(['localhost', '127.0.0.1', '[::1]', 'app.example.com']);
    expect(resolve({ baseURL: 'http://localhost:3000' }).policy.allowHosts).toEqual(['localhost', '127.0.0.1', '[::1]']);
    expect(resolve({ baseURL: 'http://[::1]:3000' }).policy.allowHosts).toEqual(['localhost', '127.0.0.1', '[::1]']);
  });

  it('user allowHosts replace the defaults but still get the baseURL host', () => {
    const c = resolve({ baseURL: 'https://a.test', policy: { allowHosts: ['*.corp.test'], denyVerbs: ['hover'] } });
    expect(c.policy).toEqual({ allowHosts: ['*.corp.test', 'a.test'], denyVerbs: ['hover'] });
  });
});

describe('resolveConfig CI and recordings mode (R-RN4)', () => {
  it.each([
    ['true', true, 'read-only'],
    ['1', true, 'read-only'],
    ['false', false, 'read-write'],
    ['0', false, 'read-write'],
    ['', false, 'read-write'],
    [undefined, false, 'read-write'],
  ] as const)('R-RN4: CI=%s gives ci=%s and recordingsMode=%s', (ci, expectedCi, mode) => {
    const c = resolve({}, { CI: ci });
    expect(c.ci).toBe(expectedCi);
    expect(c.recordingsMode).toBe(mode);
  });

  it('R-RN4: AI_BDD_RECORDINGS overrides the CI default in both directions', () => {
    expect(resolve({}, { CI: 'true', AI_BDD_RECORDINGS: 'read-write' }).recordingsMode).toBe('read-write');
    expect(resolve({}, { AI_BDD_RECORDINGS: 'read-only' }).recordingsMode).toBe('read-only');
    expect(resolve({}, { AI_BDD_RECORDINGS: 'off' }).recordingsMode).toBe('off');
    expect(resolve({}, { CI: '1', AI_BDD_RECORDINGS: '' }).recordingsMode).toBe('read-only');
  });

  it('rejects an unknown AI_BDD_RECORDINGS value with CONFIG_INVALID', () => {
    expect(code(() => resolve({}, { AI_BDD_RECORDINGS: 'maybe' }))).toBe('CONFIG_INVALID');
  });
});

describe('resolveConfig validation table', () => {
  const bad: [string, unknown][] = [
    ['unknown top-level key', { docz: ['a.md'] }],
    ['unknown nested key (extract)', { extract: { sectionDepht: 2 } }],
    ['unknown nested key (judge)', { judge: { temperature: 0 } }],
    ['unknown key in a secret', { secrets: { pw: { env: 'X', value: 'y' } } }],
    ['docs not an array', { docs: 'docs/*.md' }],
    ['docs contains empty string', { docs: [''] }],
    ['planDir empty', { planDir: '' }],
    ['baseURL not a URL', { baseURL: 'not a url' }],
    ['baseURL with ftp scheme', { baseURL: 'ftp://x.test' }],
    ['baseURL with credentials', { baseURL: 'https://u:p@x.test' }],
    ['driver not a factory', { drivers: { web: { nope: true } } }],
    ['driver factory missing create', { drivers: { web: { id: 'x' } } }],
    ['models missing a purpose', { models: { extract: chat('e'), act: chat('a'), checkgen: chat('c') } }],
    ['models entry not a ChatModel', { models: { ...models, judge: { id: 'j' } } }],
    ['fixture missing run', { fixtures: [{ name: 'f', description: 'd', params: {} }] }],
    ['secret without env', { secrets: { pw: {} } }],
    ['secret name with spaces', { secrets: { 'my pw': { env: 'X' } } }],
    ['sectionDepth 0', { extract: { sectionDepth: 0 } }],
    ['sectionDepth 7', { extract: { sectionDepth: 7 } }],
    ['maxSectionChars negative', { extract: { maxSectionChars: -1 } }],
    ['concurrency 0', { extract: { concurrency: 0 } }],
    ['concurrency fractional', { extract: { concurrency: 1.5 } }],
    ['confirmRuns negative', { characterize: { confirmRuns: -1 } }],
    ['healThreshold 0', { characterize: { healThreshold: 0 } }],
    ['passThreshold > 1', { judge: { passThreshold: 1.1 } }],
    ['failThreshold < 0', { judge: { failThreshold: -0.1 } }],
    ['failThreshold equals passThreshold', { judge: { passThreshold: 0.5, failThreshold: 0.5 } }],
    ['failThreshold above passThreshold', { judge: { passThreshold: 0.4, failThreshold: 0.6 } }],
    ['failThreshold above default pass threshold', { judge: { failThreshold: 0.9 } }],
    ['passThreshold below default fail threshold', { judge: { passThreshold: 0.2 } }],
    ['samples 0', { judge: { samples: 0 } }],
    ['samples 10', { judge: { samples: 10 } }],
    ['samples fractional', { judge: { samples: 2.5 } }],
    ['maxSpread > 1', { judge: { maxSpread: 2 } }],
    ['vision not boolean', { judge: { vision: 'yes' } }],
    ['maxActions 0', { agent: { maxActions: 0 } }],
    ['maxModelCalls negative', { agent: { maxModelCalls: -3 } }],
    ['maxAttempts 0', { checks: { maxAttempts: 0 } }],
    ['requireDeterministic not boolean', { checks: { requireDeterministic: 1 } }],
    ['settle.timeoutMs 0', { settle: { timeoutMs: 0 } }],
    ['settle.intervalMs 0', { settle: { intervalMs: 0 } }],
    ['settle.quietMs negative', { settle: { quietMs: -1 } }],
    ['denyVerbs unknown verb', { policy: { denyVerbs: ['teleport'] } }],
    ['policy unknown key', { policy: { allowAll: true } }],
    ['concurrency.scenarios 0', { concurrency: { scenarios: 0 } }],
    ['reporter unknown', { reporters: ['html'] }],
    ['price negative', { prices: { m: { inputPerMTok: -1, outputPerMTok: 1 } } }],
    ['price missing key', { prices: { m: { inputPerMTok: 1 } } }],
    ['context not a string', { context: 5 }],
  ];

  it.each(bad)('CONFIG_INVALID: %s', (_name, user) => {
    expect(code(() => resolve(user as UserConfig))).toBe('CONFIG_INVALID');
  });

  it('the error lists every offending path without echoing values', () => {
    try {
      resolve({ docz: [], extract: { concurrency: 0 }, judge: { samples: 99 } } as unknown as UserConfig);
      expect.unreachable();
    } catch (e) {
      const err = e as AiBddError;
      expect(err.code).toBe('CONFIG_INVALID');
      expect(err.message).toMatch(/docz/);
      expect(err.message).toMatch(/extract\.concurrency/);
      expect(err.message).toMatch(/judge\.samples/);
    }
  });

  const good: [string, UserConfig][] = [
    ['empty config', {}],
    ['thresholds at the extremes', { judge: { passThreshold: 1, failThreshold: 0 } }],
    ['samples bounds 1 and 9', { judge: { samples: 1 } }],
    ['samples 9', { judge: { samples: 9 } }],
    ['probeMs 0 and confirmRuns 0', { characterize: { probeMs: 0, confirmRuns: 0 } }],
    ['sectionDepth 6', { extract: { sectionDepth: 6 } }],
    ['empty docs list', { docs: [] }],
    ['explicit undefined values', { baseURL: undefined, judge: { samples: undefined } } as unknown as UserConfig],
    ['custom reporters', { reporters: ['json'] }],
    ['prices', { prices: { 'm-1': { inputPerMTok: 3, outputPerMTok: 15 } } }],
  ];
  it.each(good)('accepts %s', (_name, user) => {
    expect(() => resolve(user)).not.toThrow();
  });
});

describe('resolveConfig secrets (R-SE1)', () => {
  const user: UserConfig = { secrets: { adminPassword: { env: 'ADMIN_PASSWORD' }, apiKey: { env: 'API_KEY' } } };

  it('R-SE1: ResolvedConfig stores only env var names, never values', () => {
    const env = { ADMIN_PASSWORD: 'hunter2-SUPER-secret', API_KEY: 'k-9f8e7d6c5b4a' };
    const c = resolve({ ...user, models, drivers: { web: driver } }, env);
    expect(c.secrets).toEqual({ adminPassword: { env: 'ADMIN_PASSWORD' }, apiKey: { env: 'API_KEY' } });
    const json = JSON.stringify(c);
    for (const v of Object.values(env)) {
      expect(json).not.toContain(v);
      expect(json).not.toContain(Buffer.from(v).toString('base64'));
      expect(json).not.toContain(encodeURIComponent(v));
    }
  });

  it('R-SE1: a missing or empty env var is not an error at resolve time', () => {
    expect(() => resolve(user, {})).not.toThrow();
    expect(() => resolve(user, { ADMIN_PASSWORD: '' })).not.toThrow();
  });

  it.each(['a', 'abc', '123'])('R-SE1: SECRET_TOO_SHORT for a %j value (< 4 chars)', (value) => {
    expect(code(() => resolve(user, { ADMIN_PASSWORD: value }))).toBe('SECRET_TOO_SHORT');
  });

  // Found by tests/fuzz/config.test.ts (counterexample: secrets {"0": {env: "toString"}}, env {}).
  it.each(['toString', 'constructor', 'hasOwnProperty', '__proto__', 'valueOf'])(
    'R-SE1: an env var named like an Object.prototype member (%s) is unset, not an inherited function',
    (envName) => {
      const user = { secrets: { token: { env: envName } } };
      expect(code(() => resolve(user, {}))).toBe('none');
      expect(resolve(user, {}).secrets).toEqual({ token: { env: envName } });
      expect(code(() => resolve(user, { [envName]: 'abc' }))).toBe('SECRET_TOO_SHORT');
    },
  );

  it('R-SE1: a secret declared under the name __proto__ is rejected instead of being silently dropped (and left unredacted)', () => {
    const user = JSON.parse('{"secrets":{"__proto__":{"env":"ADMIN_PASSWORD"},"ok":{"env":"API_KEY"}}}') as UserConfig;
    expect(code(() => resolve(user, { ADMIN_PASSWORD: 'hunter2hunter2' }))).toBe('CONFIG_INVALID');
  });

  it('R-SE1: a 4-character secret is accepted and the error never contains the value', () => {
    expect(() => resolve(user, { ADMIN_PASSWORD: 'abcd' })).not.toThrow();
    try {
      resolve(user, { API_KEY: 'xyz' });
      expect.unreachable();
    } catch (e) {
      expect((e as AiBddError).message).not.toContain('xyz');
      expect(JSON.stringify((e as AiBddError).toPayload())).not.toContain('"xyz"');
    }
  });
});
