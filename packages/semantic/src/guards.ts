import { DEFAULT_GUARD_CONFIG, normalizeStepText, type GuardConfig } from '@ai-bdd/contracts';

/** Extract numeric literals from a step text (integers and decimals). */
export function numbersIn(text: string): number[] {
  const matches = normalizeStepText(text).match(/-?\d+(?:\.\d+)?/gu) ?? [];
  return matches.map((value) => Number(value));
}

function phrasePresent(text: string, phrase: string): boolean {
  const haystack = ` ${normalizeStepText(text).toLowerCase()} `;
  return haystack.includes(` ${phrase.toLowerCase()} `);
}

function tokensPresent(text: string, tokens: string[]): string[] {
  return tokens.filter((token) => phrasePresent(text, token));
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function sameSet(a: string[], b: string[]): boolean {
  const sa = uniqueSorted(a);
  const sb = uniqueSorted(b);
  return sa.length === sb.length && sa.every((value, index) => value === sb[index]);
}

/**
 * Deterministic polarity / quantity / number guard (R-K5a-e). Returns a
 * human-readable rejection reason, or `null` when the binding text is
 * compatible with the step text.
 *
 * - polarity: negation tokens must be present on both sides or neither
 * - quantity: when the binding names a comparison, the step must name the same one
 * - number: literal numbers in the binding must match the step's literals
 */
export function polarityGuard(stepText: string, bindingText: string, opts?: GuardConfig): string | null {
  const negationTokens = opts?.negationTokens ?? DEFAULT_GUARD_CONFIG.negationTokens;
  const comparisonTokens = opts?.comparisonTokens ?? DEFAULT_GUARD_CONFIG.comparisonTokens;
  const numbers = opts?.numbers ?? DEFAULT_GUARD_CONFIG.numbers;

  const stepNeg = tokensPresent(stepText, negationTokens);
  const bindNeg = tokensPresent(bindingText, negationTokens);
  if ((stepNeg.length > 0) !== (bindNeg.length > 0)) {
    const side = stepNeg.length > 0 ? 'step' : 'binding';
    const tokens = stepNeg.length > 0 ? stepNeg : bindNeg;
    return `polarity mismatch: negation present in ${side} only (${uniqueSorted(tokens).join(', ')})`;
  }

  const stepCmp = tokensPresent(stepText, comparisonTokens);
  const bindCmp = tokensPresent(bindingText, comparisonTokens);
  if (bindCmp.length > 0 && !sameSet(stepCmp, bindCmp)) {
    return `quantity mismatch: comparison tokens differ (step: [${uniqueSorted(stepCmp).join(', ')}], binding: [${uniqueSorted(bindCmp).join(', ')}])`;
  }

  if (numbers) {
    const stepNums = numbersIn(stepText).sort((a, b) => a - b);
    const bindNums = numbersIn(bindingText).sort((a, b) => a - b);
    if (
      bindNums.length > 0 &&
      (stepNums.length !== bindNums.length || stepNums.some((value, index) => value !== bindNums[index]))
    ) {
      return `number mismatch: numeric literals differ (step: [${stepNums.join(', ')}], binding: [${bindNums.join(', ')}])`;
    }
  }

  return null;
}

/**
 * Reject a candidate whose declared counter-example is exactly the step text
 * (R-K5e): a binding explicitly says which phrasings belong to another binding.
 */
export function counterExampleGuard(stepText: string, binding: { counterExamples?: string[] }): string | null {
  const step = normalizeStepText(stepText).toLowerCase();
  for (const counterExample of binding.counterExamples ?? []) {
    if (normalizeStepText(counterExample).toLowerCase() === step) {
      return `counter-example: "${counterExample}"`;
    }
  }
  return null;
}
