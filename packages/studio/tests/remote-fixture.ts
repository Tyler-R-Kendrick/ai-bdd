import { afterEach } from 'vitest';
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
import { openDatabase } from '../server/persistence/index.ts';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
export async function remoteFixture(
  options: {
    postgresUrl?: string;
    configure?: (context: {
      app: ReturnType<typeof Fastify>;
      store: Store;
      agent: Agent;
      remote: RemotePlanner;
      user: Awaited<ReturnType<Store['publicUser']>>;
      project: NonNullable<Awaited<ReturnType<Store['createProject']>>>;
      artifact: Awaited<ReturnType<Store['artifact']>>;
      settings: any;
      runtime: DurableJobCoordinator;
    }) => Promise<void>;
  } = {},
) {
  const postgres =
    options.postgresUrl ?? process.env.STUDIO_REMOTE_TEST_POSTGRES_URL;
  const schema = 'remote_' + crypto.randomUUID().replaceAll('-', '');
  const store = await Store.open(
    postgres
      ? await openDatabase({ adapter: 'postgres', url: postgres, schema })
      : ':memory:',
  );
  cleanups.push(async () => {
    if (postgres) await store.db.exec(`DROP SCHEMA "${schema}" CASCADE`);
    await store.close();
  });
  const settings: any = {
    production: false,
    origin: 'http://localhost',
    dataDir: '/tmp/studio-remote-fixture',
    demo: false,
    integrations: { remotePlanner: true },
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
  await agent.profiles.view(user, artifact.id, {
    harness: 'remote-planner',
    provider: 'operator-acp',
    model: 'remote',
  });
  const viewer = await store.createUser('viewer@remote.test', 'Viewer', null);
  await store.exec(
    "INSERT INTO memberships(project_id,user_id,role) VALUES(?,?,'viewer')",
    project.id,
    viewer.id,
  );
  let revoked = false;
  // Explicit credential adapter isolates transport behavior; production uses the same App Auth.user bearer/session verifier.
  const remote = new RemotePlanner({
    store,
    settings,
    authenticate: async (request) => {
      if (request.headers.cookie === 'owner-browser') return user;
      if (request.headers.cookie === 'viewer-browser') return viewer;
      if (
        revoked ||
        request.headers.authorization !== 'Bearer explicit-fixture-token'
      )
        throw new HttpError(401, 'Invalid fixture token');
      return user;
    },
    cancelJob: (id, user) => runtime.cancel(id, user),
    claim: (u, id) => agent.claimPlanner(u, id),
    allowed: (u, id) => agent.canParticipate(u, id),
    pollMs: 15,
  });
  await remote.initialize();
  agent.options.remote = remote;
  cleanups.push(() => remote.close());
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) =>
    reply
      .code((error as HttpError).statusCode ?? 400)
      .send({ error: (error as Error).message }),
  );
  await app.register(websocket);
  remote.register(app);
  await options.configure?.({
    app,
    store,
    agent,
    remote,
    user,
    project,
    artifact,
    settings,
    runtime,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  cleanups.push(() => app.close());
  settings.origin = app.listeningOrigin;
  remote.activity.options.origin = app.listeningOrigin;
  const connect = async (features = true) => {
    const ws = new WebSocket(
      app.listeningOrigin.replace('http:', 'ws:') + '/api/planner/connect',
      'studio.planner.v1',
      {
        headers: {
          Authorization: 'Bearer explicit-fixture-token',
          ...(features
            ? {
                'Studio-Planner-Features':
                  'stream-parts,questions,run-cards,run-stage-deltas',
              }
            : {}),
        },
      },
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
    request: async (path: string, body?: unknown, cookie = 'owner-browser') => {
      const response = await fetch(app.listeningOrigin + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Origin: app.listeningOrigin,
          Cookie: cookie,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await response.json();
      return { status: response.status, value };
    },
    start: async () => {
      const job = await agent.respond(user, artifact.id, threadId, 'chat');
      const done = runtime.executeJob(job.id, {
        messageId: crypto.randomUUID(),
        deliveryCount: 1,
      });
      return { job, done };
    },
    remote,
    origin: app.listeningOrigin,
    revoke: () => {
      revoked = true;
    },
  };
}
export async function until(check: () => boolean | Promise<boolean>) {
  const stop = Date.now() + 3000;
  while (!(await check())) {
    if (Date.now() > stop) throw new Error('Remote Planner fixture timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
