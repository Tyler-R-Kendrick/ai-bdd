import { describe, expect, it } from 'vitest';
import { mergeOptions } from '../src/index.js';

describe('mergeOptions precedence step > scenario > spec > config (section 7.3)', () => {
  it('returns the config value when no later scope sets the key', () => {
    expect(mergeOptions({ threshold: 0.5 }, {}, {}, {})).toEqual({ threshold: 0.5 });
  });

  it('lets the spec override the config', () => {
    expect(mergeOptions({ threshold: 0.5 }, { threshold: 0.6 }, {}, {})).toEqual({ threshold: 0.6 });
  });

  it('lets the scenario override the spec', () => {
    expect(mergeOptions({ threshold: 0.5 }, { threshold: 0.6 }, { threshold: 0.7 }, {})).toEqual({ threshold: 0.7 });
  });

  it('lets the step override the scenario', () => {
    expect(mergeOptions({ threshold: 0.5 }, { threshold: 0.6 }, { threshold: 0.7 }, { threshold: 0.8 })).toEqual({
      threshold: 0.8,
    });
  });

  it('applies all four levels key by key', () => {
    const merged = mergeOptions(
      { kind: 'setup', driver: 'config-driver', timeout: 1000, samples: 1 },
      { kind: 'action', driver: 'spec-driver', timeout: 2000 },
      { driver: 'scenario-driver' },
      { timeout: 3000 },
    );
    expect(merged).toEqual({
      kind: 'action',
      driver: 'scenario-driver',
      timeout: 3000,
      samples: 1,
    });
  });

  it('merges every directive key from the lowest scope that sets it', () => {
    const merged = mergeOptions(
      { kind: 'setup', mode: 'auto', threshold: 0.1, failThreshold: 0.05, samples: 2, vision: false, driver: 'a', resolve: 'auto', timeout: 10, invariant: false },
      { mode: 'check' },
      { threshold: 0.9 },
      { failThreshold: 0.2 },
    );
    expect(merged).toEqual({
      kind: 'setup',
      mode: 'check',
      threshold: 0.9,
      failThreshold: 0.2,
      samples: 2,
      vision: false,
      driver: 'a',
      resolve: 'auto',
      timeout: 10,
      invariant: false,
    });
  });

  it('never sets a key that no scope provides', () => {
    const merged = mergeOptions({}, {}, {}, {});
    expect(merged).toEqual({});
    expect(Object.keys(merged)).toEqual([]);
  });

  it('treats a false/0 value as set (no truthiness bug)', () => {
    const merged = mergeOptions({ vision: true, threshold: 0.9 }, { vision: false }, { threshold: 0 }, {});
    expect(merged).toEqual({ vision: false, threshold: 0 });
  });
});
