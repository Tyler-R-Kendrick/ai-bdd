/**
 * Kind inference (section 7.4).
 *
 * Order, recording `kindSource`:
 *   1. an explicit directive `kind=`                 -> directive
 *   2. an explicit dialect keyword (Given/When/Then) -> keyword  (section 7.2)
 *   3. the matched binding's kind (when not `any`)   -> binding
 *   4. assertion prefix + verb heuristic             -> prefix
 *   5. otherwise                                     -> default (action)
 */
import { DEFAULT_KIND_CONFIG, normalizeStepText } from '@ai-bdd/contracts';
import type { KindsConfig, KindSource, StepKind, StepOptions } from '@ai-bdd/contracts';

export interface KindInferenceInput {
  text: string;
  keyword?: string;
  options?: StepOptions;
  bindingKind?: StepKind | 'any';
  config?: { kinds?: KindsConfig };
}

export interface KindInference {
  kind: StepKind;
  kindSource: KindSource;
}

const KEYWORD_KINDS: Record<string, StepKind> = {
  // Gherkin keywordType values (dialect independent).
  context: 'setup',
  action: 'action',
  outcome: 'assertion',
  // English keywords.
  given: 'setup',
  when: 'action',
  then: 'assertion',
  setup: 'setup',
};

/** Map a dialect keyword to a kind. `And`/`But`/`*` inherit, so they map to undefined. */
export function kindFromKeyword(keyword: string | undefined): StepKind | undefined {
  if (keyword === undefined) return undefined;
  const normalized = keyword.trim().toLowerCase();
  if (normalized.length === 0 || normalized === '*' || normalized === 'and' || normalized === 'but') return undefined;
  return KEYWORD_KINDS[normalized];
}

/** Prefix + verb assertion heuristic (section 7.4 step 3). */
export function isAssertionPhrase(text: string, kinds: Required<KindsConfig>): boolean {
  const normalized = normalizeStepText(text).toLowerCase();
  if (normalized.length === 0) return false;
  const hasPrefix = kinds.assertionPrefixes.some((prefix) => normalized.startsWith(prefix.toLowerCase()));
  if (!hasPrefix) return false;
  return kinds.assertionVerbs.some((verb) => normalized.includes(verb.toLowerCase()));
}

export function inferKind(input: KindInferenceInput): KindInference {
  const explicit = input.options?.kind;
  if (explicit !== undefined) return { kind: explicit, kindSource: 'directive' };

  const fromKeyword = kindFromKeyword(input.keyword);
  if (fromKeyword !== undefined) return { kind: fromKeyword, kindSource: 'keyword' };

  if (input.bindingKind !== undefined && input.bindingKind !== 'any') {
    return { kind: input.bindingKind, kindSource: 'binding' };
  }

  const kinds: Required<KindsConfig> = {
    assertionPrefixes: input.config?.kinds?.assertionPrefixes ?? DEFAULT_KIND_CONFIG.assertionPrefixes,
    assertionVerbs: input.config?.kinds?.assertionVerbs ?? DEFAULT_KIND_CONFIG.assertionVerbs,
  };
  if (isAssertionPhrase(input.text, kinds)) return { kind: 'assertion', kindSource: 'prefix' };

  return { kind: 'action', kindSource: 'default' };
}
