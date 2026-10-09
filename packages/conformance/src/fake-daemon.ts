import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JsonValue, StepResult } from '@ai-bdd/contracts';
import { AiBddError } from '@ai-bdd/contracts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** Where the kit lives in a checkout, and where it lives in an installed package. */
export function pluginKitDir(): string {
  return join(here, '..', 'plugin');
}

export interface ScriptedRule {
  text?: string;
  [key: string]: unknown;
}

export interface FakeDaemonScript {
  version: 1;
  description?: string;
  responses: Record<string, Array<Record<string, unknown>>>;
}

export function loadScript(path?: string): FakeDaemonScript {
  const file = path ?? join(pluginKitDir(), 'script.json');
  return JSON.parse(readFileSync(file, 'utf8')) as FakeDaemonScript;
}

/**
 * The scripted backend behind `ai-bdd serve --fake`.
 *
 * The plugin conformance kit needs a daemon whose answers are fixed, so that a
 * plugin's mapping from `StepResult` to its own framework statuses is what is
 * under test rather than the resolver, the act loop or the judge. Responses are
 * matched by step text when the scripted entry carries one, otherwise consumed in
 * order, and the last entry repeats.
 */
export class ScriptedBackend {
  readonly calls: Array<{ tool: string; input: unknown; output?: unknown }> = [];
  private readonly script: FakeDaemonScript;
  private readonly cursors = new Map<string, number>();

  constructor(script: FakeDaemonScript = loadScript()) {
    this.script = script;
  }

  private take(tool: string, text?: string): Record<string, unknown> {
    const queue = this.script.responses[tool];
    if (!queue || queue.length === 0) {
      throw new AiBddError('INTERNAL', `script.json has no response for ${tool}`);
    }
    if (text !== undefined) {
      const match = queue.find((entry) => entry.text === text);
      if (match) return match;
    }
    const index = this.cursors.get(tool) ?? 0;
    this.cursors.set(tool, index + 1);
    return queue[Math.min(index, queue.length - 1)]!;
  }

  /**
   * Removes the fields the kit uses only for matching or annotation.
   *
   * `text` is a matching helper on `resolve_step`, but it is part of the
   * `StepResult` payload on `run_step` and `report_binding_result`, so it is kept
   * for those two.
   */
  private strip(entry: Record<string, unknown>, keepText = false): Record<string, unknown> {
    const { text, synthetic: _synthetic, note: _note, ...rest } = entry;
    void _synthetic;
    void _note;
    return keepText ? { text, ...rest } : rest;
  }

  async health(): Promise<JsonValue> {
    const value = this.strip(this.take('health'));
    this.calls.push({ tool: 'health', input: {}, output: value });
    return value as JsonValue;
  }

  async openSession(input: { scenarioId?: string; driver?: string }): Promise<JsonValue> {
    const value = this.strip(this.take('open_session'));
    this.calls.push({ tool: 'open_session', input, output: value });
    return value as JsonValue;
  }

  async registerBindings(input: { bindings?: unknown[] }): Promise<JsonValue> {
    const value = this.strip(this.take('register_bindings'));
    const accepted = Array.isArray(input.bindings) ? input.bindings.length : Number(value.accepted ?? 0);
    const output = { ...value, accepted };
    this.calls.push({ tool: 'register_bindings', input, output });
    return output as JsonValue;
  }

  async resolveStep(input: { step?: { text?: string } }): Promise<JsonValue> {
    const text = input.step?.text;
    const value = this.strip(this.take('resolve_step', text));
    this.calls.push({ tool: 'resolve_step', input, output: value });
    return value as JsonValue;
  }

  async runStep(input: { step?: { text?: string } }): Promise<StepResult> {
    const text = input.step?.text;
    const value = this.strip(this.take('run_step', text), true);
    this.calls.push({ tool: 'run_step', input, output: value });
    return value as unknown as StepResult;
  }

  async reportBindingResult(input: { step?: { text?: string } }): Promise<StepResult> {
    const text = input.step?.text;
    const value = this.strip(this.take('report_binding_result', text), true);
    this.calls.push({ tool: 'report_binding_result', input, output: value });
    return value as unknown as StepResult;
  }

  async closeSession(input: unknown): Promise<JsonValue> {
    const value = this.strip(this.take('close_session'));
    this.calls.push({ tool: 'close_session', input, output: value });
    return value as JsonValue;
  }
}

export function createScriptedBackend(path?: string): ScriptedBackend {
  return new ScriptedBackend(loadScript(path));
}
