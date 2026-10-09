import { describe, expect, it } from 'vitest';
import { bind, defineConfig, defineParameterType, Given, Then, When } from '../../src/index.js';

describe('@ai-bdd/core facade', () => {
  it('defineConfig is an identity helper', () => {
    const config = defineConfig({ specs: ['a'], concurrency: { scenarios: 2 } });
    expect(config.specs).toEqual(['a']);
    expect(config.concurrency?.scenarios).toBe(2);
  });

  it('exposes the binding API', () => {
    for (const fn of [bind, Given, When, Then, defineParameterType]) {
      expect(typeof fn).toBe('function');
    }
  });
});
