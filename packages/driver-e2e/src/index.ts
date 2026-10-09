/**
 * @ai-bdd/driver-e2e — a driver over `e2e mcp` (TesterArmy e2e), public API only.
 *
 * e2e is used in exactly two public ways (R-K1b): this driver, and
 * `@ai-bdd/e2e-host`, which registers specs inside e2e's own runner.
 */
export { e2e, E2E_DRIVER_MAJOR, type E2eDriverOptions } from './driver.js';
export { E2eMcpClient, type E2eMcpClientOptions } from './client.js';
export { E2eSession, type E2eSessionOptions } from './session.js';
export {
  E2E_CATALOG,
  E2E_ERROR_MAP,
  E2E_VERB_MAP,
  capabilitiesFromCatalog,
  e2eMcpArgs,
  mapE2eError,
  normalizeMaxSessions,
} from './verbs.js';
export { parseObserveText, treeHashOf, toObservation, type ObserveParseResult } from './observe.js';
export {
  extractErrorCode,
  toolResultJson,
  toolResultText,
  type McpCaller,
  type McpToolResult,
  type OpenSessionResult,
} from './mcp.js';
