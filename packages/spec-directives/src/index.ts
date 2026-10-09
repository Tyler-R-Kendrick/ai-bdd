/**
 * @ai-bdd/spec-directives — rubric and option directives for ai-bdd.
 *
 * Implements the directive grammar and kind inference of sections 7.3 and 7.4
 * for both dialects, plus the `ai-bdd lint` document rules.
 */
export {
  ASSERTION_ONLY_KEYS,
  assignOption,
  coerceDirective,
  parseAssignmentList,
  type Assignment,
  type CoerceResult,
} from './options.js';
export { extractDirectiveBody, parseDirectives, type ParsedDirectives } from './directives.js';
export {
  RUBRIC_HEADER,
  consumeRubricTable,
  consumeRubricTableDetailed,
  type RubricTableResult,
} from './rubric.js';
export {
  inferKind,
  isAssertionPhrase,
  kindFromKeyword,
  type KindInference,
  type KindInferenceInput,
} from './kind.js';
export { lintSteps } from './lint.js';
export { mergeOptions } from './merge.js';
