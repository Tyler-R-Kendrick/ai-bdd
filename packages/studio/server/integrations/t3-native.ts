import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { isAbsolute, normalize } from 'node:path';
import { z } from 'zod';
import type { AgentProfile } from '../../shared/agent-profile.ts';
import { HttpError } from '../http-error.ts';
import type { IntegrationSettings } from './settings.ts';

type Config = NonNullable<IntegrationSettings['t3']>;
export type NativeT3GuardStage = 'configuration' | 'mcp-transport' | 'mcp-connect' | 'tools-list' | 'launch-schema' | 'capabilities' | 'provider-selection' | 'project-list' | 'project-selection' | 'project-read';
export type NativeT3GuardReason = 'auth-missing' | 'provider-unregistered' | 'origin-mismatch' | 'http-status' | 'response-budget' | 'operation-failed' | 'missing-tools' | 'launch-contract' | 'tool-request-failed' | 'tool-rejected' | 'response-schema' | 'caller-ceiling' | 'provider-missing' | 'model-missing' | 'provider-mode' | 'pagination-budget' | 'pagination-order' | 'project-missing' | 'project-ambiguous' | 'project-mismatch';
export type NativeT3GuardEvent = Readonly<{ stage: NativeT3GuardStage; state: 'start' | 'complete' | 'failure'; reason?: NativeT3GuardReason; status?: number }>;
export type NativeT3GuardObserver = (event: NativeT3GuardEvent) => void | Promise<void>;
function observeGuard(observer: NativeT3GuardObserver | undefined, event: NativeT3GuardEvent) {
  try { void Promise.resolve(observer?.(Object.freeze(event))).catch(() => {}); }
  catch { /* Logging cannot change native permission admission. */ }
}

const id = z.string().min(1).max(200);
const mode = 'approval-required';
const modelSelection = z.object({ instanceId: id, model: id });
const project = z.object({ id, workspaceRoot: z.string().min(1).max(4000) });
const projectPage = z.object({
  projects: z.array(project).max(100),
  nextCursor: z.number().int().min(0).nullable(),
});
const thread = z.object({
  threadId: id,
  projectId: id,
  providerInstanceId: id,
  model: id,
  runtimeMode: z.string(),
  status: z.string(),
  latestRunId: id.nullable(),
  activeRunId: id.nullable(),
  pendingRequestCount: z.number().int().min(0),
});
const read = z.object({
  thread,
  items: z
    .array(
      z.object({
        itemId: id,
        sourceThreadId: id,
        runId: id.nullable(),
        type: z.string(),
        text: z.string().max(200000).nullable(),
        textTruncated: z.boolean(),
        nextTextOffset: z.number().int().min(0).nullable().optional(),
      }),
    )
    .max(100),
  hasMore: z.boolean(),
  nextPosition: z.number().int().min(0).nullable(),
});
const missing = () =>
  new HttpError(
    503,
    'T3 requires an authenticated native MCP client approved for Supervised access; CLI-only generation is disabled',
  );
const incompatible = () =>
  new HttpError(
    503,
    'T3 native permission, project or provider capabilities could not be verified; no CLI fallback is permitted',
  );
export class NativeT3ProvenanceError extends HttpError {
  constructor() {
    super(
      409,
      'The T3 thread permission, project, provider, model or run no longer matches this request',
    );
  }
}
const changed = () => new NativeT3ProvenanceError();

/** Resolve only local JSON-schema references. Unknown schemas cannot establish a native permission contract. */
function permitsMode(schema: any, root: any, depth = 0): boolean {
  if (!schema || typeof schema !== 'object' || depth > 12) return false;
  if (schema.$ref) {
    if (typeof schema.$ref !== 'string' || !schema.$ref.startsWith('#/'))
      return false;
    const target = schema.$ref
      .slice(2)
      .split('/')
      .reduce(
        (value: any, key: string) =>
          value?.[key.replaceAll('~1', '/').replaceAll('~0', '~')],
        root,
      );
    return permitsMode(target, root, depth + 1);
  }
  return (
    schema.const === mode ||
    (Array.isArray(schema.enum) && schema.enum.includes(mode)) ||
    ['anyOf', 'oneOf'].some(
      (key) =>
        Array.isArray(schema[key]) &&
        schema[key].some((part: unknown) => permitsMode(part, root, depth + 1)),
    )
  );
}

