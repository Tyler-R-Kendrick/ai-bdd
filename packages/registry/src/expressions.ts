import { CucumberExpression, ParameterType, ParameterTypeRegistry } from '@cucumber/cucumber-expressions';
import {
  gaugeTemplateToRegExp,
  normalizeStepText,
  type BindingDescriptor,
  type JsonValue,
  type ParamDecl,
  type ParamType,
} from '@ai-bdd/contracts';

/**
 * A custom Cucumber parameter type declared through `defineParameterType`.
 * Mirrors the subset of the Cucumber API ai-bdd exposes.
 */
export interface CustomParameterTypeDef {
  name: string;
  regexp: RegExp;
  transformer?: (value: string) => JsonValue;
}

/**
 * One shared parameter-type registry, so `defineParameterType` behaves exactly
 * like Cucumber's process-global registry: every `BindingRegistry` created
 * afterwards can use the custom types.
 */
export const parameterTypeRegistry = new ParameterTypeRegistry();

export function registerParameterType(def: CustomParameterTypeDef): void {
  const transform = (...match: string[]): JsonValue => {
    const raw = match[0] ?? '';
    return def.transformer ? def.transformer(raw) : raw;
  };
  parameterTypeRegistry.defineParameterType(
    new ParameterType<JsonValue>(def.name, def.regexp, null, transform, false, false),
  );
}

export interface CompiledMatch {
  /** Parameter name to extracted value, typed by the binding's ParamDecl[] (R-K5d). */
  params: Record<string, JsonValue>;
  /** Raw captured spans, in declaration order (used by the polarity guard). */
  spans: string[];
}

export interface CompiledPattern {
  readonly pattern: string;
  readonly patternKind: BindingDescriptor['patternKind'];
  readonly parameterNames: string[];
  match(text: string): CompiledMatch | null;
}

function coerce(value: string, decl: ParamDecl | undefined): JsonValue {
  switch (decl?.type as ParamType | undefined) {
    case 'int': {
      const parsed = Number.parseInt(value, 10);
      return Number.isNaN(parsed) ? value : parsed;
    }
    case 'float': {
      const parsed = Number.parseFloat(value);
      return Number.isNaN(parsed) ? value : parsed;
    }
    default:
      return value;
  }
}

/** Keep a cucumber transformer result but fall back to deterministic coercion. */
function normalizeTransformed(value: JsonValue | null, raw: string, decl: ParamDecl | undefined): JsonValue {
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return decl?.type === 'int' || decl?.type === 'float' ? coerce(value, decl) : value;
  }
  if (value === null) return decl?.type === 'int' || decl?.type === 'float' ? coerce(raw, decl) : raw;
  return String(value);
}

function namesFromDecls(decls: ParamDecl[] | undefined, count: number): string[] {
  const names = (decls ?? []).map((decl) => decl.name);
  for (let index = names.length; index < count; index += 1) names.push(`arg${index}`);
  return names;
}

function namedGroups(pattern: string): string[] {
  const names: string[] = [];
  const re = /\(\?<([A-Za-z_$][A-Za-z0-9_$]*)>/gu;
  let match: RegExpExecArray | null;
  while ((match = re.exec(pattern)) !== null) {
    if (match[1] !== undefined) names.push(match[1]);
  }
  return names;
}

function anchorRegex(pattern: string): string {
  let source = pattern;
  if (!source.startsWith('^')) source = `^${source}`;
  if (!source.endsWith('$')) source = `${source}$`;
  return source;
}

function compileCucumber(desc: BindingDescriptor): CompiledPattern {
  const expression = new CucumberExpression(desc.pattern, parameterTypeRegistry);
  const decls = desc.params ?? [];
  return {
    pattern: desc.pattern,
    patternKind: desc.patternKind,
    get parameterNames(): string[] {
      return namesFromDecls(decls, decls.length);
    },
    match(text: string): CompiledMatch | null {
      const args = expression.match(normalizeStepText(text));
      if (args === null) return null;
      const names = namesFromDecls(decls, args.length);
      const params: Record<string, JsonValue> = {};
      const spans: string[] = [];
      args.forEach((arg, index) => {
        const raw = arg.group.value;
        spans.push(raw);
        const transformed = arg.getValue<JsonValue>(undefined);
        params[names[index] ?? `arg${index}`] = normalizeTransformed(transformed, raw, decls[index]);
      });
      return { params, spans };
    },
  };
}

function compileRegex(desc: BindingDescriptor): CompiledPattern {
  const regex = new RegExp(anchorRegex(desc.pattern), 'u');
  const decls = desc.params ?? [];
  const named = namedGroups(desc.pattern);
  return {
    pattern: desc.pattern,
    patternKind: desc.patternKind,
    get parameterNames(): string[] {
      return named.length > 0 ? named : namesFromDecls(decls, decls.length);
    },
    match(text: string): CompiledMatch | null {
      const result = regex.exec(normalizeStepText(text));
      if (result === null) return null;
      const spans = result.slice(1).map((value) => value ?? '');
      const names = named.length > 0 ? named : namesFromDecls(decls, spans.length);
      const params: Record<string, JsonValue> = {};
      spans.forEach((raw, index) => {
        params[names[index] ?? `arg${index}`] = coerce(raw, decls[index]);
      });
      return { params, spans };
    },
  };
}

function compileGaugeTemplate(desc: BindingDescriptor): CompiledPattern {
  const matcher = gaugeTemplateToRegExp(desc.pattern);
  const decls = desc.params ?? [];
  const byName = new Map(decls.map((decl) => [decl.name, decl]));
  return {
    pattern: desc.pattern,
    patternKind: desc.patternKind,
    get parameterNames(): string[] {
      return [...matcher.parameters];
    },
    match(text: string): CompiledMatch | null {
      const result = matcher.match(text);
      if (result === null) return null;
      const params: Record<string, JsonValue> = {};
      matcher.parameters.forEach((name, index) => {
        const raw = result.values[index] ?? '';
        params[name] = coerce(raw, byName.get(name) ?? decls[index]);
      });
      return { params, spans: [...result.spans] };
    },
  };
}

/**
 * Compile a binding pattern into an anchored matcher. Cucumber expressions use
 * `@cucumber/cucumber-expressions`, `regex` patterns are anchored explicitly,
 * and Gauge templates reuse `gaugeTemplateToRegExp` from the contracts package.
 */
export function compilePattern(desc: BindingDescriptor): CompiledPattern {
  switch (desc.patternKind) {
    case 'cucumber-expression':
      return compileCucumber(desc);
    case 'regex':
      return compileRegex(desc);
    case 'gauge-template':
      return compileGaugeTemplate(desc);
    default:
      return compileCucumber(desc);
  }
}
