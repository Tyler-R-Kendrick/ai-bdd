import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import { once } from 'node:events';
import { Store } from '../server/store.ts';
import { Collaboration } from '../server/collaboration.ts';
import { DurableJobCoordinator } from '../server/runtime/jobs.ts';
import { Agent } from '../server/agent.ts';
import { RemotePlanner } from '../server/integrations/remote-planner.ts';
import { HttpError } from '../server/store.ts';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  const store = await Store.open(':memory:');
  cleanups.push(() => store.close());
  const settings: any = {
    production: false,
    origin: 'http://localhost',
    dataDir: '/tmp/studio-remote-fixture',
    demo: false,
  };
  const collab = new Collaboration(store, { settings } as any);
  await collab.initialize();
  cleanups.push(() => collab.close());
  const runtime = new DurableJobCoordinator({
    store,
    dispatcher: {
      provider: 'explicit-delivery-fixture',
      publish: async () => ({ provider: 'explicit-delivery-fixture' }),
    },
    leaseMs: 500,
  });
  await runtime.ready;
  cleanups.push(() => runtime.close());
  const agent = new Agent(store, settings, collab, { runtime });
  await agent.initialize();
  const user = await store.createUser(
      'remote@test.invalid',
      'Remote Planner owner',
      null,
    ),
    project = await store.createProject(user, 'Remote planning', ''),
    artifact = await store.artifact(project.mainArtifactId, user.id),
    threadId = (await store.threads(artifact.id))[0]!.id;
  let revoked = false;
  // Explicit credential adapter isolates transport behavior; production uses the same App Auth.user bearer/session verifier.
  const remote = new RemotePlanner({
    store,
    settings,
    authenticate: async (request) => {
      if (
        revoked ||
        request.headers.authorization !== 'Bearer explicit-fixture-token'
      )
        throw new HttpError(401, 'Invalid fixture token');
      return user;
    },
    claim: (u, id) => agent.claimPlanner(u, id),
    allowed: (u, id) => agent.canParticipate(u, id),
    pollMs: 15,
  });
  await remote.initialize();
  agent.options.remote = remote;
  cleanups.push(() => remote.close());
  const app = Fastify();
  await app.register(websocket);
  remote.register(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  cleanups.push(() => app.close());
  settings.origin = app.listeningOrigin;
  const connect = async () => {
    const ws = new WebSocket(
      app.listeningOrigin.replace('http:', 'ws:') + '/api/planner/connect',
      'studio.planner.v1',
      { headers: { Authorization: 'Bearer explicit-fixture-token' } },
    );
    const frames: any[] = [];
    ws.on('message', (data) => frames.push(JSON.parse(data.toString())));
    await once(ws, 'open');
    ws.send(
      JSON.stringify({ type: 'attach', version: 1, artifactId: artifact.id }),
    );
    await until(() => frames.some((f) => f.type === 'attached'));
    cleanups.push(async () => {
      ws.terminate();
    });
    return { ws, frames };
  };
  return {
    store,
    agent,
    runtime,
    user,
    project,
    artifact,
    threadId,
    connect,
    remote,
    revoke: () => {
      revoked = true;
    },
  };
}
async function until(check: () => boolean | Promise<boolean>) {
  const stop = Date.now() + 3000;
  while (!(await check())) {
    if (Date.now() > stop)
      throw new Error('Remote Planner fixture timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
describe('actual remote Planner WebSocket transport', () => {
  it('receives frozen artifact turns and publishes only through the fenced reviewed server job', async () => {
    const w = await fixture(),
      client = await w.connect();
    await w.store.message(
      w.user,
      w.artifact.id,
      w.threadId,
      'Review this remote plan.',
    );
    const job = await w.agent.respond(
      w.user,
      w.artifact.id,
      w.threadId,
      'chat',
    );
    const running = w.runtime.executeJob(job.id, {
      messageId: 'socket-delivery',
      deliveryCount: 1,
    });
    await until(() => client.frames.some((f) => f.type === 'turn'));
    const turn = client.frames.find((f) => f.type === 'turn');
    expect(turn.input.context).toContain('Review this remote plan');
    expect(JSON.stringify(turn)).not.toContain('explicit-fixture-token');
    client.ws.send(
      JSON.stringify({
        type: 'result',
        requestId: turn.requestId,
        output: { text: 'Remote model planning result.', content: null },
      }),
    );
    await running;
    await w.runtime.executeJob(job.id, {
      messageId: 'duplicate',
      deliveryCount: 2,
    });
    expect((await w.runtime.get(job.id))?.status).toBe('completed');
    expect(
      (await w.store.messages(w.artifact.id)).filter(
        (m) => m.role === 'assistant',
      ),
    ).toHaveLength(1);
  });
  it('fences a superseded same-account connection and keeps queued work available to its replacement', async () => {
    const w = await fixture(),
      old = await w.connect(),
      closed = once(old.ws, 'close'),
      replacement = await w.connect();
    await closed;
    const job = await w.agent.respond(
        w.user,
        w.artifact.id,
        w.threadId,
        'chat',
      ),
      running = w.runtime.executeJob(job.id, {
        messageId: 'replacement',
        deliveryCount: 1,
      });
    await until(() => replacement.frames.some((f) => f.type === 'turn'));
    const turn = replacement.frames.find((f) => f.type === 'turn');
    replacement.ws.send(
      JSON.stringify({
        type: 'result',
        requestId: turn.requestId,
        output: { text: 'Replacement result.', content: null },
      }),
    );
    await running;
    expect(old.frames.filter((f) => f.type === 'turn')).toHaveLength(0);
    expect((await w.runtime.get(job.id))?.status).toBe('completed');
  });
  it('rechecks credential revocation while a turn is in flight and rejects late publication', async () => {
    const w = await fixture(),
      client = await w.connect(),
      job = await w.agent.respond(w.user, w.artifact.id, w.threadId, 'chat'),
      running = w.runtime.executeJob(job.id, {
        messageId: 'revoked',
        deliveryCount: 1,
      });
    await until(() => client.frames.some((f) => f.type === 'turn'));
    const turn = client.frames.find((f) => f.type === 'turn');
    const closed = once(client.ws, 'close');
    w.revoke();
    client.ws.send(
      JSON.stringify({
        type: 'result',
        requestId: turn.requestId,
        output: { text: 'Must not publish.', content: null },
      }),
    );
    await closed;
    await w.agent.cancel(w.user, w.artifact.id, job.id);
    await running;
    expect(
      (await w.store.messages(w.artifact.id)).filter(
        (m) => m.role === 'assistant',
      ),
    ).toHaveLength(0);
  });
});
