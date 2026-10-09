/**
 * @ai-bdd/spec-gauge — the Gauge-format markdown parser.
 *
 * Produces the shared SpecDocument AST (section 10) with 1-based source
 * locations, concepts expanded in place and recoverable diagnostics. The parser
 * never throws: `parseGaugeSpec` always returns `{document, diagnostics}`.
 */
export { parseGaugeSpec, type GaugeParseOptions } from './parse.js';
export { parseConcepts, conceptParameters } from './concepts.js';
export { printGaugeSpec } from './print.js';
export { expandConcepts, type ExpandedStep } from './expand.js';
export * from './text.js';
export { resolveStepParams, loadExternalTable, safeResolve, type ParamContext, type ResolvedParams } from './params.js';
export { readStepBlock, readTags, readDocString, type RawStep, type StepBlock, type DocStringBlock, type TagsBlock } from './blocks.js';
