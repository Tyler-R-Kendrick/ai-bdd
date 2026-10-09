import { describe, expect, it } from 'vitest';
import { defineConfig, resolveConfig, compileTagExpression, globToRegExp } from '../../src/index.js';
import { fake } from '@ai-bdd/driver-fake';

describe('R-K13: concurrency declarations and resource locks', () => {
  it('the fake driver declares a session cap', async () => {
    const factory = fake({ modelPath: '/workspace/fixtures/app/model.json' });
    const driver = await factory.create({ sessionId: 's', scenarioId: 'sc', config: {} });
    expect(driver.concurrency.maxSessions).toBeGreaterThanOrEqual(1);
    expect(driver.concurrency.exclusiveResource).toBeUndefined();
  });

  it('the runtime exposes the configured scenario concurrency', () => {
    const resolved = resolveConfig({ concurrency: { scenarios: 3 } }, '/tmp');
    expect(resolved.concurrency.scenarios).toBe(3);
  });
});

describe('configuration validation (R-K16 policy, SECRET_TOO_SHORT)', () => {
  it('rejects unknown keys with CONFIG_UNKNOWN_KEY', () => {
    expect(() => resolveConfig({ nonsense: true } as never, '/tmp')).toThrow(/unknown configuration key/u);
  });

  it('rejects a secret shorter than 4 characters', () => {
    expect(() => resolveConfig({ secrets: { pin: { value: '123' } } }, '/tmp')).toThrow(/shorter than 4/u);
  });

  it('defaults the host allowlist to localhost (N7)', () => {
    const resolved = resolveConfig({}, '/tmp');
    expect(resolved.policy.allowHosts).toEqual(['localhost', '127.0.0.1', '[::1]']);
    expect(resolved.policy.denyVerbs).toEqual([]);
  });

  it('defines an identity config helper', () => {
    const config = defineConfig({ specs: ['a'] });
    expect(config.specs).toEqual(['a']);
  });
});

describe('tag expressions and globs', () => {
  it('evaluates @a, not @a, and, or, parentheses', () => {
    const tags = ['@billing', '@smoke'];
    expect(compileTagExpression('@billing')(tags)).toBe(true);
    expect(compileTagExpression('not @billing')(tags)).toBe(false);
    expect(compileTagExpression('@billing and @smoke')(tags)).toBe(true);
    expect(compileTagExpression('@missing or @smoke')(tags)).toBe(true);
    expect(compileTagExpression('(@billing and @missing) or @smoke')(tags)).toBe(true);
  });

  it('expands brace globs and ** segments', () => {
    expect(globToRegExp('specs/**/*.{spec,spec.md}').test('specs/billing.spec.md')).toBe(true);
    expect(globToRegExp('specs/**/*.{spec,spec.md}').test('specs/nested/deep/x.spec')).toBe(true);
    expect(globToRegExp('features/*.feature').test('features/a.feature')).toBe(true);
    expect(globToRegExp('features/*.feature').test('features/sub/a.feature')).toBe(false);
  });
});
