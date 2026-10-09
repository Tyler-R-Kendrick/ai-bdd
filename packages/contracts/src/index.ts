/**
 * @ai-bdd/contracts — shared contracts for ai-bdd.
 *
 * Section 10 of the specification. Every package codes against these types;
 * only the contracts swarm edits this package.
 */

export * from './primitives.js';
export * from './ast.js';
export * from './bindings.js';
export * from './resolution.js';
export * from './driver.js';
export * from './programs.js';
export * from './models.js';
export * from './judge.js';
export * from './evidence.js';
export * from './results.js';
export * from './events.js';
export * from './hooks.js';
export * from './config.js';
export * from './errors.js';
export * from './helpers.js';
export * from './templates.js';
export * from './keys.js';
export * from './tools.js';
export * from './schemas.js';
export * from './schemas-driver.js';
export * from './schemas-results.js';
export * from './tools-schemas.js';
export * from './tools-table.js';

/** Package version, mirrored in RunReport.version. */
export const CONTRACTS_VERSION = '0.1.0';
