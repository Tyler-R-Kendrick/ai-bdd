/**
 * @ai-bdd/e2e-host — runs ai-bdd specs inside TesterArmy e2e's own runner.
 *
 * Two public ways to use it (R-K1b): register specs during module evaluation, or
 * commit the generated file. Both are documented in the README; only e2e's public
 * exports are used (N5), enforced by scripts/check-e2e-imports.mjs.
 */

export { registerSpecs, type E2eFixtures, type E2eTestApi, type RegisterSpecsOptions, type Registration } from './register.js';
export { generateRegistration, defaultOutFile, describeOutput, type GenerateOptions, type GenerateResult } from './generate.js';
export { tagNames, titleFor } from './titles.js';
export { normalizeSpecGlobs } from './globs.js';
