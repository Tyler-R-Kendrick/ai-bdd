import { afterEach, describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { Store } from '../server/store.ts';
import { openDatabase } from '../server/persistence/index.ts';
import { DecisionModels } from '../server/decisions/models.ts';
import { DurableJobCoordinator } from '../server/runtime/jobs.ts';
import {
  adviseParticipation,
  participationPolicyVersion,
} from '../server/integrations/participation-adviser.ts';
import type { DecisionProfile } from '../shared/decision-profile.ts';
const cleanup: (() => Promise<unknown>)[] = [],
  postgres =
    process.env.STUDIO_PARTICIPATION_TEST_POSTGRES_URL ??
    process.env.STUDIO_TEST_POSTGRES_URL;
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { resolve, promise };
}
async function fixture() {
  const api = Fastify(),
    requests: { body: any; headers: any }[] = [],
    control: { action: string; gate?: Promise<void>; entered?: () => void } = {
      action: 'respond',
    };
  api.post('/v1/decisions', async (request, reply) => {
    requests.push({ body: request.body, headers: request.headers });
    control.entered?.();
    await control.gate;
    const body = request.body as any;
    const choice = control.action === 'abstained' ? 'respond' : control.action;
    const answer =
      control.action === 'refused'
        ? { type: 'refusal', name: 'participation' }
        : {
            type: 'choice',
            name: 'participation',
            choice,
            confidence: control.action === 'abstained' ? 0.55 : 0.95,
            probabilities: ['respond', 'wait', 'stay_silent'].map((value) => ({
              value,
              probability:
                value ===
                (['respond', 'wait', 'stay_silent'].includes(choice)
                  ? choice
                  : 'respond')
                  ? 0.9
                  : 0.05,
            })),
          };
    return reply
      .header('x-request-id', 'native-participation-fixture-' + requests.length)
      .send({
        model: body.model + '-fixture-resolved',
        answers: [answer],
        usage: { input_tokens: null, output_tokens: null, total_tokens: null },
      });
  });
  await api.listen({ host: '127.0.0.1', port: 0 });
  cleanup.push(() => api.close());
  const store = await Store.open(
    postgres
      ? await openDatabase({
          adapter: 'postgres',
          url: postgres,
          schema: 'participation_' + crypto.randomUUID().replaceAll('-', ''),
        })
      : ':memory:',
  );
  cleanup.push(() => store.close());
  const user = await store.createUser(
      'participation@example.test',
      'Conversation owner',
      null,
    ),
    project = (await store.createProject(user, 'Participation fixture', ''))!,
    artifact = await store.createArtifact(
      user,
      project.id,
      'code',
      'Conversation context',
    );
  const profile: DecisionProfile = {
    provider: 'openai-decisions',
    model: 'native-a',
    minimumConfidence: 0.7,
    policyVersion: 'decision-policy-v1',
  };
  const models = new DecisionModels({
    store,
    settings: {
      production: false,
      timeoutMs: 3000,
      defaultProfile: profile,
      openai: {
        baseUrl: api.listeningOrigin + '/v1',
        apiKey: 'explicit-participation-http-fixture-key',
        models: ['native-a', 'native-b'],
      },
    },
  });
  await models.ready;
  cleanup.push(() => models.close());
  const runtime = new DurableJobCoordinator({
    store,
    dispatcher: {
      provider: 'explicit-participation-delivery',
      publish: async () => ({ provider: 'explicit-participation-delivery' }),
    },
    leaseMs: 1000,
  });
  await runtime.ready;
  cleanup.push(() => runtime.close());
  runtime.register('fixture.participation', async (context) => {
    const snapshot = context.snapshot as {
      profile: DecisionProfile;
      input: string;
      latestId: string;
    };
    const result = await adviseParticipation({
      models,
      context,
      user,
      artifactId: artifact.id,
      artifactVersion: context.job.artifactVersion,
      ...snapshot,
    });
    return context.commit('record-advice', async () => result, {
      requireCurrentVersion: true,
    });
  });
  const queue = async (
    input = 'A contributor asks whether the retry policy needs a bounded timeout.',
    latestId = crypto.randomUUID(),
  ) =>
    runtime.enqueue({
      kind: 'fixture.participation',
      artifactId: artifact.id,
      projectId: project.id,
      principalId: user.id,
      artifactVersion: (await store.artifact(artifact.id, user.id)).version,
      snapshot: {
        profile: await models.captureProfile(user, artifact.id),
        input,
        latestId,
      },
      idempotencyKey: crypto.randomUUID(),
    });
  const execute = async (jobId: string) =>
    runtime.executeJob(jobId, {
      messageId: crypto.randomUUID(),
      deliveryCount: 1,
    });
  return {
    api,
    store,
    user,
    project,
    artifact,
    models,
    runtime,
    control,
    requests,
    queue,
    execute,
  };
}
describe(`automatic participation advice (${postgres ? 'PostgreSQL' : 'SQLite'})`, () => {
  it('uses only finite participation choices and retains actual provider provenance without mutating conversation or permissions', async () => {
    const c = await fixture();
    for (const action of ['respond', 'wait', 'stay_silent']) {
      c.control.action = action;
      const queued = await c.queue();
      await c.execute(queued.id);
      const job = (await c.runtime.get(queued.id))!,
        result = job.result as any;
      expect(job.status).toBe('completed');
      expect(result.action).toBe(action);
      expect(result.evaluation.provenance).toMatchObject({
        purpose: 'conversation-participation',
        promptVersion: participationPolicyVersion,
        requestedModel: 'native-a',
        mode: 'native-decision',
        artifactVersion: 1,
        providerRequestId: 'native-participation-fixture-' + c.requests.length,
        usage: { inputTokens: null, outputTokens: null, totalTokens: null },
      });
    }
    const request = c.requests[0]!;
    expect(request.headers.authorization).toBe(
      'Bearer explicit-participation-http-fixture-key',
    );
    expect(request.body.questions).toHaveLength(1);
    expect(
      request.body.questions[0].choices.map((choice: any) => choice.value),
    ).toEqual(['respond', 'wait', 'stay_silent']);
    expect((await c.store.artifact(c.artifact.id, c.user.id)).version).toBe(1);
    expect(
      await c.store.all(
        'SELECT * FROM messages WHERE artifact_id=?',
        c.artifact.id,
      ),
    ).toEqual([]);
    expect(await c.store.runs(c.artifact.id)).toEqual([]);
    expect(
      (
        await c.store.one(
          'SELECT status FROM decisions WHERE artifact_id=?',
          c.artifact.id,
        )
      ).status,
    ).toBe('proposed');
  });
  it('retains abstention and refusal as uncertainty instead of converting them to respond or a negative answer', async () => {
    const c = await fixture();
    for (const outcome of ['abstained', 'refused']) {
      c.control.action = outcome;
      const queued = await c.queue();
      await c.execute(queued.id);
      const result = (await c.runtime.get(queued.id))!.result as any;
      expect(result.action).toBeNull();
      expect(result.evaluation.status).toBe(outcome);
      expect(result.evaluation.answers[0].value).toBeNull();
      if (outcome === 'abstained') {
        expect(result.evaluation.answers[0].candidate).toBe('respond');
        expect(result.evaluation.answers[0].confidence).toBe(0.55);
      }
    }
    expect(await c.models.history(c.user, c.artifact.id)).toHaveLength(2);
  });
  it('rejects an out-of-contract authority-shaped choice and never fabricates an approval', async () => {
    const c = await fixture();
    c.control.action = 'approve_graph';
    const queued = await c.queue();
    await c.execute(queued.id);
    const result = (await c.runtime.get(queued.id))!.result as any;
    expect(result.action).toBeNull();
    expect(result.evaluation.status).toBe('error');
    expect(result.evaluation.answers[0]).toMatchObject({
      status: 'error',
      value: null,
      error: 'invalid-response',
    });
    expect(
      (
        await c.store.one(
          'SELECT status FROM decisions WHERE artifact_id=?',
          c.artifact.id,
        )
      ).status,
    ).toBe('proposed');
  });
  it('freezes the independent decision profile before queue execution and reuses its durable result on redelivery', async () => {
    const c = await fixture(),
      queued = await c.queue();
    await c.models.profile(c.user, c.artifact.id, {
      provider: 'openai-decisions',
      model: 'native-b',
      minimumConfidence: 0.8,
      policyVersion: 'decision-policy-v1',
    });
    await c.execute(queued.id);
    await c.execute(queued.id);
    expect(c.requests).toHaveLength(1);
    expect(c.requests[0]!.body.model).toBe('native-a');
    expect(
      ((await c.runtime.get(queued.id))!.result as any).evaluation.provenance
        .requestedModel,
    ).toBe('native-a');
    expect((await c.models.captureProfile(c.user, c.artifact.id)).model).toBe(
      'native-b',
    );
  });
  it('bounds UTF-8 context honestly while keeping the latest message and exact original source provenance', async () => {
    const c = await fixture(),
      text = '\\"\n中文😀'.repeat(15000) + ' latest-message-tail',
      latestId = crypto.randomUUID(),
      queued = await c.queue(text, latestId);
    await c.execute(queued.id);
    const input = JSON.parse(c.requests[0]!.body.input[1].content);
    expect(input.latestMessageId).toBe(latestId);
    expect(input.source.truncated).toBe(true);
    expect(input.source.originalUtf8Bytes).toBe(Buffer.byteLength(text));
    expect(input.source.includedUtf8Bytes).toBe(
      Buffer.byteLength(input.source.text),
    );
    expect(input.source.includedUtf8Bytes).toBeLessThanOrEqual(16384);
    expect(input.source.text.endsWith('latest-message-tail')).toBe(true);
    expect(input.source.text).not.toContain('\ufffd');
    expect(input.source.originalSha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it('does not publish stale advice after source changes while the provider request is in flight', async () => {
    const c = await fixture(),
      entered = deferred(),
      release = deferred();
    c.control.entered = () => entered.resolve();
    c.control.gate = release.promise;
    const queued = await c.queue(),
      work = c.execute(queued.id);
    cleanup.push(async () => {
      release.resolve();
      await work;
    });
    await entered.promise;
    await c.store.updateArtifact(c.user, c.artifact.id, 1, {
      ...c.artifact.content,
      files: { 'index.html': '<h1>Changed while deciding</h1>' },
    });
    release.resolve();
    await work;
    const job = (await c.runtime.get(queued.id))!;
    expect(job.status).not.toBe('completed');
    expect(job.result).toBeNull();
    expect(
      await c.store.all(
        'SELECT * FROM messages WHERE artifact_id=?',
        c.artifact.id,
      ),
    ).toEqual([]);
  });
});
