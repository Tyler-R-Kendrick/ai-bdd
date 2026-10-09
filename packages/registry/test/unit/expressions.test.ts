import { describe, expect, it } from 'vitest';
import {
  Given,
  Then,
  When,
  bind,
  createRegistry,
  defaultBindingRegistry,
  defineParameterType,
  type BindingDescriptor,
} from '../../src/index.js';

function descriptor(overrides: Partial<BindingDescriptor> & Pick<BindingDescriptor, 'id' | 'pattern'>): BindingDescriptor {
  return { provider: 'ts:local', patternKind: 'cucumber-expression', kind: 'any', ...overrides };
}

describe('cucumber expressions', () => {
  it('types {int} as a number and {float} as a number', () => {
    const registry = createRegistry();
    registry.add(
      descriptor({
        id: 'ints',
        pattern: 'I have {int} cucumbers and {float} kg of flour',
        params: [
          { name: 'count', type: 'int' },
          { name: 'weight', type: 'float' },
        ],
      }),
    );
    const match = registry.matchExact('I have 12 cucumbers and 1.5 kg of flour').matches[0];
    expect(match?.params).toEqual({ count: 12, weight: 1.5 });
    expect(typeof match?.params.count).toBe('number');
    expect(typeof match?.params.weight).toBe('number');
  });

  it('captures {string} without quotes and {word} as a single token', () => {
    const registry = createRegistry();
    registry.add(
      descriptor({
        id: 'words',
        pattern: 'I type {string} into the {word} field',
        params: [
          { name: 'value', type: 'string' },
          { name: 'field', type: 'word' },
        ],
      }),
    );
    const match = registry.matchExact('I type "Acme Corp" into the company field').matches[0];
    expect(match?.params).toEqual({ value: 'Acme Corp', field: 'company' });
  });

  it('supports custom parameter types declared with defineParameterType', () => {
    defineParameterType({ name: 'color', regexp: /red|green|blue/ });
    const registry = createRegistry();
    registry.add(
      descriptor({
        id: 'paint',
        pattern: 'I paint the button {color}',
        params: [{ name: 'color', type: 'word' }],
      }),
    );
    const match = registry.matchExact('I paint the button blue').matches[0];
    expect(match?.params).toEqual({ color: 'blue' });
  });
});

describe('local TS API', () => {
  it('Given/When/Then set the step kind', () => {
    Given('a fresh workspace named {word}', { params: [{ name: 'name', type: 'word' }] }, () => undefined);
    When('the user signs up', () => undefined);
    Then('the plan badge reads {string}', () => undefined);
    const kinds = new Map(defaultBindingRegistry.set().bindings.map((binding) => [binding.pattern, binding.kind]));
    expect(kinds.get('a fresh workspace named {word}')).toBe('setup');
    expect(kinds.get('the user signs up')).toBe('action');
    expect(kinds.get('the plan badge reads {string}')).toBe('assertion');
  });

  it('bind() defaults to provider ts:local and kind any, and stores the fn', () => {
    const fn = (): string => 'done';
    bind({ pattern: 'the admin archives the project', description: 'archives', fn });
    const binding = defaultBindingRegistry.set().bindings.find((entry) => entry.pattern === 'the admin archives the project');
    expect(binding?.provider).toBe('ts:local');
    expect(binding?.kind).toBe('any');
    expect(defaultBindingRegistry.functions().get(binding?.id ?? '')).toBe(fn);
  });

  it('bind() keeps two bindings with the same pattern under distinct ids', () => {
    bind({ pattern: 'the same pattern', kind: 'setup' });
    bind({ pattern: 'the same pattern', kind: 'action' });
    const matches = defaultBindingRegistry.set().bindings.filter((entry) => entry.pattern === 'the same pattern');
    expect(matches).toHaveLength(2);
    expect(new Set(matches.map((entry) => entry.id)).size).toBe(2);
  });
});
