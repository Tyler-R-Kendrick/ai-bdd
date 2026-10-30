import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** HTTP protocol fixture for the public T3 0.1.5 MCP contract; it does not call a model. */
export async function nativeT3Fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'studio-t3-native-'));
  const marker = join(dir, 'unsafe-cli-started');
  const script = join(dir, 'cli-must-not-start.mjs');
  await writeFile(
    script,
    `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'started');process.exit(29);`,
  );
  const calls: { name: string; arguments: any; authorization?: string }[] = [];
  const threads: any[] = [];
  const state = {
    callerMode: 'approval-required',
    defaultMode: 'full-access',
    providerModes: ['approval-required', 'full-access'],
    workspaceRoot: dir,
    omitModeSchema: false,
    hold: false,
    pending: 0,
    overrideThread: {} as Record<string, unknown>,
    dropLaunchReply: false,
    nativeWork: [] as string[],
    replyOverride: undefined as string | undefined,
    escalateOnTextChunk: false,
  };
  const properties = {
    projectId: { type: 'string' },
    title: { type: 'string' },
    message: { type: 'string' },
    modelSelection: { type: 'object' },
    runtimeMode: {
      type: 'string',
      enum: ['approval-required', 'auto-accept-edits', 'auto', 'full-access'],
    },
    clientRequestId: { type: 'string' },
  };
  const names = [
    'orchestrator_capabilities',
    't3_project_list',
    't3_project_read',
    't3_thread_launch',
    't3_thread_read',
    't3_thread_interrupt',
  ];
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    let body = '';
    for await (const part of req) body += part;
    const message = JSON.parse(body);
    if (message.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    let result: unknown;
    if (message.method === 'initialize')
      result = {
        protocolVersion: message.params.protocolVersion,
        serverInfo: {
          name: 'explicit-native-t3-contract-fixture',
          version: '0.1.5',
        },
        capabilities: { tools: {} },
      };
    else if (message.method === 'tools/list')
      result = {
        tools: names.map((name) => ({
          name,
          inputSchema: {
            type: 'object',
            properties:
              name === 't3_thread_launch'
                ? state.omitModeSchema
                  ? Object.fromEntries(
                      Object.entries(properties).filter(
                        ([key]) => key !== 'runtimeMode',
                      ),
                    )
                  : properties
                : {},
          },
        })),
      };
    else if (message.method === 'tools/call') {
      const { name, arguments: args } = message.params;
      calls.push({
        name,
        arguments: args,
        authorization: req.headers.authorization,
      });
      let value: unknown;
      if (name === 'orchestrator_capabilities')
        value = {
          runtimeMode: state.callerMode,
          providers: [
            {
              providerInstanceId: 'codex-fixture',
              driverKind: 'codex',
              models: [{ id: 'fixture-model' }],
              runtimeModes: state.providerModes,
            },
          ],
        };
      else if (name === 't3_project_list')
        value = {
          projects: [
            {
              id: 'project-fixture',
              title: 'Registered project',
              workspaceRoot: state.workspaceRoot,
            },
          ],
          nextCursor: null,
        };
      else if (name === 't3_project_read')
        value = { id: 'project-fixture', workspaceRoot: state.workspaceRoot };
      else if (name === 't3_thread_launch') {
        let thread = threads.find(
          (t) => t.clientRequestId === args.clientRequestId,
        );
        if (!thread) {
          const prompt = JSON.parse(args.message),
            tools = prompt.tools ?? [],
            hasResult = prompt.messages.some((m: any) => m.role === 'tool');
          const reply =
            tools.length && !hasResult
              ? JSON.stringify({
                  type: 'tool_calls',
                  calls: [
                    { name: tools[0].name, input: { path: 'README.md' } },
                  ],
                })
              : prompt.responseFormat.type === 'json'
                ? JSON.stringify({ summary: 'T3 structured result' })
                : JSON.stringify({
                    type: 'final',
                    text: hasResult
                      ? 'T3 used the verified server tool.'
                      : 'T3 native MCP model result.',
                  });
          thread = {
            threadId: randomUUID(),
            latestRunId: randomUUID(),
            projectId: args.projectId,
            title: args.title,
            providerInstanceId: args.modelSelection.instanceId,
            model: args.modelSelection.model,
            runtimeMode: args.runtimeMode ?? state.defaultMode,
            clientRequestId: args.clientRequestId,
            reply: state.replyOverride ?? reply,
          };
          threads.push(thread);
          state.nativeWork.push(thread.runtimeMode);
        }
        value = {
          threadId: thread.threadId,
          projectId: thread.projectId,
          modelSelection: {
            instanceId: thread.providerInstanceId,
            model: thread.model,
          },
          runId: thread.latestRunId,
          status: 'completed',
        };
        if (state.dropLaunchReply) {
          state.dropLaunchReply = false;
          req.socket.destroy();
          return;
        }
      } else if (name === 't3_thread_read') {
        const thread = threads.find((t) => t.threadId === args.threadId);
        const offset = args.textOffset ?? 0;
        const text = thread.reply.slice(offset, offset + 50000);
        const truncated = offset + text.length < thread.reply.length;
        value = {
          thread: {
            ...thread,
            status: state.hold ? 'running' : 'completed',
            activeRunId: state.hold ? thread.latestRunId : null,
            pendingRequestCount: state.pending,
            ...state.overrideThread,
            ...(state.escalateOnTextChunk && offset > 0
              ? { runtimeMode: 'full-access' }
              : {}),
          },
          recentRuns: [],
          items: state.hold
            ? []
            : [
                {
                  position: 0,
                  sourceThreadId: thread.threadId,
                  itemId: 'assistant-result',
                  type: 'assistant_message',
                  runId: thread.latestRunId,
                  text,
                  textTruncated: truncated,
                  nextTextOffset: truncated ? offset + text.length : null,
                },
              ],
          nextPosition: null,
          hasMore: false,
        };
      } else if (name === 't3_thread_interrupt')
        value = {
          threadId: args.threadId,
          runId: args.runId,
          status: 'interrupt_requested',
        };
      else throw new Error('Unexpected native tool: ' + name);
      result = { content: [], structuredContent: value };
    } else throw new Error('Unexpected MCP method: ' + message.method);
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    config: {
      command: process.execPath,
      args: [script],
      project: dir,
      providers: [
        {
          id: 'codex-fixture',
          label: 'Explicit native T3 contract fixture',
          models: ['fixture-model'],
        },
      ],
      mcp: {
        url: `http://127.0.0.1:${(server.address() as any).port}/mcp`,
        accessToken: 'synthetic-approved-supervised-client',
      },
    },
    calls,
    threads,
    state,
    cliStarted: async () => !!(await readFile(marker).catch(() => undefined)),
    close: async () => {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
      await rm(dir, { recursive: true, force: true });
    },
  };
}
