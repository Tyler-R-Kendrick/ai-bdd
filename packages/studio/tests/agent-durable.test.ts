import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.ts';
import { Collaboration } from '../server/collaboration.ts';
import { DecisionModels } from '../server/decisions/models.ts';
import { decisionProfileSchema } from '../shared/decision-profile.ts';
import { Agent } from '../server/agent.ts';
import { DurableJobCoordinator } from '../server/runtime/jobs.ts';
import { paragraph } from '../shared/domain.ts';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});
const generated = (text: string) => ({
  content: [{ type: 'text', text }],
  finishReason: { unified: 'stop', raw: 'stop' },
  usage: {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
  },
  warnings: [],
});
async function http(
  handler: (path: string, body: any, response: any) => void,
) {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const value = body ? JSON.parse(body) : null;
    requests.push({ path: req.url, body: value, headers: req.headers });
    res.setHeader('Content-Type', 'application/json');
    handler(req.url!, value, res);
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
  return {
    url: `http://127.0.0.1:${(server.address() as any).port}`,
    requests,
  };
}
async function fixture(integrations: any = {}) {
  vi.stubEnv('AI_GATEWAY_API_KEY', 'explicit-protocol-fixture-only');
  const store = await Store.open(':memory:');
  cleanup.push(() => store.close());
  const settings: any = {
    production: false,
    origin: 'http://127.0.0.1:8787',
    dataDir: '/tmp/studio-durable-agent-fixture',
    demo: false,
    model: 'fixture/model',
    integrations,
  };
  // No socket/auth route is used in this test; the actual collaboration persistence/cache path is exercised.
  const collab = new Collaboration(store, { settings } as any);
  await collab.initialize();
  cleanup.push(() => collab.close());
  const dispatcher = {
    provider: 'explicit-job-delivery-fixture',
    publish: async () => ({ provider: 'explicit-job-delivery-fixture' }),
  };
  const runtime = new DurableJobCoordinator({
    store,
    dispatcher,
    leaseMs: 300,
  });
  await runtime.ready;
  cleanup.push(() => runtime.close());
  let locked = false;
  const generatedIds: string[] = [];
  const agent = new Agent(store, settings, collab, {
    runtime,
    implementationLocked: async () => locked,
    onGeneratedArtifact: async (id) => {
      generatedIds.push(id);
    },
  });
  await agent.initialize();
  const user = await store.createUser(
      randomUUID() + '@test.invalid',
      'Durable agent owner',
      null,
    ),
    project = await store.createProject(
      user,
      'Durable artifact planning',
      '',
    );
  const artifact = await store.artifact(project.mainArtifactId, user.id),
    threadId = (await store.threads(artifact.id))[0]!.id;
  await agent.profiles.view(user, artifact.id, {
    harness: 'vercel-fx',
    provider: 'ai-gateway',
    model: 'fixture/model',
  });
  return {
    store,
    settings,
    collab,
    runtime,
    dispatcher,
    agent,
    user,
    project,
    artifact,
    threadId,
    generatedIds,
    setLocked: (value: boolean) => {
      locked = value;
    },
    run: (id: string) =>
      runtime.executeJob(id, { messageId: randomUUID(), deliveryCount: 1 }),
  };
}
function researchAttrs(doc: any): any[] {
  return [
    ...(doc.type === 'researchBlock' ? [doc.attrs] : []),
    ...(doc.content ?? []).flatMap(researchAttrs),
  ];
}
describe('durable artifact agent using actual HTTP model/source transports', () => {
  it('survives service replacement, freezes selected context, and publishes one chat message on redelivery', async () => {
    const gateway = await http((_p, _b, r) =>
      r.end(JSON.stringify(generated('A reviewed rollout needs an ADR.'))),
    );
    const w = await fixture({ gatewayBaseUrl: gateway.url });
    await w.store.message(
      w.user,
      w.artifact.id,
      w.threadId,
      'Original selected context.',
    );
    const other = await w.store.createArtifact(
      w.user,
      w.project.id,
      'document',
      'Unrelated',
    );
    await w.store.message(
      w.user,
      other.id,
      (await w.store.threads(other.id))[0]!.id,
      'Unrelated private conversation.',
    );
    const job = await w.agent.respond(
      w.user,
      w.artifact.id,
      w.threadId,
      'chat',
    );
    expect(await w.agent.isActive(w.artifact.id)).toBe(true);
    expect(gateway.requests).toHaveLength(0);
    await w.store.message(
      w.user,
      w.artifact.id,
      w.threadId,
      'Later message is outside the approved snapshot.',
    );
    await w.runtime.close();
    const resumed = new DurableJobCoordinator({
      store: w.store,
      dispatcher: w.dispatcher,
      leaseMs: 300,
    });
    await resumed.ready;
    cleanup.push(() => resumed.close());
    const agent = new Agent(w.store, w.settings, w.collab, {
      runtime: resumed,
    });
    await agent.initialize();
    await resumed.executeJob(job.id, {
      messageId: 'restart',
      deliveryCount: 2,
    });
    await resumed.executeJob(job.id, {
      messageId: 'duplicate',
      deliveryCount: 3,
    });
    expect(gateway.requests).toHaveLength(1);
    const input = JSON.stringify(gateway.requests[0].body);
    expect(input).toContain('Original selected context');
    expect(input).not.toContain('Unrelated private');
    expect(input).not.toContain('Later message');
    expect(
      (await w.store.messages(w.artifact.id)).filter(
        (m) => m.role === 'assistant',
      ),
    ).toHaveLength(1);
    expect((await agent.jobs(w.user, w.artifact.id))[0]?.status).toBe(
      'completed',
    );
  });
  it('atomically starts exact reviewed research and reuses the same request after the inline card changes the source version', async () => {
    const gateway = await http((_p, _b, r) =>
      r.end(JSON.stringify(generated('Source-backed finding [1].'))),
    );
    const source = await http((_p, _b, r) =>
      r.end(
        JSON.stringify({
          sources: [
            {
              title: 'Public contract guide',
              url: 'https://example.org/contract',
              excerpt: 'A retrieved contract excerpt.',
            },
          ],
        }),
      ),
    );
    const w = await fixture({
      gatewayBaseUrl: gateway.url,
      searchUrl: source.url,
    });
    const input = {
      user: w.user,
      artifactId: w.artifact.id,
      threadId: w.threadId,
      brief: 'Assess this exact contract boundary.',
      artifactVersion: w.artifact.version,
      idempotencyKey: 'reviewed-card-1',
    };
    const job = await w.agent.startResearch(input);
    expect(await w.agent.startResearch(input)).toEqual(job);
    await expect(
      w.agent.startResearch({ ...input, brief: 'Changed approved brief.' }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(
      researchAttrs(
        (await w.store.artifact(w.artifact.id, w.user.id)).content.doc,
      ),
    ).toMatchObject([
      { requestId: job.id, status: 'running', brief: input.brief },
    ]);
    const latest = await w.store.artifact(w.artifact.id, w.user.id);
    await w.collab.replace(
      w.artifact.id,
      w.user,
      {
        doc: {
          ...latest.content.doc,
          content: [
            ...latest.content.doc.content,
            paragraph('Human edit while research runs.'),
          ],
        },
      },
      latest.version,
    );
    await w.run(job.id);
    await w.run(job.id);
    expect(source.requests).toHaveLength(1);
    expect(source.requests[0].body).toEqual({ query: input.brief, limit: 8 });
    const state = await w.store.artifact(w.artifact.id, w.user.id),
      jobs = await w.agent.jobs(w.user, w.artifact.id);
    expect(JSON.stringify(state.content)).toContain(
      'Human edit while research runs',
    );
    expect(researchAttrs(state.content.doc)[0]).toMatchObject({
      status: 'complete',
      artifactId: jobs[0]!.childArtifactId,
    });
    expect(w.generatedIds).toEqual([jobs[0]!.childArtifactId]);
    const child = await w.store.artifact(
      jobs[0]!.childArtifactId!,
      w.user.id,
    );
    expect(JSON.stringify(child.content)).toContain('excerpt SHA-256');
    expect(await w.store.threads(child.id)).toHaveLength(1);
    expect(
      (
        await w.store.one(
          'SELECT count(*) AS n FROM studio_job_receipts WHERE job_id=? AND phase=?',
          job.id,
          'publication',
        )
      ).n,
    ).toBe(1);
  });
  it('rolls back the inline card and durable intent together if the enclosing publication fails', async () => {
    const w = await fixture();
    // Exercise the same Store transaction composition used by conversation approval.
    await expect(
      w.store.tx(async () => {
        await w.agent.startResearch({
          user: w.user,
          artifactId: w.artifact.id,
          threadId: w.threadId,
          brief: 'Rollback exact request.',
          artifactVersion: 1,
          idempotencyKey: 'rollback',
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(
      (await w.store.one('SELECT count(*) AS n FROM studio_durable_jobs')).n,
    ).toBe(0);
    expect(
      researchAttrs(
        (await w.store.artifact(w.artifact.id, w.user.id)).content.doc,
      ),
    ).toEqual([]);
  });
  it('shared pause cancels an in-flight HTTP source retrieval and publishes no child', async () => {
    let requested!: () => void;
    const started = new Promise<void>((resolve) => (requested = resolve));
    const source = await http(() => requested());
    const w = await fixture({ searchUrl: source.url });
    const job = await w.agent.respond(
      w.user,
      w.artifact.id,
      w.threadId,
      'research',
      'An exact cancellable brief.',
    );
    const running = w.run(job.id);
    await started;
    await w.agent.policy(w.user, w.artifact.id, {
      mode: 'automatic',
      paused: true,
    });
    await running;
    expect((await w.runtime.get(job.id))?.status).toBe('cancelled');
    expect(
      researchAttrs(
        (await w.store.artifact(w.artifact.id, w.user.id)).content.doc,
      )[0]?.status,
    ).toBe('cancelled');
    expect(
      (await w.agent.jobs(w.user, w.artifact.id))[0]?.childArtifactId,
    ).toBeNull();
  });
  it('enforces shared owner and implementation guards, and protects final publication after a lock appears', async () => {
    let release!: () => void, started!: () => void;
    const waiting = new Promise<void>((resolve) => (started = resolve)),
      gate = new Promise<void>((resolve) => (release = resolve));
    const gateway = await http(async (_p, _b, r) => {
      started();
      await gate;
      r.end(JSON.stringify(generated('Stale lock output.')));
    });
    const w = await fixture({ gatewayBaseUrl: gateway.url }),
      job = await w.agent.respond(w.user, w.artifact.id, w.threadId, 'chat');
    const second = await w.store.createUser(
      'other-' + randomUUID() + '@test.invalid',
      'Other writer',
      null,
    );
    await w.store.exec(
      'INSERT INTO memberships VALUES(?,?,?)',
      w.project.id,
      second.id,
      'editor',
    );
    await expect(
      w.agent.respond(second, w.artifact.id, w.threadId, 'chat'),
    ).rejects.toMatchObject({ statusCode: 409 });
    const running = w.run(job.id);
    await waiting;
    w.setLocked(true);
    release();
    await running;
    expect((await w.runtime.get(job.id))?.status).toBe('failed');
    expect(
      (await w.store.messages(w.artifact.id)).filter(
        (m) => m.role === 'assistant',
      ),
    ).toHaveLength(0);
    expect(await w.agent.canParticipate(w.user, w.artifact.id)).toBe(false);
  });
  it('schedules automatic turns durably and supersedes stale queued triggers without a process timer', async () => {
    const gateway = await http((_p, _b, r) =>
      r.end(JSON.stringify(generated('Latest conversation reply.'))),
    );
    const w = await fixture({ gatewayBaseUrl: gateway.url });
    await w.agent.policy(w.user, w.artifact.id, {
      mode: 'automatic',
      paused: false,
    });
    await w.store.message(
      w.user,
      w.artifact.id,
      w.threadId,
      'First discussion.',
    );
    await w.agent.observeMessage(
      w.user,
      w.artifact.id,
      w.threadId,
      'First discussion.',
    );
    const first = (await w.agent.jobs(w.user, w.artifact.id))[0]!;
    await w.store.message(
      w.user,
      w.artifact.id,
      w.threadId,
      '@studio Latest explicit request.',
    );
    await w.agent.observeMessage(
      w.user,
      w.artifact.id,
      w.threadId,
      '@studio Latest explicit request.',
    );
    const second = (await w.agent.jobs(w.user, w.artifact.id)).find(
      (j) => j.id !== first.id,
    )!;
    expect((await w.runtime.get(first.id))?.status).toBe('cancelled');
    await w.run(second.id);
    expect(gateway.requests).toHaveLength(1);
    expect((await w.runtime.get(second.id))?.status).toBe('completed');
  });
  it('observes title maintenance in manual mode and rejects a mismatched Store runtime', async () => {
    const w = await fixture(),
      observe = vi.fn(async () => {});
    w.agent.options.observeMessage = observe;
    await w.agent.observeMessage(
      w.user,
      w.artifact.id,
      w.threadId,
      'Manual conversation.',
    );
    expect(observe).toHaveBeenCalledOnce();
    expect(await w.agent.isActive(w.artifact.id)).toBe(false);
    const other = await Store.open(':memory:');
    cleanup.push(() => other.close());
    expect(
      () => new Agent(other, w.settings, w.collab, { runtime: w.runtime }),
    ).toThrow('same Store');
  });
  it('routes one paragraph through isolated visual decisions and creates a reviewed source-bound proposal', async () => {
    let calls = 0;
    const responses = [
      {
        title: 'Contract boundary',
        description: 'Proposed architecture from the paragraph.',
        nodes: [
          { id: 'consumer', label: 'Consumer', x: 20, y: 100 },
          { id: 'provider', label: 'Provider', x: 400, y: 100 },
        ],
        edges: [
          { from: 'consumer', to: 'provider', label: 'verified contract' },
        ],
      },
    ];
    const gateway = await http((_p, _b, r) =>
      r.end(JSON.stringify(generated(JSON.stringify(responses[calls++])))),
    );
    const w = await fixture({
      gatewayBaseUrl: gateway.url,
      plannerVisuals: true,
    });
    const native = await http((_path, body, res) =>
      res.end(
        JSON.stringify({
          model: body.model,
          answers: body.questions.map((q: any) =>
            q.type === 'choice'
              ? {
                  name: q.name,
                  type: 'choice',
                  choice: 'diagramBlock',
                  confidence: 0.95,
                  probabilities: q.choices.map((choice: any) => ({
                    value: choice.value,
                    probability:
                      choice.value === 'diagramBlock' ? 0.94 : 0.02,
                  })),
                }
              : { name: q.name, type: 'predicate', probability: 0.95 },
          ),
          usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
        }),
      ),
    );
    const decisions = new DecisionModels({
      store: w.store,
      settings: {
        production: false,
        timeoutMs: 3000,
        defaultProfile: decisionProfileSchema.parse({
          provider: 'openai-decisions',
          model: 'gpt-6-luna',
        }),
        openai: {
          baseUrl: native.url + '/v1',
          apiKey: 'explicit-native-visual-fixture',
          models: ['gpt-6-luna'],
        },
      },
    });
    await decisions.ready;
    cleanup.push(() => decisions.close());
    w.agent.options.decisions = decisions;
    await w.collab.replace(
      w.artifact.id,
      w.user,
      {
        doc: {
          type: 'doc',
          content: [
            paragraph(
              'The Consumer reads the Provider through a verified contract boundary, allowing its live preview to run independently.',
            ),
          ],
        },
      },
      w.artifact.version,
    );
    await w.store.message(
      w.user,
      w.artifact.id,
      w.threadId,
      'Explain this integration relationship visually.',
    );
    const original = await w.store.artifact(w.artifact.id, w.user.id),
      job = await w.agent.respond(w.user, w.artifact.id, w.threadId, 'chat');
    await decisions.profile(
      w.user,
      w.artifact.id,
      decisionProfileSchema.parse({ provider: 'jev', model: 'jev-latest' }),
    );
    await w.run(job.id);
    await w.run(job.id);
    expect(calls).toBe(1);
    expect(native.requests).toHaveLength(3);
    expect(
      native.requests.every((request) => request.body.model === 'gpt-6-luna'),
    ).toBe(true);
    expect(
      native.requests.map((request) => request.body.questions[0].type),
    ).toEqual(['predicate', 'predicate', 'choice']);
    expect(
      native.requests.every(
        (request) => !JSON.stringify(request.body).includes('decisions'),
      ),
    ).toBe(true);
    expect(JSON.stringify(gateway.requests[0].body)).not.toContain(
      'decisions',
    );
    const assistant = (await w.store.messages(w.artifact.id)).find(
      (m) => m.role === 'assistant',
    )!;
    expect(assistant.proposal).toMatchObject({
      version: original.version,
      visual: { kind: 'diagramBlock' },
    });
    expect(assistant.proposal!.content.doc.content[1].type).toBe(
      'diagramBlock',
    );
    expect(
      (await w.store.artifact(w.artifact.id, w.user.id)).content,
    ).toEqual(original.content);
    expect(
      (
        await w.store.all(
          "SELECT name FROM studio_job_receipts WHERE job_id=? AND phase='step'",
          job.id,
        )
      ).map((x) => x.name),
    ).toContain('visual.author');
  });
  it('uses actual configured model transports for protected title maintenance and graph drafting', async () => {
    let calls = 0;
    const definition = {
      tasks: [
        {
          id: 'contract',
          title: 'Verify boundary',
          description: 'Implement consumer contract coverage.',
          acceptanceCriteria: [
            'Consumer preview works without the live provider.',
          ],
        },
      ],
      edges: [],
    };
    const gateway = await http((_p, _b, r) =>
      r.end(
        JSON.stringify(
          generated(
            calls++ === 0 ? 'Contract boundary' : JSON.stringify(definition),
          ),
        ),
      ),
    );
    const w = await fixture({ gatewayBaseUrl: gateway.url });
    expect(
      await w.agent.generateTitle({
        artifact: w.artifact,
        messages: [
          { author: w.user.name, body: 'Keep preview independent.' },
        ],
        signal: new AbortController().signal,
        idempotencyKey: 'title-key',
      }),
    ).toBe('Contract boundary');
    expect(
      await w.agent.generateImplementationGraph({
        artifact: w.artifact,
        text: 'Verify the consumer contract before integration.',
        signal: new AbortController().signal,
        idempotencyKey: 'graph-key',
      }),
    ).toEqual(definition);
    expect(gateway.requests).toHaveLength(2);
    await w.agent.claimBackgroundOwnership(w.user, w.artifact.id);
    expect((await w.agent.ownership(w.user, w.artifact.id))?.userId).toBe(
      w.user.id,
    );
  });
  it('uses the selected owner identity transport for actual model repository tools and never falls back to the operator token', async () => {
    let modelCalls = 0;
    const gateway = await http((_p, _b, r) => {
      const response = generated('Verified user repository context.');
      if (modelCalls++ === 0) {
        response.content = [
          {
            type: 'tool-call',
            toolCallId: 'file-call',
            toolName: 'repository_file',
            input: JSON.stringify({ path: 'README.md' }),
          },
        ] as any;
        response.finishReason = { unified: 'tool-calls', raw: 'tool_calls' };
      }
      r.end(JSON.stringify(response));
    });
    const github = await http((_p, body, r) =>
      r.end(
        JSON.stringify(
          body.kind === 'commits'
            ? [{ sha: 'a'.repeat(40) }]
            : {
                type: 'file',
                size: 24,
                encoding: 'base64',
                content: Buffer.from(
                  'Selected user repository text.',
                ).toString('base64'),
              },
        ),
      ),
    );
    const w = await fixture({ gatewayBaseUrl: gateway.url });
    w.settings.repositoryIdentity = { explicitProtocolFixture: true };
    w.settings.githubToken = 'operator-token-must-not-be-used';
    w.settings.githubRepositories = ['acme/private'];
    await w.store.exec(
      'UPDATE projects SET repository=? WHERE id=?',
      'https://github.com/acme/private',
      w.project.id,
    );
    const selectedUsers: string[] = [];
    w.agent.options.repositoryRead = async (
      user,
      repository,
      input,
      signal,
    ) => {
      selectedUsers.push(user.id);
      expect(repository).toBe('https://github.com/acme/private');
      const response = await fetch(github.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer explicit-selected-user-token',
        },
        body: JSON.stringify(input),
        signal,
      });
      return response.json();
    };
    const job = await w.agent.respond(
      w.user,
      w.artifact.id,
      w.threadId,
      'chat',
    );
    await w.run(job.id);
    expect((await w.runtime.get(job.id))?.status).toBe('completed');
    expect(modelCalls).toBe(2);
    expect(selectedUsers).toEqual([w.user.id, w.user.id]);
    expect(github.requests.map((x) => x.headers.authorization)).toEqual([
      'Bearer explicit-selected-user-token',
      'Bearer explicit-selected-user-token',
    ]);
    expect(github.requests[1]?.body).toEqual({
      kind: 'file',
      path: 'README.md',
      ref: 'a'.repeat(40),
    });
    expect(JSON.stringify(gateway.requests[1].body)).toContain(
      'Selected user repository text',
    );
    expect(JSON.stringify(gateway.requests)).not.toContain(
      'operator-token-must-not-be-used',
    );
    w.agent.options.repositoryRead = undefined;
    const rejected = await w.agent.respond(
      w.user,
      w.artifact.id,
      w.threadId,
      'chat',
    );
    await w.run(rejected.id);
    expect((await w.runtime.get(rejected.id))?.status).toBe('queued');
    expect(github.requests).toHaveLength(2);
    expect(modelCalls).toBe(2);
  });
});

async function participationFixture(
  action: 'respond' | 'wait' | 'stay_silent',
  pending?: () => Promise<void>,
) {
  const gateway = await http((_path, _body, res) =>
    res.end(JSON.stringify(generated('A concrete relevant answer.'))),
  );
  const native = await http((_path, body, res) => {
    void (async () => {
      await pending?.();
      res.end(
        JSON.stringify({
          model: body.model,
          answers: body.questions.map((q: any) => ({
            name: q.name,
            type: 'choice',
            choice: action,
            confidence: 0.95,
            probabilities: q.choices.map((c: any) => ({
              value: c.value,
              probability: c.value === action ? 0.96 : 0.02,
            })),
          })),
          usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
        }),
      );
    })();
  });
  const w = await fixture({ gatewayBaseUrl: gateway.url });
  const models = new DecisionModels({
    store: w.store,
    settings: {
      production: false,
      timeoutMs: 3000,
      defaultProfile: decisionProfileSchema.parse({
        provider: 'openai-decisions',
        model: 'gpt-6-luna',
      }),
      openai: {
        baseUrl: native.url + '/v1',
        apiKey: 'explicit-participation-native-fixture',
        models: ['gpt-6-luna'],
      },
    },
  });
  await models.ready;
  cleanup.push(() => models.close());
  w.agent.options.decisions = models;
  await w.agent.policy(w.user, w.artifact.id, {
    mode: 'automatic',
    paused: false,
  });
  const start = async (body = 'Is there a concrete next step here?') => {
    await w.store.message(w.user, w.artifact.id, w.threadId, body);
    await w.agent.observeMessage(w.user, w.artifact.id, w.threadId, body);
    const job = (await w.agent.jobs(w.user, w.artifact.id))[0]!;
    // Deliver the durable delayed intent at its due time without waiting on a process timer.
    await w.store.exec(
      'UPDATE studio_durable_jobs SET available_at=0 WHERE id=?',
      job.id,
    );
    return job;
  };
  return { ...w, start, native, gateway, models };
}
describe('Agent integrates participation advice after deterministic eligibility', () => {
  it.each(['wait', 'stay_silent'] as const)(
    'retains %s advice and skips model authoring without inventing a reply',
    async (action) => {
      const w = await participationFixture(action),
        job = await w.start();
      await w.run(job.id);
      await w.run(job.id);
      expect(w.native.requests).toHaveLength(1);
      expect(w.gateway.requests).toHaveLength(0);
      expect(
        (await w.store.messages(w.artifact.id)).filter(
          (m) => m.role === 'assistant',
        ),
      ).toHaveLength(0);
      expect((await w.runtime.get(job.id))?.result).toMatchObject({
        participation: { action, status: 'answered' },
      });
    },
  );
  it('uses a frozen decision profile for eligible respond advice while keeping primary authoring separate', async () => {
    const w = await participationFixture('respond'),
      job = await w.start();
    await w.models.profile(
      w.user,
      w.artifact.id,
      decisionProfileSchema.parse({ provider: 'jev', model: 'jev-latest' }),
    );
    await w.run(job.id);
    expect(w.native.requests).toHaveLength(1);
    expect(w.native.requests[0].body.model).toBe('gpt-6-luna');
    expect(w.gateway.requests).toHaveLength(1);
    expect(
      (await w.store.messages(w.artifact.id)).filter(
        (m) => m.role === 'assistant',
      ),
    ).toHaveLength(1);
  });
  it('explicit mentions and manually requested turns bypass semantic suppression', async () => {
    const w = await participationFixture('stay_silent'),
      job = await w.start('@studio Please answer this explicit question.');
    await w.run(job.id);
    const manual = await w.agent.respond(
      w.user,
      w.artifact.id,
      w.threadId,
      'chat',
    );
    await w.run(manual.id);
    expect(w.native.requests).toHaveLength(0);
    expect(w.gateway.requests).toHaveLength(2);
  });
  it.each(['pause', 'lock', 'newer-message'] as const)(
    'rechecks %s after a decision is in flight before primary authoring',
    async (change) => {
      let arrived!: () => void, release!: () => void;
      const incoming = new Promise<void>((resolve) => (arrived = resolve)),
        gate = new Promise<void>((resolve) => (release = resolve));
      const w = await participationFixture('respond', async () => {
          arrived();
          await gate;
        }),
        job = await w.start();
      const running = w.run(job.id);
      await incoming;
      if (change === 'pause')
        await w.agent.policy(w.user, w.artifact.id, {
          mode: 'automatic',
          paused: true,
        });
      if (change === 'lock') w.setLocked(true);
      if (change === 'newer-message')
        await w.store.message(
          w.user,
          w.artifact.id,
          w.threadId,
          'A newer human message supersedes the assessment.',
        );
      release();
      await running;
      expect(w.gateway.requests).toHaveLength(0);
      expect(
        (await w.store.messages(w.artifact.id)).filter(
          (m) => m.role === 'assistant',
        ),
      ).toHaveLength(0);
      expect((await w.runtime.get(job.id))?.status).toBe(
        change === 'pause' ? 'cancelled' : 'failed',
      );
    },
  );
});
