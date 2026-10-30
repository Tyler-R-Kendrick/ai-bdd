import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.ts';
import { openDatabase } from '../server/persistence/index.ts';
import { Collaboration } from '../server/collaboration.ts';
import { DurableJobCoordinator } from '../server/runtime/jobs.ts';
import { Agent } from '../server/agent.ts';
import { RemotePlanner } from '../server/integrations/remote-planner.ts';
const pg = process.env.STUDIO_TEST_POSTGRES_URL,
  close: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of close.splice(0).reverse()) await cleanup();
});
async function until(check: () => boolean | Promise<boolean>) {
  const stop = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > stop)
      throw new Error('Cross-instance remote Planner did not converge');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
describe.skipIf(!pg)('PostgreSQL remote Planner attachment recovery', () => {
  it('executes on one SQL instance while the model socket reconnects through replaced independent servers', async () => {
    const schema = 'test_' + randomUUID().replaceAll('-', '');
    const first = await Store.open(
        await openDatabase({ adapter: 'postgres', url: pg!, schema }),
      ),
      second = await Store.open(
        await openDatabase({ adapter: 'postgres', url: pg!, schema }),
      );
    close.push(
      () => first.close(),
      () => second.close(),
    );
    const settings: any = {
      production: false,
      origin: 'http://localhost',
      dataDir: '/tmp/studio-remote-pg-fixture',
      demo: false,
      integrations: { remotePlanner: true },
    };
    const user = await first.createUser(
        randomUUID() + '@test.invalid',
        'Cross-instance owner',
        null,
      ),
      project = await first.createProject(
        user,
        'Cross-instance planning',
        '',
      ),
      artifact = await first.artifact(project.mainArtifactId, user.id),
      threadId = (await first.threads(artifact.id))[0]!.id;
    const dispatcher = {
      provider: 'explicit-pg-job-delivery',
      publish: async () => ({ provider: 'explicit-pg-job-delivery' }),
    };
    const runtime1 = new DurableJobCoordinator({
        store: first,
        dispatcher,
        leaseMs: 2000,
      }),
      runtime2 = new DurableJobCoordinator({
        store: second,
        dispatcher,
        leaseMs: 2000,
      });
    await Promise.all([runtime1.ready, runtime2.ready]);
    close.push(
      () => runtime1.close(),
      () => runtime2.close(),
    );
    const collab1 = new Collaboration(first, { settings } as any),
      collab2 = new Collaboration(second, { settings } as any);
    await Promise.all([collab1.initialize(), collab2.initialize()]);
    close.push(
      () => collab1.close(),
      () => collab2.close(),
    );
    const agent1 = new Agent(first, settings, collab1, { runtime: runtime1 }),
      agent2 = new Agent(second, settings, collab2, { runtime: runtime2 });
    await Promise.all([agent1.initialize(), agent2.initialize()]);
    await agent1.profiles.view(user, artifact.id, {
      harness: 'remote-planner',
      provider: 'operator-acp',
      model: 'remote',
    });
    const remote = (store: Store, agent: Agent) =>
      new RemotePlanner({
        store,
        settings,
        authenticate: async () => user,
        claim: (u, id) => agent.claimPlanner(u, id),
        allowed: (u, id) => agent.canParticipate(u, id),
        pollMs: 20,
      });
    const transport1 = remote(first, agent1),
      transport2 = remote(second, agent2);
    await Promise.all([transport1.initialize(), transport2.initialize()]);
    agent1.options.remote = transport1;
    agent2.options.remote = transport2;
    close.push(
      () => transport1.close(),
      () => transport2.close(),
    );
    const server = async () => {
      const app = Fastify();
      await app.register(websocket);
      transport2.register(app);
      await app.listen({ port: 0, host: '127.0.0.1' });
      close.push(() => app.close());
      return app;
    };
    const connect = async (origin: string) => {
      const frames: any[] = [];
      const ws = new WebSocket(
        origin.replace('http:', 'ws:') + '/api/planner/connect',
        'studio.planner.v1',
      );
      ws.on('message', (data) => frames.push(JSON.parse(data.toString())));
      await once(ws, 'open');
      close.push(async () => {
        ws.terminate();
      });
      ws.send(
        JSON.stringify({
          type: 'attach',
          version: 1,
          artifactId: artifact.id,
        }),
      );
      await until(() => frames.some((x) => x.type === 'attached'));
      return { ws, frames };
    };
    const initial = await server(),
      client1 = await connect(initial.listeningOrigin),
      job = await agent1.respond(user, artifact.id, threadId, 'chat'),
      running = runtime1.executeJob(job.id, {
        messageId: 'first-executor',
        deliveryCount: 1,
      });
    await until(() => client1.frames.some((x) => x.type === 'turn'));
    const firstTurn = client1.frames.find((x) => x.type === 'turn');
    const disconnected = once(client1.ws, 'close');
    await transport2.close();
    await disconnected;
    await initial.close();
    const replacement = await server(),
      client2 = await connect(replacement.listeningOrigin);
    await until(() => client2.frames.some((x) => x.type === 'turn'));
    const recovered = client2.frames.find((x) => x.type === 'turn');
    expect(recovered.requestId).toBe(firstTurn.requestId);
    client2.ws.send(
      JSON.stringify({
        type: 'result',
        requestId: recovered.requestId,
        output: {
          text: 'Recovered remote model publication.',
          content: null,
        },
      }),
    );
    await running;
    await runtime2.executeJob(job.id, {
      messageId: 'independent-redelivery',
      deliveryCount: 2,
    });
    expect(
      (await second.messages(artifact.id)).filter(
        (m) => m.role === 'assistant',
      ),
    ).toHaveLength(1);
    expect((await runtime1.get(job.id))?.status).toBe('completed');
  });
});