function transport(config: Config, signal: AbortSignal, observer?: NativeT3GuardObserver) {
  if (!config.mcp?.accessToken) throw missing();
  const endpoint = new URL(config.mcp.url);
  let bytes = 0;
  return new StreamableHTTPClientTransport(endpoint, {
    requestInit: {
      headers: { Authorization: 'Bearer ' + config.mcp.accessToken },
    },
    fetch: async (input, init) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
      );
      if (url.origin !== endpoint.origin) { observeGuard(observer, { stage: 'mcp-transport', state: 'failure', reason: 'origin-mismatch' }); throw incompatible(); }
      const response = await fetch(input, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.any([
          signal,
          ...(init?.signal ? [init.signal] : []),
        ]),
      });
      if (!response.ok) observeGuard(observer, { stage: 'mcp-transport', state: 'failure', reason: 'http-status', status: response.status });
      if (!response.body) return response;
      let responseBytes = 0;
      const body = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            bytes += chunk.byteLength;
            responseBytes += chunk.byteLength;
            if (responseBytes > 2 * 1024 * 1024 || bytes > 32 * 1024 * 1024) {
              observeGuard(observer, { stage: 'mcp-transport', state: 'failure', reason: 'response-budget' });
              throw new HttpError(
                502,
                'T3 exceeded its bounded native response budget',
              );
            }
            controller.enqueue(chunk);
          },
        }),
      );
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
  });
}

