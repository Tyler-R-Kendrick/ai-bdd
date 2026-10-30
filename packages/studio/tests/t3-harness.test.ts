import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateText, Output, tool } from 'ai';
import { z } from 'zod';
import { Store } from '../server/store.ts';
import { Collaboration } from '../server/collaboration.ts';
import { DurableJobCoordinator } from '../server/runtime/jobs.ts';
import { Agent } from '../server/agent.ts';
import { t3LanguageModel } from '../server/integrations/t3-model.ts';
import { AgentProfiles } from '../server/integrations/agent-profiles.ts';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function executable() {
  const dir = await mkdtemp(join(tmpdir(), 'studio-t3-public-cli-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const script = join(dir, 'explicit-t3-thread-protocol.mjs'),
    state = join(dir, 'thread-state.json');
  await writeFile(state, JSON.stringify({ threads: [], calls: [] }));
  await writeFile(
    script,
    `
 import{readFile,writeFile,rename}from'node:fs/promises';import{randomUUID}from'node:crypto';
 const[file,...args]=process.argv.slice(2),state=JSON.parse(await readFile(file,'utf8'));
 if(Object.keys(process.env).some(key=>key.startsWith('STUDIO_')))process.exit(24);
 state.calls.push(args);const print=value=>process.stdout.write(JSON.stringify(value)+'\\n');
 if(args[0]!=='thread')process.exit(25);
 if(args[1]==='list')print(state.threads.map(t=>({threadId:t.threadId,title:t.title,latestRunId:t.runId})));
 if(args[1]==='start') {
  if(args[2]!==process.cwd()||args[3]!=='-')process.exit(26);
  let input='';for await(const part of process.stdin)input+=part;const prompt=JSON.parse(input);
  const tools=prompt.tools??[],hasResult=prompt.messages.some(m=>m.role==='tool');
  const reply=tools.length&&!hasResult?JSON.stringify({type:'tool_calls',calls:[{name:tools[0].name,input:{path:'README.md'}}]}):prompt.responseFormat.type==='json'?JSON.stringify({summary:'T3 structured result'}):JSON.stringify({type:'final',text:hasResult?'T3 used the verified server tool.':'T3 public CLI model result.'});
  const thread={threadId:randomUUID(),runId:randomUUID(),title:args[args.indexOf('--title')+1],reply};state.threads.push(thread);print({threadId:thread.threadId,runId:thread.runId});
 }
 if(args[1]==='show') {const t=state.threads.find(t=>t.threadId===args[2]);print({thread:{threadId:t.threadId,status:state.hold?'running':'completed',latestRunId:t.runId,pendingRequestCount:0},messages:state.hold?[]:[{role:'assistant',runId:t.runId,text:t.reply}]});}
 await writeFile(file+'.next',JSON.stringify(state));await rename(file+'.next',file);
 `,
  );
  return {
    config: {
      command: process.execPath,
      args: [script, state],
      project: dir,
      providers: [
        {
          id: 'codex-fixture',
          label: 'Explicit T3 provider protocol fixture',
          models: ['fixture-model'],
        },
      ],
    },
    state: async () => JSON.parse(await readFile(state, 'utf8')),
    hold: async () => {
      const value = JSON.parse(await readFile(state, 'utf8'));
      value.hold = true;
      await writeFile(state, JSON.stringify(value));
    },
  };
}
const fx = {
  harness: 'vercel-fx',
  provider: 'ai-gateway',
  model: 'fixture/model',
} as const;
const t3 = {
  harness: 't3-code',
  provider: 'codex-fixture',
  model: 'fixture-model',
} as const;
async function workspace(integrations: any = {}) {
  const store = await Store.open(':memory:');
  cleanup.push(() => store.close());
  const settings: any = {
    production: false,
    origin: 'http://127.0.0.1:8787',
    dataDir: '/tmp/t3-harness-fixture',
    demo: false,
    model: 'fixture/model',
    integrations,
  };
  const collab = new Collaboration(store, { settings } as any);
  await collab.initialize();
  cleanup.push(() => collab.close());
  const runtime = new DurableJobCoordinator({
    store,
    dispatcher: {
      provider: 'explicit-delivery',
      publish: async () => ({ provider: 'explicit-delivery' }),
    },
  });
  await runtime.ready;
  cleanup.push(() => runtime.close());
  const agent = new Agent(store, settings, collab, { runtime });
  await agent.initialize();
  const user = await store.createUser(
      't3@test.invalid',
      'T3 profile owner',
      null,
    ),
    project = await store.createProject(user, 'Harness selection', ''),
    artifact = await store.artifact(project.mainArtifactId, user.id),
    threadId = (await store.threads(artifact.id))[0]!.id;
  return {
    store,
    settings,
    collab,
    runtime,
    agent,
    user,
    project,
    artifact,
    threadId,
  };
}
describe('actual AI SDK orchestration through the public T3 Code CLI protocol', () => {
  it('defaults to T3 and fails visibly when unconfigured instead of calling an available FX model', async () => {
    const w = await workspace(),
      view = await w.agent.profiles.view(w.user, w.artifact.id);
    expect(view.profile).toEqual({
      harness: 't3-code',
      provider: 'project-default',
      model: 'project-default',
    });
    expect(view.harnesses[0]?.configured).toBe(false);
    expect(view.requiresExplicitFallback).toBe(true);
    await expect(
      w.agent.respond(w.user, w.artifact.id, w.threadId, 'chat'),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(
      (await w.store.one('SELECT count(*) AS n FROM studio_durable_jobs')).n,
    ).toBe(0);
    await w.agent.profiles.view(w.user, w.artifact.id, fx);
    expect(await w.agent.captureProfile(w.user, w.artifact.id)).toEqual(fx);
    const reloaded = new AgentProfiles(
      w.store,
      w.settings,
      w.agent.integrations,
    );
    expect((await reloaded.view(w.user, w.artifact.id)).profile).toEqual(fx);
  });
  it('passes provider/model independently to a real child process and recovers a stable completed thread on repeated SDK generation', async () => {
    const x = await executable(),
      model = t3LanguageModel(x.config, t3, 'stable-cli-request');
    expect(
      (
        await generateText({
          model,
          prompt: 'Explain the frozen artifact.',
          maxRetries: 0,
        })
      ).text,
    ).toBe('T3 public CLI model result.');
    expect(
      (
        await generateText({
          model,
          prompt: 'Explain the frozen artifact.',
          maxRetries: 0,
        })
      ).text,
    ).toBe('T3 public CLI model result.');
    const state = await x.state();
    expect(state.threads).toHaveLength(1);
    const start = state.calls.find((args: string[]) => args[1] === 'start');
    expect(start).toContain('--provider');
    expect(start).toContain('codex-fixture');
    expect(start).toContain('--model');
    expect(start).toContain('fixture-model');
  });
  it('uses normal AI SDK tool execution and structured output validation with T3-backed responses', async () => {
    const x = await executable();
    let reads = 0;
    const result = await generateText({
      model: t3LanguageModel(x.config, t3, 'sdk-tools'),
      prompt: 'Read the repository file through the advertised server tool.',
      tools: {
        repository_file: tool({
          description: 'Verified server repository file read.',
          inputSchema: z.object({ path: z.string() }).strict(),
          execute: async ({ path }) => {
            reads++;
            return { path, text: 'Verified repository read.' };
          },
        }),
      },
      stopWhen: ({ steps }) => steps.length >= 2,
      maxRetries: 0,
    });
    expect(reads).toBe(1);
    expect(result.text).toBe('T3 used the verified server tool.');
    const structured = await generateText({
      model: t3LanguageModel(x.config, t3, 'sdk-output'),
      prompt: 'Return the requested structured response.',
      output: Output.object({
        schema: z.object({ summary: z.string() }).strict(),
      }),
      maxRetries: 0,
    });
    expect(structured.output).toEqual({ summary: 'T3 structured result' });
  });
  it('freezes the selected T3 harness before queue delivery even when the artifact later selects FX', async () => {
    const x = await executable(),
      w = await workspace({ t3: x.config });
    await w.agent.profiles.view(w.user, w.artifact.id, t3);
    const captured = await w.agent.captureProfile(w.user, w.artifact.id),
      job = await w.agent.respond(w.user, w.artifact.id, w.threadId, 'chat');
    await w.agent.profiles.view(w.user, w.artifact.id, fx);
    await w.runtime.executeJob(job.id, {
      messageId: 'frozen-t3-profile',
      deliveryCount: 1,
    });
    expect((await w.runtime.get(job.id))?.snapshot).toMatchObject({
      profile: captured,
    });
    expect((await w.runtime.get(job.id))?.status).toBe('completed');
    expect((await w.store.messages(w.artifact.id)).at(-1)?.body).toBe(
      'T3 public CLI model result.',
    );
    expect((await x.state()).threads).toHaveLength(1);
  });
  it('rejects viewer profile writes and unsupported provider/model combinations', async () => {
    const w = await workspace(),
      viewer = await w.store.createUser(
        'viewer-t3@test.invalid',
        'Viewer',
        null,
      );
    await w.store.exec(
      'INSERT INTO memberships VALUES(?,?,?)',
      w.project.id,
      viewer.id,
      'viewer',
    );
    await expect(
      w.agent.profiles.view(viewer, w.artifact.id, fx),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      w.agent.profiles.view(w.user, w.artifact.id, {
        ...fx,
        model: 'unregistered/model',
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
  it('requests the actual advertised T3 MCP interrupt operation when a running SDK call is aborted', async () => {
    const requests: any[] = [];
    const server = createServer(async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end();
        return;
      }
      let body = '';
      for await (const part of req) body += part;
      const message = JSON.parse(body);
      requests.push({ message, authorization: req.headers.authorization });
      if (message.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      const result =
        message.method === 'initialize'
          ? {
              protocolVersion: message.params.protocolVersion,
              serverInfo: {
                name: 'explicit-t3-mcp-protocol-fixture',
                version: '1.0.0',
              },
              capabilities: { tools: {} },
            }
          : message.method === 'tools/list'
            ? {
                tools: [
                  {
                    name: 't3_thread_interrupt',
                    inputSchema: {
                      type: 'object',
                      properties: {
                        threadId: { type: 'string' },
                        runId: { type: 'string' },
                        reason: { type: 'string' },
                      },
                      required: ['threadId'],
                    },
                  },
                ],
              }
            : { content: [{ type: 'text', text: '{"accepted":true}' }] };
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    const x = await executable();
    await x.hold();
    const controller = new AbortController();
    const generation = generateText({
      model: t3LanguageModel(
        {
          ...x.config,
          mcp: {
            url: `http://127.0.0.1:${(server.address() as any).port}/mcp`,
            accessToken: 'explicit-approved-oauth-token',
          },
        },
        t3,
        'cancelled-cli-request',
      ),
      prompt: 'A bounded running T3 request.',
      abortSignal: controller.signal,
      maxRetries: 0,
    });
    const settled = generation.then(
      () => ({ ok: true }),
      () => ({ ok: false }),
    );
    const deadline = Date.now() + 3000;
    while (
      !(await x.state()).calls.some((args: string[]) => args[1] === 'show')
    ) {
      if (Date.now() > deadline)
        throw new Error('T3 cancellation fixture did not launch');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    controller.abort();
    expect(await settled).toEqual({ ok: false });
    const interrupted = requests.find(
      (value) => value.message.method === 'tools/call',
    );
    expect(interrupted.authorization).toBe(
      'Bearer explicit-approved-oauth-token',
    );
    expect(interrupted.message.params.name).toBe('t3_thread_interrupt');
    expect(interrupted.message.params.arguments.threadId).toBe(
      (await x.state()).threads[0].threadId,
    );
  });
});
