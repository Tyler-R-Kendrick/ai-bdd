/**
 * @ai-bdd/act — the act layer.
 *
 * The actor SPI is the swap point: an intent becomes driver actions through whichever
 * `ActActor` is registered (`model`, `e2e`, `scripted`, or a project's own). Nothing
 * downstream of the SPI knows which provider ran, and the reproduction lockfile records
 * what each one did so a run can be replayed without a model.
 */
export { createActor, type ActCacheReader, type ActContext, type ActEvidenceWriter, type Actor, type ActorConfig, type ActorDependencies } from './actor.js';
export { computeEffect, deriveSelector, effectSatisfied, findBySelector, matchesSelectorNode } from './selectors.js';
export { createActorRegistry, withTelemetry, SCRIPTED_CAPABILITIES } from './spi.js';
export { scriptedActor, type ScriptedActorOptions, type ScriptedStep } from './providers/scripted.js';
export { e2eActor, requireE2eAgent, type E2eActorOptions, type E2eAgentLike, type E2eScreenLike } from './providers/e2e.js';
export { modelActor, replayReproduction, type ModelActorOptions } from './providers/model.js';
export { ReproductionLockStore, reproductionKey, type LockSummary } from './lock.js';