/** Genuine native T3 MCP, with an approval-required caller ceiling and explicit atomic launch mode. */
export class NativeT3 {
  private readonly client = new Client(
    { name: 'ai-bdd-studio-t3', version: '1.0.0' },
    { capabilities: {} },
  );
  private calls = 0;
  private projectId = '';
  private constructor(
    private readonly config: Config,
    private readonly profile: AgentProfile,
    private readonly signal: AbortSignal,
    private readonly observer?: NativeT3GuardObserver,
  ) {}
  static async connect(
    config: Config,
    profile: AgentProfile,
    signal: AbortSignal,
    observer?: NativeT3GuardObserver,
  ) {
    if (!config.mcp?.accessToken) { observeGuard(observer, { stage: 'configuration', state: 'failure', reason: 'auth-missing' }); throw missing(); }
    if (
      !config.providers.some(
        (p) => p.id === profile.provider && p.models.includes(profile.model),
      )
    ) {
      observeGuard(observer, { stage: 'configuration', state: 'failure', reason: 'provider-unregistered' });
      throw incompatible();
    }
    const native = new NativeT3(config, profile, signal, observer);
    try {
      await native.initialize();
      return native;
    } catch (error) {
      await native.close();
      throw error instanceof HttpError || signal.aborted
        ? error
        : incompatible();
    }
  }
  private async guard<T>(stage: NativeT3GuardStage, work: () => Promise<T>): Promise<T> {
    observeGuard(this.observer, { stage, state: 'start' });
    try { const value = await work(); observeGuard(this.observer, { stage, state: 'complete' }); return value; }
    catch (error) { observeGuard(this.observer, { stage, state: 'failure', reason: 'operation-failed' }); throw error; }
  }
  private reject(stage: NativeT3GuardStage, reason: NativeT3GuardReason): never {
    observeGuard(this.observer, { stage, state: 'failure', reason });
    throw incompatible();
  }
  private async call<S extends z.ZodType>(
    name: string,
    args: Record<string, unknown>,
    schema: S,
    provenance = false,
    admissionStage?: NativeT3GuardStage,
  ): Promise<z.infer<S>> {
    this.signal.throwIfAborted();
    if (++this.calls > 1500)
      throw new HttpError(
        502,
        'T3 exceeded its bounded native operation budget',
      );
    let result;
    try {
      result = await this.client.callTool(
        { name, arguments: args },
        undefined,
        { signal: this.signal, timeout: 15000 },
      );
    } catch (error) {
      if (this.signal.aborted) throw error;
      if (admissionStage) this.reject(admissionStage, 'tool-request-failed');
      throw incompatible();
    }
    if (result.isError) { if (admissionStage) this.reject(admissionStage, 'tool-rejected'); throw incompatible(); }
    const parsed = schema.safeParse(result.structuredContent);
    if (!parsed.success) {
      if (admissionStage) this.reject(admissionStage, admissionStage === 'capabilities' && (result.structuredContent as any)?.runtimeMode !== mode ? 'caller-ceiling' : 'response-schema');
      throw provenance ? changed() : incompatible();
    }
    return parsed.data;
  }
  private async initialize() {
    await this.guard('mcp-connect', () => this.client.connect(transport(this.config, this.signal, this.observer)));
    const tools = await this.guard('tools-list', () => this.client.listTools(undefined, {
      signal: this.signal,
      timeout: 15000,
    }));
    const required = [
      'orchestrator_capabilities',
      't3_project_list',
      't3_project_read',
      't3_thread_launch',
      't3_thread_read',
      't3_thread_interrupt',
    ];
    if (
      !required.every((name) => tools.tools.some((tool) => tool.name === name))
    )
      this.reject('tools-list', 'missing-tools');
    const schema = tools.tools.find(
      (tool) => tool.name === 't3_thread_launch',
    )!.inputSchema;
    if (
      !schema.properties?.clientRequestId ||
      !schema.properties?.projectId ||
      !schema.properties?.modelSelection ||
      !permitsMode(schema.properties?.runtimeMode, schema)
    )
      this.reject('launch-schema', 'launch-contract');
    const capabilities = await this.guard('capabilities', () => this.call(
      'orchestrator_capabilities',
      { search: this.profile.model },
      z.object({
        runtimeMode: z.literal(mode),
        providers: z
          .array(
            z.object({
              providerInstanceId: id,
              driverKind: id,
              models: z.array(z.object({ id })).max(1000),
              // Native T3 omits this optional field for some unrelated or disabled drivers.
              // The selected provider must still explicitly advertise the required mode below.
              runtimeModes: z.array(z.string()).max(10).optional(),
            }),
          )
          .max(100),
      }),
      false,
      'capabilities',
    ));
    if (
      !capabilities.providers.some(
        (p) =>
          p.providerInstanceId === this.profile.provider &&
          p.models.some((m) => m.id === this.profile.model) &&
          p.runtimeModes?.includes(mode),
      )
    ) {
      const registered = capabilities.providers.filter(p => p.providerInstanceId === this.profile.provider);
      this.reject('provider-selection', !registered.length ? 'provider-missing' : !registered.some(p => p.models.some(m => m.id === this.profile.model)) ? 'model-missing' : 'provider-mode');
    }
    let cursor: number | null = 0;
    const matches: z.infer<typeof project>[] = [];
    for (let page = 0; cursor !== null; page++) {
      if (page === 100) this.reject('project-list', 'pagination-budget');
      const current: z.infer<typeof projectPage> = await this.guard('project-list', () => this.call(
        't3_project_list',
        { cursor, limit: 100 },
        projectPage,
        false,
        'project-list',
      ));
      matches.push(
        ...current.projects.filter(
          (p) =>
            isAbsolute(p.workspaceRoot) &&
            normalize(p.workspaceRoot) === normalize(this.config.project),
        ),
      );
      if (current.nextCursor !== null && current.nextCursor <= cursor)
        this.reject('project-list', 'pagination-order');
      cursor = current.nextCursor;
    }
    if (matches.length !== 1) this.reject('project-selection', matches.length === 0 ? 'project-missing' : 'project-ambiguous');
    const selected = await this.guard('project-read', () => this.call(
      't3_project_read',
      { projectId: matches[0]!.id },
      project,
      false,
      'project-read',
    ));
    if (
      selected.id !== matches[0]!.id ||
      !isAbsolute(selected.workspaceRoot) ||
      normalize(selected.workspaceRoot) !== normalize(this.config.project)
    )
      this.reject('project-read', 'project-mismatch');
    this.projectId = selected.id;
  }
  async launch(title: string, prompt: string, clientRequestId: string) {
    const result = await this.call(
      't3_thread_launch',
      {
        projectId: this.projectId,
        title,
        message: prompt,
        clientRequestId,
        modelSelection: {
          instanceId: this.profile.provider,
          model: this.profile.model,
        },
        runtimeMode: mode,
      },
      z.object({
        threadId: id,
        projectId: id,
        modelSelection,
        runId: id,
        status: z.string().nullable(),
      }),
      true,
    );
    if (
      result.projectId !== this.projectId ||
      result.modelSelection.instanceId !== this.profile.provider ||
      result.modelSelection.model !== this.profile.model
    )
      throw changed();
    return result;
  }
  private assertThread(
    value: z.infer<typeof thread>,
    threadId: string,
    runId: string,
  ) {
    if (
      value.threadId !== threadId ||
      value.projectId !== this.projectId ||
      value.runtimeMode !== mode ||
      value.providerInstanceId !== this.profile.provider ||
      value.model !== this.profile.model ||
      value.latestRunId !== runId ||
      (value.activeRunId !== null && value.activeRunId !== runId)
    )
      throw changed();
    if (value.pendingRequestCount)
      throw new HttpError(
        409,
        'T3 Code is waiting for an explicit answer or permission in its application',
      );
  }
  async response(threadId: string, runId: string) {
    let afterPosition: number | undefined,
      latest: z.infer<typeof read> | undefined;
    const items: z.infer<typeof read>['items'] = [];
    for (let page = 0; ; page++) {
      if (page === 20)
        throw new HttpError(502, 'T3 exceeded its bounded timeline');
      latest = await this.call(
        't3_thread_read',
        {
          threadId,
          view: 'messages',
          limit: 100,
          runLimit: 1,
          maxCharsPerItem: 50000,
          ...(afterPosition === undefined ? {} : { afterPosition }),
        },
        read,
        true,
      );
      this.assertThread(latest.thread, threadId, runId);
      items.push(...latest.items);
      if (!latest.hasMore) break;
      if (
        latest.nextPosition === null ||
        latest.nextPosition <= (afterPosition ?? -1)
      )
        throw incompatible();
      afterPosition = latest.nextPosition;
    }
    const reply = items.findLast(
      (item) =>
        item.type === 'assistant_message' &&
        item.runId === runId &&
        item.sourceThreadId === threadId,
    );
    let text = reply?.text ?? undefined;
    if (reply?.textTruncated) {
      const firstOffset = reply.nextTextOffset;
      if (
        text === undefined ||
        firstOffset === undefined ||
        firstOffset === null ||
        firstOffset <= 0
      )
        throw incompatible();
      let offset: number = firstOffset;
      for (let page = 0; ; page++) {
        if (page === 20)
          throw new HttpError(502, 'T3 exceeded its bounded message');
        const chunk: z.infer<typeof read> = await this.call(
          't3_thread_read',
          {
            threadId,
            itemId: reply.itemId,
            textOffset: offset,
            runLimit: 1,
            maxCharsPerItem: 50000,
          },
          read,
          true,
        );
        this.assertThread(chunk.thread, threadId, runId);
        const item = chunk.items.find(
          (item) =>
            item.itemId === reply.itemId &&
            item.runId === runId &&
            item.sourceThreadId === threadId &&
            item.type === 'assistant_message',
        );
        if (!item || item.text === null) throw incompatible();
        text += item.text;
        if (text.length > 200000)
          throw new HttpError(502, 'T3 exceeded its bounded message');
        if (!item.textTruncated) break;
        if (
          item.nextTextOffset === null ||
          item.nextTextOffset === undefined ||
          item.nextTextOffset <= offset
        )
          throw incompatible();
        offset = item.nextTextOffset;
      }
    }
    return { status: latest.thread.status, text };
  }
  async close() {
    await this.client.close().catch(() => {});
  }
}

/** Cancellation uses a fresh bounded connection after the originating signal is aborted. Never answers approvals. */
export async function interruptNativeT3(
  config: Config,
  threadId: string,
  runId: string,
) {
  const signal = AbortSignal.timeout(10000);
  const client = new Client(
    { name: 'ai-bdd-studio-t3', version: '1.0.0' },
    { capabilities: {} },
  );
  try {
    await client.connect(transport(config, signal));
    await client.callTool(
      {
        name: 't3_thread_interrupt',
        arguments: {
          threadId,
          runId,
          reason:
            'The originating Studio job was cancelled or lost its execution lease',
        },
      },
      undefined,
      { signal, timeout: 10000 },
    );
  } catch {
    /* Best effort after a cancelled delivery; no unrelated run is targeted. */
  } finally {
    await client.close().catch(() => {});
  }
}
