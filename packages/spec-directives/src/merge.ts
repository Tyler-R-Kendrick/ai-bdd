/**
 * Option merging (section 7.3).
 *
 * Precedence: step > scenario > spec > config. Each scope keeps only the keys
 * it actually set, so later scopes win key by key.
 */
import { DIRECTIVE_KEYS } from '@ai-bdd/contracts';
import type { StepOptions } from '@ai-bdd/contracts';
import { assignOption } from './options.js';

export function mergeOptions(
  config: Partial<StepOptions>,
  spec: Partial<StepOptions>,
  scenario: Partial<StepOptions>,
  step: Partial<StepOptions>,
): StepOptions {
  const merged: Partial<StepOptions> = {};
  for (const key of DIRECTIVE_KEYS) {
    const value = step[key] ?? scenario[key] ?? spec[key] ?? config[key];
    if (value !== undefined) assignOption(merged, key, value);
  }
  return merged;
}
