import { bindingSetHash, withHash, type Binding, type BindingDescriptor, type BindingSet } from '@ai-bdd/contracts';

/** Build a BindingSet from descriptors without importing @ai-bdd/registry. */
export function bindingSetOf(descriptors: BindingDescriptor[]): BindingSet {
  const bindings: Binding[] = descriptors
    .map(withHash)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    bindings,
    hash: bindingSetHash(bindings),
    providers: [...new Set(bindings.map((binding) => binding.provider))].sort(),
  };
}

export function desc(
  overrides: Partial<BindingDescriptor> & Pick<BindingDescriptor, 'id' | 'pattern'>,
): BindingDescriptor {
  return { provider: 'ts:local', patternKind: 'cucumber-expression', kind: 'any', ...overrides };
}
