/**
 * @ai-bdd/daemon — the orchestrator daemon.
 *
 * One tool table, two surfaces: MCP (`aibdd_<tool>`) for agents and IDEs, and an
 * HTTP JSON mirror (`POST /v1/<tool>`) for language plugins. Both go through
 * `callTool`, so they validate the same schemas and cannot diverge (R-K12a, AC8).
 */
export { startDaemon, startProjectDaemon, type DaemonHandle, type DaemonOptions } from './daemon.js';
export { startHttpMirror, type HttpMirror, type HttpMirrorOptions } from './http.js';
export { createMcpServer, serveStdioMcp, type McpSurfaceOptions } from './mcp.js';
export { callTool, TOOL_DEFINITIONS, TOOL_TABLE, type ToolBackend, type ToolCallResult } from './tools.js';
export { TOOL_SHORT_NAMES, TOOL_SHORT_NAMES as toolNames } from '@ai-bdd/contracts';
