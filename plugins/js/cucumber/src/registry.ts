import type { BindingDescriptor, JsonValue, ParamDecl, StepKind } from '@ai-bdd/contracts';
import { withHash } from '@ai-bdd/contracts';

export type StepFunction = (params: Record<string, JsonValue>, context: unknown) => unknown | Promise<unknown>;

export interface StepBindingOptions {
  description?: string;
  examples?: string[];
  counterExamples?: string[];
  kind?: StepKind;
  params?: ParamDecl[];
  provider?: string;
}

const PROVIDER = 'ts:cucumber';

/**
 * The local binding table a plugin keeps.
 *
 * The daemon decides *which* binding wins, the plugin owns the functions, and
 * only the plugin can invoke them: `aibdd_resolve_step` answers `invoke-local`
 * and the plugin then reports the outcome with `aibdd_report_binding_result`.
 */
export class LocalBindings {
  private readonly functions = new Map<string, StepFunction>();
  private readonly descriptors: BindingDescriptor[] = [];
  private counter = 0;

  add(pattern: string, fn: StepFunction, options: StepBindingOptions = {}): string {
    this.counter += 1;
    const binding = withHash({
      id: `${options.provider ?? PROVIDER}#${slugify(pattern)}-${this.counter}`,
      provider: options.provider ?? PROVIDER,
      pattern,
      patternKind: 'cucumber-expression',
      kind: options.kind ?? 'action',
      ...(options.description !== undefined ? { description: options.description } : {}),
      ...(options.examples !== undefined ? { examples: options.examples } : {}),
      ...(options.counterExamples !== undefined ? { counterExamples: options.counterExamples } : {}),
      ...(options.params !== undefined ? { params: options.params } : {}),
    });
    this.functions.set(binding.id, fn);
    this.descriptors.push(binding);
    return binding.id;
  }

  /** Descriptors as the daemon wants them: no hash fields, the server computes those. */
  publish(): BindingDescriptor[] {
    // The daemon computes the hashes; sending them would be redundant.
    return this.descriptors.map((descriptor) => {
      const copy: Record<string, unknown> = { ...descriptor };
      delete copy.hash;
      delete copy.bindingTexts;
      return copy as unknown as BindingDescriptor;
    });
  }

  get(id: string): StepFunction | undefined {
    return this.functions.get(id);
  }

  ids(): string[] {
    return [...this.functions.keys()];
  }

  patterns(): string[] {
    return this.descriptors.map((descriptor) => descriptor.pattern);
  }
}

function slugify(pattern: string): string {
  return pattern
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 40);
}

export const localBindings = new LocalBindings();

export function bind(pattern: string, fnOrOptions: StepFunction | StepBindingOptions, maybeFn?: StepFunction): string {
  if (typeof fnOrOptions === 'function') return localBindings.add(pattern, fnOrOptions, {});
  if (!maybeFn) throw new TypeError('bind(pattern, options, fn) requires a function');
  return localBindings.add(pattern, maybeFn, fnOrOptions);
}

export function Given(pattern: string, fnOrOptions: StepFunction | StepBindingOptions, maybeFn?: StepFunction): string {
  return bindWithKind('setup', pattern, fnOrOptions, maybeFn);
}

export function When(pattern: string, fnOrOptions: StepFunction | StepBindingOptions, maybeFn?: StepFunction): string {
  return bindWithKind('action', pattern, fnOrOptions, maybeFn);
}

export function Then(pattern: string, fnOrOptions: StepFunction | StepBindingOptions, maybeFn?: StepFunction): string {
  return bindWithKind('assertion', pattern, fnOrOptions, maybeFn);
}

function bindWithKind(
  kind: StepKind,
  pattern: string,
  fnOrOptions: StepFunction | StepBindingOptions,
  maybeFn?: StepFunction,
): string {
  if (typeof fnOrOptions === 'function') return localBindings.add(pattern, fnOrOptions, { kind });
  if (!maybeFn) throw new TypeError('a step definition needs a function');
  return localBindings.add(pattern, maybeFn, { ...fnOrOptions, kind: fnOrOptions.kind ?? kind });
}
