import { createRequire } from 'node:module';
import type { StepKind, StepResult, Status } from '@ai-bdd/contracts';
import { DaemonClient, DaemonError } from './client.js';
import { localBindings, type StepFunction } from './registry.js';

export interface RegisterOptions {
  projectRoot?: string;
  url?: string;
  token?: string;
  pluginName?: string;
  pluginVersion?: string;
  /**
   * Coexist mode (section 12): build the catch-all as a negative lookahead over
   * the patterns already registered with Cucumber, so ai-bdd never shadows a
   * native step definition. Without it a catch-all makes cucumber-js report
   * AMBIGUOUS for every native step (verified in cucumber-js source, V9).
   */
  coexist?: boolean;
  /** Injected in tests; production loads `@cucumber/cucumber`. */
  cucumber?: CucumberApi;
  client?: DaemonClient;
  fetchImpl?: typeof fetch;
}

export interface CucumberApi {
  defineStep: (pattern: RegExp, fn: (...args: unknown[]) => unknown) => void;
  Before: (fn: (this: CucumberWorld) => Promise<void>) => void;
  After: (fn: (this: CucumberWorld) => Promise<void>) => void;
  setWorldConstructor?: (ctor: unknown) => void;
}

export interface CucumberWorld {
  aiBdd?: AiBddWorld;
  [key: string]: unknown;
}

export interface AiBddWorld {
  sessionId: string | undefined;
  runStep: (text: string) => Promise<StepResult>;
  assert: (text: string) => Promise<StepResult>;
  invokeLocal: (bindingId: string, params: Record<string, unknown>) => Promise<StepResult>;
}

/** The catch-all pattern, optionally excluding the native step patterns. */
export function catchAllPattern(existingPatterns: string[], coexist = false): RegExp {
  if (!coexist || existingPatterns.length === 0) return /^(.*)$/;
  // The exclusions are regex *bodies*, not quoted literals: a native pattern may be a
  // Cucumber Expression, and quoting it would only exclude that literal text while
  // every sentence it matches still fell through to the catch-all — which makes
  // cucumber-js report AMBIGUOUS for the steps the project already implements
  // (adversarial attack 12, shared with the JVM plugin's coexist mode).
  const bodies = existingPatterns.map((pattern) => patternToRegexBody(pattern));
  return new RegExp(`^(?!(?:${bodies.join('|')})$)(.*)$`, 'u');
}

const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/gu;

/** Turns a Cucumber Expression or an anchored regexp into a regex body. */
export function patternToRegexBody(pattern: string): string {
  const trimmed = pattern.trim();
  if (trimmed.startsWith('^') && trimmed.endsWith('$') && trimmed.length > 1) {
    return trimmed.slice(1, -1);
  }
  let body = '';
  let index = 0;
  PLACEHOLDER.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLACEHOLDER.exec(pattern)) !== null) {
    body += escapeRegExp(pattern.slice(index, match.index));
    body +=
      match[1] === 'int'
        ? '(-?\\d+)'
        : match[1] === 'float'
          ? '(-?\\d+(?:\\.\\d+)?)'
          : match[1] === 'word'
            ? '(\\w+)'
            : '.*?';
    index = match.index + match[0].length;
  }
  body += escapeRegExp(pattern.slice(index));
  return body;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Installs the ai-bdd catch-all, the World mixin and the session hooks.
 *
 * Call it from `register` in your cucumber.js profile:
 *
 * ```ts
 * import { register } from '@ai-bdd/cucumber/register';
 * register();
 * ```
 */
export function register(options: RegisterOptions = {}): AiBddWorld {
  const cucumber = options.cucumber ?? loadCucumber();
  const client = options.client ?? new DaemonClient({
    ...(options.projectRoot !== undefined ? { projectRoot: options.projectRoot } : {}),
    ...(options.url !== undefined ? { url: options.url } : {}),
    ...(options.token !== undefined ? { token: options.token } : {}),
  });
  const plugin = {
    name: options.pluginName ?? '@ai-bdd/cucumber',
    version: options.pluginVersion ?? '0.1.0',
    language: 'typescript',
  };

  const world: AiBddWorld = {
    sessionId: undefined,
    async runStep(text: string): Promise<StepResult> {
      return callStep(client, world, plugin, text, undefined);
    },
    async assert(text: string): Promise<StepResult> {
      return callStep(client, world, plugin, text, 'assertion');
    },
    async invokeLocal(bindingId: string, params: Record<string, unknown>): Promise<StepResult> {
      const fn = localBindings.get(bindingId);
      if (!fn) throw new DaemonError({ code: 'INVALID_ARGUMENT', message: `unknown local binding ${bindingId}` });
      const started = Date.now();
      try {
        await fn(params as never, { world });
        return await client.call<StepResult>('report_binding_result', {
          sessionId: world.sessionId,
          step: { text: String(params.__text ?? ''), kind: 'setup' },
          bindingId,
          status: 'passed',
          durationMs: Date.now() - started,
        });
      } catch (error) {
        return await client.call<StepResult>('report_binding_result', {
          sessionId: world.sessionId,
          step: { text: String(params.__text ?? ''), kind: 'setup' },
          bindingId,
          status: 'failed',
          durationMs: Date.now() - started,
          error: { message: error instanceof Error ? error.message : String(error) },
        });
      }
    },
  };

  cucumber.Before(async function (this: CucumberWorld) {
    this.aiBdd = world;
    const scenarioId = scenarioIdOf(this);
    const opened = await client.call<{ sessionId: string }>('open_session', {
      scenarioId,
      scenarioName: scenarioNameOf(this),
      tags: tagsOf(this),
      plugin,
    });
    world.sessionId = opened.sessionId;
    if (localBindings.publish().length > 0) {
      await client.call('register_bindings', { sessionId: opened.sessionId, provider: 'ts:cucumber', bindings: localBindings.publish() });
    }
  });

  cucumber.After(async function (this: CucumberWorld) {
    if (!world.sessionId) return;
    await client.call('close_session', { sessionId: world.sessionId, status: 'passed' });
    world.sessionId = undefined;
  });

  const existing = options.coexist ? nativePatterns() : [];
  cucumber.defineStep(catchAllPattern(existing, options.coexist === true), async function (this: CucumberWorld, ...args: unknown[]) {
    this.aiBdd = world;
    const text = String(args[0] ?? '');
    const result = await callStep(client, world, plugin, text, undefined);
    if (result.status === 'failed' || result.status === 'ambiguous' || result.status === 'undefined') {
      throw new Error(`${result.error?.code ?? result.status}: ${result.error?.message ?? text}`);
    }
  });

  return world;
}

