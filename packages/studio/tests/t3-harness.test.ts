import { afterEach, describe, expect, it } from 'vitest';
import { generateText, Output, tool } from 'ai';
import { z } from 'zod';
import { Store } from '../server/store.ts';
import { Collaboration } from '../server/collaboration.ts';
import { DurableJobCoordinator } from '../server/runtime/jobs.ts';
import { Agent } from '../server/agent.ts';
import { t3LanguageModel } from '../server/integrations/t3-model.ts';
import { AgentProfiles } from '../server/integrations/agent-profiles.ts';
import { nativeT3Fixture } from './t3-native-fixture.ts';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function executable() {
  const x = await nativeT3Fixture();
  cleanup.push(x.close);
  return x;
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
describe('actual AI SDK orchestration through the public T3 Code native MCP protocol', () => {
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
  it('passes provider/model independently to native T3 and recovers its idempotent completed thread on repeated SDK generation', async () => {
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
    ).toBe('T3 native MCP model result.');
    expect(
      (
        await generateText({
          model,
          prompt: 'Explain the frozen artifact.',
          maxRetries: 0,
        })
      ).text,
    ).toBe('T3 native MCP model result.');
    expect(x.threads).toHaveLength(1);
    const start = x.calls.find((call) => call.name === 't3_thread_launch');
    expect(start?.arguments.modelSelection).toEqual({
      instanceId: 'codex-fixture',
      model: 'fixture-model',
    });
    expect(start?.arguments.runtimeMode).toBe('approval-required');
    expect(await x.cliStarted()).toBe(false);
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
      'T3 native MCP model result.',
    );
    expect(x.threads).toHaveLength(1);
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
  it('keeps a legacy CLI-only T3 registration visibly offline and requires an explicit FX choice', async () => {
    const x = await executable(),
      { mcp: _mcp, ...legacy } = x.config;
    const w = await workspace({ t3: legacy });
    const view = await w.agent.profiles.view(w.user, w.artifact.id);
    expect(view.profile.harness).toBe('t3-code');
    expect(view.harnesses[0]).toMatchObject({
      configured: false,
      reason: expect.stringContaining('CLI-only generation is disabled'),
    });
    await expect(
      w.agent.respond(w.user, w.artifact.id, w.threadId, 'chat'),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(await x.cliStarted()).toBe(false);
    expect(x.state.nativeWork).toEqual([]);
  });
  it('requests the native T3 interrupt operation for the exact running thread and run when the SDK call is aborted', async () => {
    const x = await executable();
    x.state.hold = true;
    const controller = new AbortController();
    const generation = generateText({
      model: t3LanguageModel(x.config, t3, 'cancelled-native-request'),
      prompt: 'A bounded running T3 request.',
      abortSignal: controller.signal,
      maxRetries: 0,
    });
    const settled = generation.then(
      () => ({ ok: true }),
      () => ({ ok: false }),
    );
    const deadline = Date.now() + 3000;
    while (!x.calls.some((call) => call.name === 't3_thread_read')) {
      if (Date.now() > deadline)
        throw new Error('T3 cancellation fixture did not launch');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    controller.abort();
    expect(await settled).toEqual({ ok: false });
    const interrupted = x.calls.find(
      (call) => call.name === 't3_thread_interrupt',
    );
    expect(interrupted?.authorization).toBe(
      'Bearer synthetic-approved-supervised-client',
    );
    expect(interrupted?.arguments).toMatchObject({
      threadId: x.threads[0].threadId,
      runId: x.threads[0].latestRunId,
    });
    expect(x.calls.every((call) => !call.name.includes('respond'))).toBe(true);
  });
});
