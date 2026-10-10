import type { CuaClient, CuaToolResult } from '../src/client.ts';

export interface Call { tool: string; args: Record<string, unknown> }

export type Handler = (tool: string, args: Record<string, unknown>, calls: readonly Call[]) => CuaToolResult | undefined;

export function okResult(structured: Record<string, unknown> = {}, text = 'ok'): CuaToolResult {
  return { failed: false, text, structured, images: [] };
}

export function failedResult(code: string, text: string): CuaToolResult {
  return { failed: true, code, text, structured: { code }, images: [] };
}

/**
 * A `CuaClient` that answers from a script. The result shapes in the tests are the ones a real cua-driver 0.34 returned
 * (`list_windows`, `get_window_state`, `click` refusals); the real product is exercised in `real.test.ts`.
 */
export class ScriptedClient implements CuaClient {
  readonly calls: Call[] = [];
  readonly tools: ReadonlySet<string>;
  closed = false;
  private readonly handler: Handler;

  constructor(handler: Handler, tools: Iterable<string> = ['list_windows', 'get_window_state', 'click', 'type_text', 'press_key', 'scroll', 'health_report']) {
    this.handler = handler;
    this.tools = new Set(tools);
  }

  callTool(tool: string, args: Record<string, unknown>): Promise<CuaToolResult> {
    this.calls.push({ tool, args });
    return Promise.resolve(this.handler(tool, args, this.calls) ?? okResult());
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  of(tool: string): Call[] {
    return this.calls.filter((c) => c.tool === tool);
  }
}

export const WINDOW = { app_name: 'Chromium-browser', pid: 600, window_id: 4194306, title: 'Probe - Google Chrome for Testing', z_index: 0, is_on_screen: true };

export interface Row { element_index: number; role: string; label?: string; parent_index?: number; in_web_content?: boolean; [k: string]: unknown }

export function snapshot(rows: Row[], extra: Record<string, unknown> = {}): CuaToolResult {
  return okResult({
    window_title: WINDOW.title, truncated: false,
    elements: rows.map((r) => ({ element_token: `s00000001:${r.element_index}`, enabled: true, actions: ['doDefault'], ...r })),
    ...extra,
  });
}

/** The page of the real probe: a browser frame, its toolbar, and a web document with a heading, a field and a button. */
export const PAGE: Row[] = [
  { element_index: 0, role: 'frame', label: 'Probe - Google Chrome for Testing' },
  { element_index: 1, role: 'panel', label: '￼￼', parent_index: 0 },
  { element_index: 2, role: 'push button', label: 'Reload', parent_index: 1 },
  { element_index: 3, role: 'entry', label: 'Address and search bar', parent_index: 1 },
  { element_index: 4, role: 'document web', label: 'Probe', parent_index: 1 },
  { element_index: 5, role: 'heading', label: 'Hello', parent_index: 4, in_web_content: true },
  { element_index: 6, role: 'entry', label: 'Name', parent_index: 4, in_web_content: true },
  { element_index: 7, role: 'push button', label: 'Go', parent_index: 4, in_web_content: true },
];
