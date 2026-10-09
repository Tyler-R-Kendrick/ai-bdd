/**
 * @ai-bdd/act — the act loop, ActProgram record/replay and effect verification.
 *
 * A cached program is replayed and its effect verified; when the recording no
 * longer matches, the agent finishes the step and the outcome is reported as
 * `healed` (never as a plain pass). New recordings are committed only by the
 * caller, after a later assertion in the same scenario passes.
 */
export { createActor, type ActCacheReader, type ActContext, type ActEvidenceWriter, type Actor, type ActorConfig, type ActorDependencies } from './actor.js';
export { computeEffect, deriveSelector, effectSatisfied, findBySelector, matchesSelectorNode, selectorFingerprint } from './selectors.js';
