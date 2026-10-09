/**
 * @ai-bdd/driver-cua — a native-desktop driver over the Cua Driver MCP surface.
 *
 * Cua is a driver here, not an engine: it talks to `cua-driver mcp` (or a running
 * `cua-driver serve`), observes windows with `get_window_state`, performs actions
 * with the typed contract tools, and evaluates predicates natively with
 * `verify_state`, where `unknown` counts as a failure.
 *
 * Because `type_text` targets the foreground application, the driver declares an
 * exclusive resource and one session unless `backgroundOnly` is set; in that mode
 * every action uses `delivery_mode: 'background'` with a window target and the
 * foreground-only verbs are refused with POLICY_DENIED (R-K13).
 */
import { CuaMcpClient, type CuaMcpClientOptions } from './client.js';
import { cuaFactory, type CuaDriverOptions } from './session.js';
import type { McpCaller } from './mcp.js';

export interface CuaOptions extends CuaDriverOptions, CuaMcpClientOptions {
  /** mcp (spawn `cua-driver mcp`) or daemon (attach to a running `cua-driver serve`). */
  mode?: 'mcp' | 'daemon' | 'call';
  /** Injected in tests: a scripted caller instead of a spawned CLI. */
  caller?: McpCaller;
}

/**
 * Builds the Cua driver factory.
 *
 * `mode: 'daemon'` reuses the same client: `cua-driver mcp` attaches to a running
 * daemon when one exists (VERIFY V4 documents that only `mcp` mode is exercised in
 * this sandbox, because the Cua CLI cannot run here).
 */
export function cua(options: CuaOptions): ReturnType<typeof cuaFactory> {
  const mode = options.mode ?? 'mcp';
  const caller = options.caller ?? new CuaMcpClient({ ...options, args: options.args ?? ['mcp'] });
  void mode;
  return cuaFactory(caller, options);
}

export { cuaFactory, CuaSession, type CuaDriverOptions } from './session.js';
export type { McpCaller } from './mcp.js';
export { CuaMcpClient, type CuaMcpClientOptions, type CuaToolResult } from './client.js';
export {
  CUA_ERROR_MAP,
  CUA_VERB_MAP,
  REQUIRED_TOOLS,
  capabilitiesFromTools,
  isElementToken,
  mapCuaError,
  mapVerifyState,
  type CuaNode,
} from './tools.js';
