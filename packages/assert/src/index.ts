/**
 * @ai-bdd/assert — the assertion engine.
 *
 * - `generateCheckProgram` asks the model for declarative predicates (never code)
 * - `lintCheckProgram` rejects volatile literals (R-K10)
 * - `evaluatePredicates` is the shared deterministic evaluator
 * - `createAsserter` composes checks and the judge and enforces the
 *   discriminative rule (R-K9)
 */
export { createAsserter, generateCheckProgram, describe, type AssertWindow, type Asserter, type AsserterDependencies, type CheckCacheReader } from './asserter.js';
export { allSatisfied, anyUnknown, evaluatePredicates, flattenNodes, matchesSelector } from './evaluate.js';
export { VOLATILE_PATTERNS, lintCheckProgram } from './lint.js';
