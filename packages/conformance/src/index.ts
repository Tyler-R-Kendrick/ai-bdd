/**
 * @ai-bdd/conformance — the driver, plugin and daemon-protocol conformance kits.
 *
 * - `runDriverConformance(factory, options)` for drivers
 * - `runPluginConformance({ run })` plus the feature/script/expected kit for plugins
 * - `runProtocolConformance(options)` and `validateToolPayload` for the daemon
 */
export * from './driver-conformance.js';
export * from './plugin-conformance.js';
export * from './protocol-conformance.js';
