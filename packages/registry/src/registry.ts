import {
  bindingSetHash,
  slug,
  withHash,
  type Binding,
  type BindingDescriptor,
  type BindingMatch,
  type BindingSet,
  type JsonValue,
  type KindsConfig,
  type ParamDecl,
  type SourceLocation,
  type StepKind,
} from '@ai-bdd/contracts';
import { compilePattern, registerParameterType, type CompiledPattern, type CustomParameterTypeDef } from './expressions.js';

/** A registered binding implementation (local providers only). */
export type BindingFn = (params: Record<string, JsonValue>, ctx: unknown) => unknown | Promise<unknown>;

/** Provider id used by the local TypeScript API. */
/**
 * The longest step text a user-supplied pattern is ever matched against.
 *
 * JavaScript cannot interrupt a catastrophically backtracking pattern, so the
 * defence is to bound the input: a real step is far shorter than this, and a
 * pathological input is truncated with a diagnostic instead of hanging the run.
 */
export const MAX_MATCH_INPUT_LENGTH = 4096;

export function boundMatchInput(text: string): string {
  return text.length > MAX_MATCH_INPUT_LENGTH ? text.slice(0, MAX_MATCH_INPUT_LENGTH) : text;
}

export const LOCAL_PROVIDER = 'ts:local';

/** Optional fields accepted by the ergonomic `bind`/`Given`/`When`/`Then` API. */
export interface BindingOptions {
  id?: string;
  provider?: string;
  patternKind?: BindingDescriptor['patternKind'];
  kind?: StepKind | 'any';
  description?: string;
  examples?: string[];
  counterExamples?: string[];
  params?: ParamDecl[];
  strictKind?: boolean;
  source?: SourceLocation;
  functionRef?: string;
  tags?: string[];
}

export interface BindInput extends BindingOptions {
  pattern: string;
  fn?: BindingFn;
}

export interface RegistryOptions {
  config?: { kinds?: KindsConfig };
}

export interface BindingRegistry {
  add(desc: BindingDescriptor, fn?: BindingFn): void;
  addRemote(provider: string, descs: BindingDescriptor[]): void;
  remove(provider: string): void;
  set(): BindingSet;
  matchExact(text: string, kind?: StepKind): { matches: BindingMatch[] };
  find(id: string): Binding | undefined;
  functions(): Map<string, BindingFn>;
}

/** `createRegistry` returns the documented interface plus the accepted config. */
export interface Registry extends BindingRegistry {
  readonly config: RegistryOptions['config'];
}

interface Entry {
  desc: BindingDescriptor;
  binding: Binding;
  compiled: CompiledPattern;
  fn?: BindingFn;
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function toDescriptor(input: BindInput, provider: string, id: string): BindingDescriptor {
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
  return desc;
}

/**
 * A binding registry. Patterns are compiled eagerly (Cucumber expressions,
 * anchored regex, Gauge templates) and hashed deterministically through the
 * contracts helpers, so the binding set is key-order independent.
 */
export function createRegistry(opts: RegistryOptions = {}): Registry {
  const entries = new Map<string, Entry>();
  const remoteProviders = new Set<string>();
  const config = opts.config;

  function insert(desc: BindingDescriptor, fn?: BindingFn): void {
    const compiled = compilePattern(desc);
    const binding = withHash(desc);
    const entry: Entry = { desc, binding, compiled };
    if (fn !== undefined) entry.fn = fn;
    entries.set(desc.id, entry);
  }

  return {
    config,
    add(desc, fn) {
      insert(desc, fn);
    },
    addRemote(provider, descs) {
      remoteProviders.add(provider);
      for (const desc of descs) insert({ ...desc, provider }, undefined);
    },
    remove(provider) {
      remoteProviders.delete(provider);
      for (const id of [...entries.keys()]) {
        if (entries.get(id)?.desc.provider === provider) entries.delete(id);
      }
    },
    set() {
      const bindings = [...entries.values()]
        .map((entry) => entry.binding)
        .sort(byId);
      const providers = [...new Set(bindings.map((binding) => binding.provider))].sort();
      return { bindings, hash: bindingSetHash(bindings), providers };
    },
    matchExact(rawText, kind) {
      const matches: BindingMatch[] = [];
      // A user-supplied pattern is only ever run against a bounded string, so a
      // catastrophically backtracking expression cannot hang the run (section 17).
      const text = boundMatchInput(rawText);
      const sorted = [...entries.values()].sort((a, b) => byId(a.desc, b.desc));
      for (const entry of sorted) {
        if (kind !== undefined && entry.desc.kind !== 'any' && entry.desc.kind !== kind) continue;
        const match = entry.compiled.match(text);
        if (match !== null) {
          matches.push({ binding: entry.binding, params: match.params, spans: match.spans });
        }
      }
      return { matches };
    },
    find(id) {
      return entries.get(id)?.binding;
    },
    functions() {
      const map = new Map<string, BindingFn>();
      for (const [id, entry] of entries) {
        if (entry.fn !== undefined) map.set(id, entry.fn);
      }
      return map;
    },
  };
}
