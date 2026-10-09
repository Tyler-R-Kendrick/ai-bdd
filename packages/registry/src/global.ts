import { slug, type BindingDescriptor, type StepKind } from '@ai-bdd/contracts';
import { registerParameterType, type CustomParameterTypeDef } from './expressions.js';
import {
  createRegistry,
  LOCAL_PROVIDER,
  type BindingFn,
  type BindingOptions,
  type BindInput,
  type Registry,
} from './registry.js';

/**
 * The process-global registry that `bind`/`Given`/`When`/`Then` write to. The
 * `@ai-bdd/core` package re-exports these functions for authoring step files.
 */
export const defaultBindingRegistry: Registry = createRegistry();

function uniqueId(pattern: string): string {
  const base = `${LOCAL_PROVIDER}#${slug(pattern) || 'binding'}`;
  let candidate = base;
  let suffix = 2;
  while (defaultBindingRegistry.find(candidate) !== undefined) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/**
 * Register a local TypeScript binding. `id`, `provider` and `patternKind` are
 * optional; the pattern kind defaults to a Cucumber expression and the provider
 * to `ts:local`.
 */
export function bind(input: BindInput, fn?: BindingFn): void {
  const provider = input.provider ?? LOCAL_PROVIDER;
  const id = input.id ?? uniqueId(input.pattern);
  const desc: BindingDescriptor = {
    id,
    provider,
    pattern: input.pattern,
    patternKind: input.patternKind ?? 'cucumber-expression',
    kind: input.kind ?? 'any',
  };
  if (input.description !== undefined) desc.description = input.description;
  if (input.examples !== undefined) desc.examples = [...input.examples];
  if (input.counterExamples !== undefined) desc.counterExamples = [...input.counterExamples];
  if (input.params !== undefined) desc.params = input.params.map((param) => ({ ...param }));
  if (input.strictKind !== undefined) desc.strictKind = input.strictKind;
  if (input.source !== undefined) desc.source = input.source;
  if (input.functionRef !== undefined) desc.functionRef = input.functionRef;
  if (input.tags !== undefined) desc.tags = [...input.tags];
  const impl = fn ?? input.fn;
  defaultBindingRegistry.add(desc, impl);
}

function defineKind(
  kind: StepKind,
  pattern: string,
  fnOrOptions: BindingFn | BindingOptions,
  maybeFn?: BindingFn,
): void {
  const options: BindingOptions = typeof fnOrOptions === 'function' ? {} : fnOrOptions;
  const fn = typeof fnOrOptions === 'function' ? fnOrOptions : maybeFn;
  bind({ ...options, pattern, kind }, fn);
}

/** `Given` is a `setup` step binding. */
export function Given(pattern: string, fnOrOptions: BindingFn | BindingOptions, maybeFn?: BindingFn): void {
  defineKind('setup', pattern, fnOrOptions, maybeFn);
}

/** `When` is an `action` step binding. */
export function When(pattern: string, fnOrOptions: BindingFn | BindingOptions, maybeFn?: BindingFn): void {
  defineKind('action', pattern, fnOrOptions, maybeFn);
}

/** `Then` is an `assertion` step binding. */
export function Then(pattern: string, fnOrOptions: BindingFn | BindingOptions, maybeFn?: BindingFn): void {
  defineKind('assertion', pattern, fnOrOptions, maybeFn);
}

/** Declare a custom Cucumber parameter type usable as `{name}` in patterns. */
export function defineParameterType(def: CustomParameterTypeDef): void {
  registerParameterType(def);
}
