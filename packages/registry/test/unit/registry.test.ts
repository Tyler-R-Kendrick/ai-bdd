import { describe, expect, it } from 'vitest';
import { withHash, type BindingDescriptor } from '@ai-bdd/contracts';
import { createRegistry } from '../../src/index.js';

function descriptor(overrides: Partial<BindingDescriptor> & Pick<BindingDescriptor, 'id' | 'pattern'>): BindingDescriptor {
  return {
    provider: 'ts:local',
    patternKind: 'cucumber-expression',
    kind: 'any',
    ...overrides,
  };
}

describe('createRegistry', () => {
  it('R-K5c: reports multiple exact matches for one step text', () => {
    const registry = createRegistry();
    registry.add(descriptor({ id: 'a', pattern: 'the user opens the page' }));
    registry.add(descriptor({ id: 'b', pattern: 'the user opens the page' }));
    const { matches } = registry.matchExact('the user opens the page');
    expect(matches.map((match) => match.binding.id)).toEqual(['a', 'b']);
  });

  it('R-K5c: filters exact matches by step kind and accepts kind:any', () => {
    const registry = createRegistry();
    registry.add(descriptor({ id: 'setup', pattern: 'a workspace exists', kind: 'setup' }));
    registry.add(descriptor({ id: 'action', pattern: 'a workspace exists', kind: 'action' }));
    registry.add(descriptor({ id: 'any', pattern: 'a workspace exists', kind: 'any' }));
    expect(registry.matchExact('a workspace exists', 'setup').matches.map((m) => m.binding.id)).toEqual(['any', 'setup']);
    expect(registry.matchExact('a workspace exists', 'assertion').matches.map((m) => m.binding.id)).toEqual(['any']);
  });

  it('anchors patterns so partial text does not match', () => {
    const registry = createRegistry();
    registry.add(descriptor({ id: 'a', pattern: 'the user opens the page' }));
    expect(registry.matchExact('the user opens the page now').matches).toHaveLength(0);
    expect(registry.matchExact('the user opens the page').matches).toHaveLength(1);
  });

  it('matches gauge templates and coerces declared parameter types', () => {
    const registry = createRegistry();
    registry.add(
      descriptor({
        id: 'gauge',
        pattern: 'Seed a workspace <name> with <seats> seats',
        patternKind: 'gauge-template',
        params: [
          { name: 'name', type: 'string' },
          { name: 'seats', type: 'int' },
        ],
      }),
    );
    const match = registry.matchExact('Seed a workspace "Acme" with 3 seats').matches[0];
    expect(match?.params).toEqual({ name: 'Acme', seats: 3 });
  });

  it('matches anchored regex patterns with named groups', () => {
    const registry = createRegistry();
    registry.add(
      descriptor({
        id: 'regex',
        pattern: '^I click the (?<label>\\w+) button$',
        patternKind: 'regex',
        params: [{ name: 'label', type: 'word' }],
      }),
    );
    const match = registry.matchExact('I click the Save button').matches[0];
    expect(match?.params).toEqual({ label: 'Save' });
    expect(registry.matchExact('I click the Save button now').matches).toHaveLength(0);
  });

  it('merges remote providers and removes them again', () => {
    const registry = createRegistry();
    registry.add(descriptor({ id: 'local', pattern: 'a local step' }));
    registry.addRemote('python:behave', [
      { id: 'py:1', provider: 'python:behave', pattern: 'a python step', patternKind: 'cucumber-expression', kind: 'any' },
    ]);
    expect(registry.set().providers).toEqual(['python:behave', 'ts:local']);
    expect(registry.find('py:1')?.provider).toBe('python:behave');
    registry.remove('python:behave');
    expect(registry.set().providers).toEqual(['ts:local']);
    expect(registry.find('py:1')).toBeUndefined();
  });

  it('exposes the registered functions by binding id', () => {
    const registry = createRegistry();
    const fn = (): string => 'ok';
    registry.add(descriptor({ id: 'fn', pattern: 'a bound step' }), fn);
    expect(registry.functions().get('fn')).toBe(fn);
    expect(registry.functions().size).toBe(1);
  });

  it('returns a deterministic binding set sorted by id', () => {
    const registry = createRegistry();
    registry.add(descriptor({ id: 'b', pattern: 'second' }));
    registry.add(descriptor({ id: 'a', pattern: 'first' }));
    expect(registry.set().bindings.map((binding) => binding.id)).toEqual(['a', 'b']);
  });

  it('R-K8: binding set hash is independent of insertion order', () => {
    const a = descriptor({ id: 'a', pattern: 'first' });
    const b = descriptor({ id: 'b', pattern: 'second' });
    const one = createRegistry();
    one.add(a);
    one.add(b);
    const two = createRegistry();
    two.add(b);
    two.add(a);
    expect(one.set().hash).toBe(two.set().hash);
  });

  it('R-K8: binding hash ignores key order and undefined optionals', () => {
    const first: BindingDescriptor = {
      id: 'x',
      provider: 'ts:local',
      pattern: 'do {word}',
      patternKind: 'cucumber-expression',
      kind: 'any',
      description: 'does a thing',
      examples: ['do it'],
      params: [{ name: 'n', type: 'word' }],
    };
    const second: BindingDescriptor = {
      params: [{ name: 'n', type: 'word' }],
      examples: ['do it'],
      description: 'does a thing',
      kind: 'any',
      patternKind: 'cucumber-expression',
      pattern: 'do {word}',
      provider: 'ts:local',
      id: 'x',
    };
    expect(withHash(first).hash).toBe(withHash(second).hash);
  });
});