async function callStep(
  client: DaemonClient,
  world: AiBddWorld,
  plugin: { name: string; version: string; language: string },
  text: string,
  kind: StepKind | undefined,
): Promise<StepResult> {
  if (!world.sessionId) {
    const opened = await client.call<{ sessionId: string }>('open_session', {
      scenarioId: 'generated',
      scenarioName: 'generated',
      tags: [],
      plugin,
    });
    world.sessionId = opened.sessionId;
  }
  const step = { text, ...(kind !== undefined ? { kind } : {}) };
  const resolved = await client.call<{ next: string; resolution: StepResult['resolution']; error?: { code: string; message: string } }>(
    'resolve_step',
    { sessionId: world.sessionId, step },
  );
  if (resolved.next === 'fail') {
    return failureResult(text, resolved);
  }
  const resolution = resolved.resolution;
  if (resolved.next === 'invoke-local' && (resolution.type === 'exact' || resolution.type === 'semantic')) {
    const bindingId = resolution.bindingId;
    const fn = localBindings.get(bindingId);
    if (!fn) {
      return {
        stepId: text,
        text,
        kind: kind ?? 'action',
        kindSource: 'default',
        status: 'undefined',
        resolution: resolved.resolution,
        evidence: [],
        durationMs: 0,
        error: { code: 'UNDEFINED', message: `the plugin has no function for ${bindingId}`, retryable: false },
      };
    }
    const started = Date.now();
    try {
      await fn({ ...resolution.params, __text: text } as never, { world });
      return await client.call<StepResult>('report_binding_result', {
        sessionId: world.sessionId,
        step,
        bindingId,
        status: 'passed',
        durationMs: Date.now() - started,
      });
    } catch (error) {
      return await client.call<StepResult>('report_binding_result', {
        sessionId: world.sessionId,
        step,
        bindingId,
        status: 'failed',
        durationMs: Date.now() - started,
        error: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  }
  return client.call<StepResult>('run_step', { sessionId: world.sessionId, step });
}

function failureResult(
  text: string,
  resolved: { resolution: StepResult['resolution']; error?: { code: string; message: string } },
): StepResult {
  const status: Status = resolved.resolution.type === 'ambiguous' ? 'ambiguous' : 'failed';
  return {
    stepId: text,
    text,
    kind: 'action',
    kindSource: 'default',
    status,
    resolution: resolved.resolution,
    evidence: [],
    durationMs: 0,
    ...(resolved.error !== undefined
      ? { error: { code: resolved.error.code, message: resolved.error.message, retryable: false } }
      : {}),
  };
}

function scenarioIdOf(world: CucumberWorld): string {
  const pickle = world.pickle as { name?: string; uri?: string } | undefined;
  return `${pickle?.uri ?? 'feature'}#${pickle?.name ?? 'scenario'}`;
}

function scenarioNameOf(world: CucumberWorld): string {
  return (world.pickle as { name?: string } | undefined)?.name ?? 'scenario';
}

function tagsOf(world: CucumberWorld): string[] {
  const pickle = world.pickle as { tags?: Array<{ name?: string }> } | undefined;
  return (pickle?.tags ?? []).map((tag) => tag.name ?? '').filter((name) => name.length > 0);
}

function nativePatterns(): string[] {
  try {
    const require = createRequire(import.meta.url);
    const cucumber = require('@cucumber/cucumber') as { supportCodeLibraryBuilder?: { methods?: unknown } };
    const library = (cucumber as unknown as { supportCodeLibraryBuilder?: { methods?: unknown } }).supportCodeLibraryBuilder;
    void library;
  } catch {
    // @cucumber/cucumber is optional for this package
  }
  return [];
}

function loadCucumber(): CucumberApi {
  const require = createRequire(import.meta.url);
  const cucumber = require('@cucumber/cucumber') as Partial<CucumberApi>;
  if (typeof cucumber.defineStep !== 'function') {
    throw new Error('@ai-bdd/cucumber requires @cucumber/cucumber>=9 to be installed');
  }
  return cucumber as CucumberApi;
}

void ({} as StepFunction);
