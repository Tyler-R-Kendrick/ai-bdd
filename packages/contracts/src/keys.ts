import type { Binding, BindingDescriptor, ParamDecl } from './bindings.js';
import type { Selector } from './driver.js';
import type { JsonValue } from './primitives.js';
import { canonicalJson, hashJson, normalizeStepText, sha256Hex, stableStringify } from './helpers.js';

/** Canonical form used to hash a binding descriptor (key order independent). */
export function bindingHashInput(desc: BindingDescriptor): JsonValue {
  const params: JsonValue = (desc.params ?? []).map((param: ParamDecl) => ({
    name: param.name,
    type: param.type,
    ...(param.enumValues ? { enumValues: [...param.enumValues] } : {}),
    ...(param.derived ? { derived: true } : {}),
    ...(param.optional ? { optional: true } : {}),
  }));
  return {
    id: desc.id,
    provider: desc.provider,
    pattern: desc.pattern,
    patternKind: desc.patternKind,
    kind: desc.kind,
    description: desc.description ?? null,
    examples: desc.examples ?? [],
    counterExamples: desc.counterExamples ?? [],
    params,
    strictKind: desc.strictKind ?? false,
    tags: desc.tags ?? [],
  };
}

export function bindingHash(desc: BindingDescriptor): string {
  return hashJson(bindingHashInput(desc));
}

/**
 * The text used for embedding: the pattern with parameter placeholders turned
 * into `<name>` form, plus description and examples (section 8.1.1 step 4).
 */
export function bindingTexts(desc: BindingDescriptor): string[] {
  const texts: string[] = [patternToText(desc.pattern, desc.patternKind)];
  if (desc.description) texts.push(desc.description);
  for (const example of desc.examples ?? []) texts.push(example);
  return texts.map((text) => normalizeStepText(text)).filter((text) => text.length > 0);
}

export function patternToText(pattern: string, patternKind: BindingDescriptor['patternKind']): string {
  switch (patternKind) {
    case 'gauge-template':
      return pattern;
    case 'cucumber-expression':
      return pattern.replace(/\{([^{}]+)\}/gu, '<$1>');
    case 'regex': {
      let text = pattern;
      if (text.startsWith('^')) text = text.slice(1);
      if (text.endsWith('$')) text = text.slice(0, -1);
      return text.replace(/\\(.)/gu, '$1');
    }
    default:
      return pattern;
  }
}

export function withHash(desc: BindingDescriptor): Binding {
  return { ...desc, hash: bindingHash(desc), bindingTexts: bindingTexts(desc) };
}

/** Deterministic hash over a binding set: sorted per-binding hashes. */
export function bindingSetHash(bindings: Array<Pick<Binding, 'hash'>>): string {
  const hashes = bindings.map((binding) => binding.hash).sort();
  return sha256Hex(hashes.join('\n'));
}

/** Stable identity for a selector, used by effect signatures and diffing. */
export function selectorId(selector: Selector): string {
  return canonicalJson({
    role: selector.role,
    name: selector.name ?? null,
    testId: selector.testId ?? null,
    text: selector.text ?? null,
    ancestors: (selector.ancestors ?? []).map((ancestor) => ({ role: ancestor.role, name: ancestor.name ?? null })),
    index: selector.index ?? null,
  });
}

export interface ActKeyInput {
  text: string;
  params: string[];
  driver: string;
  driverMajor: number;
  target?: string;
  contextHash?: string;
}

/** actKey (section 8.5). */
export function actKey(input: ActKeyInput): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      kind: 'act',
      text: normalizeStepText(input.text),
      params: [...input.params].sort(),
      driver: input.driver,
      driverMajor: input.driverMajor,
      target: input.target ?? null,
      context: input.contextHash ?? null,
    }),
  );
}

export interface CheckKeyInput {
  text: string;
  driver: string;
  driverMajor: number;
  target?: string;
}

/** checkKey (section 8.5). */
export function checkKey(input: CheckKeyInput): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      kind: 'check',
      text: normalizeStepText(input.text),
      driver: input.driver,
      driverMajor: input.driverMajor,
      target: input.target ?? null,
    }),
  );
}

export interface JudgeCacheKeyInput {
  criterion: string;
  beforeShas: string[];
  afterShas: string[];
  treeShas: string[];
  modelId: string;
  promptVersion: string;
}

/** Verdict reuse is allowed only on a byte-identical judge input (R-K19). */
export function judgeCacheKey(input: JudgeCacheKeyInput): string {
  return sha256Hex(
    canonicalJson({
      criterion: input.criterion,
      beforeSha: [...input.beforeShas].sort(),
      afterSha: [...input.afterShas].sort(),
      treeShas: [...input.treeShas].sort(),
      model: input.modelId,
      promptVersion: input.promptVersion,
    }),
  );
}

/** Resolution lock key (R-K7): dialect and driver independent. */
export function lockKey(input: { normalizedStepText: string; kind: string; kindClass: string }): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      text: input.normalizedStepText,
      kind: input.kind,
      kindClass: input.kindClass,
    }),
  );
}

export { stableStringify };
