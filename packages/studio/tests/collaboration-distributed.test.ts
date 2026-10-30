import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { yXmlFragmentToProsemirrorJSON } from 'y-prosemirror';
import { Store, hash, HttpError } from '../server/store.ts';
import { openDatabase } from '../server/persistence/index.ts';
import { Collaboration } from '../server/collaboration.ts';
import { SqlRealtimeTransport } from '../server/realtime/transport.ts';
import type { Auth } from '../server/auth.ts';

const pg = process.env.STUDIO_TEST_POSTGRES_URL;
const origin = 'http://127.0.0.1:8787';
const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function eventually(
  check: () => boolean | Promise<boolean>,
  timeout = 10000,
) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline)
      throw new Error('Distributed collaboration did not converge');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const text = (doc: Y.Doc) =>
  JSON.stringify(
    yXmlFragmentToProsemirrorJSON(doc.getXmlFragment('default')),
  );
function append(doc: Y.Doc, value: string) {
  doc.transact(() => {
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.setAttribute('id', randomUUID());
    const node = new Y.XmlText();
    node.insert(0, value);
    paragraph.insert(0, [node]);
    doc.getXmlFragment('default').push([paragraph]);
  });
}
async function store(schema: string) {
  const result = await Store.open(
    await openDatabase({ adapter: 'postgres', url: pg!, schema }),
  );
  cleanup.push(() => result.close());
  return result;
}
async function identity(
  store: Store,
  projectId?: string,
  role: 'owner' | 'editor' | 'viewer' = 'owner',
) {
  const user = await store.createUser(
    `peer-${randomUUID()}@example.test`,
    role === 'viewer'
      ? 'Read-only teammate'
      : `Teammate ${randomUUID().slice(0, 5)}`,
    null,
  );
  if (projectId)
    await store.exec(
      'INSERT INTO memberships VALUES(?,?,?)',
      projectId,
      user.id,
      role,
    );
  const token = randomBytes(32).toString('base64url');
  await store.exec(
    'INSERT INTO sessions VALUES(?,?,?,?)',
    hash(token),
    user.id,
    Date.now() + 3600000,
    'session',
  );
  return { user, token };
}
async function server(store: Store, delayAuth?: () => Promise<void>) {
  // Explicit session adapter fixture: production Store and WebSocket paths remain real and independently connected.
  const auth = {
    assertOrigin(request: FastifyRequest) {
      if (request.headers.origin !== origin)
        throw new HttpError(403, 'Origin not allowed');
    },
    async user(request: FastifyRequest) {
      await delayAuth?.();
      const token = request.headers.cookie?.match(
        /studio_session=([^;]+)/,
      )?.[1];
      const row = token
        ? await store.one(
            'SELECT user_id FROM sessions WHERE token=? AND expires>? AND kind=?',
            hash(token),
            Date.now(),
            'session',
          )
        : undefined;
      if (!row) throw new HttpError(401, 'Session expired');
      return store.publicUser(row.user_id);
    },
  } as unknown as Auth;
  const collab = new Collaboration(store, auth, { pollMs: 15 }),
    app = Fastify();
  await app.register(websocket, {
    options: { maxPayload: 1024 * 1024, perMessageDeflate: false },
  });
  collab.routes(app);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await collab.close();
    await app.close();
  };
  cleanup.push(close);
  return { collab, app, address: address.replace('http:', 'ws:'), close };
}
async function connect(
  instance: Awaited<ReturnType<typeof server>>,
  artifactId: string,
  token: string,
  existing?: Y.Doc,
) {
  const doc = existing ?? new Y.Doc();
  class AuthenticatedWebSocket extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols, {
        headers: { Origin: origin, Cookie: `studio_session=${token}` },
      });
    }
  }
  const provider = new WebsocketProvider(
    instance.address + '/api/collaboration',
    artifactId,
    doc,
    {
      connect: false,
      disableBc: true,
      WebSocketPolyfill: AuthenticatedWebSocket as any,
    },
  );
  cleanup.push(() => {
    provider.destroy();
    if (!existing) doc.destroy();
  });
  provider.awareness.setLocalStateField('user', {
    name: 'Client supplied fixture name',
  });
  provider.connect();
  await eventually(() => provider.synced);
  return { doc, provider };
}

describe.skipIf(!pg)(
  'real PostgreSQL cross-instance WebSocket collaboration',
  () => {
    it('seeds one document, merges simultaneous edits across independent instances, and survives an instance restart', async () => {
      const schema = 'test_' + randomUUID().replaceAll('-', ''),
        a = await store(schema),
        b = await store(schema),
        owner = await identity(a),
        project = await a.createProject(
          owner.user,
          'Shared source',
          'Real distributed acceptance',
        );
      const first = await server(a),
        second = await server(b);
      const [left, right] = await Promise.all([
        connect(first, project.mainArtifactId, owner.token),
        connect(second, project.mainArtifactId, owner.token),
      ]);
      expect(text(left.doc)).toBe(text(right.doc));
      expect(text(left.doc).match(/Acceptance criteria/g) ?? []).toHaveLength(
        1,
      );
      left.provider.disconnect();
      right.provider.disconnect();
      append(left.doc, 'Left instance edits independently.');
      append(right.doc, 'Right instance edits independently.');
      left.provider.connect();
      right.provider.connect();
      await eventually(
        () =>
          text(left.doc).includes('Right instance edits') &&
          text(right.doc).includes('Left instance edits'),
      );
      expect(text(left.doc)).toBe(text(right.doc));
      await eventually(async () =>
        JSON.stringify(
          (await a.artifact(project.mainArtifactId, owner.user.id)).content,
        ).includes('Right instance edits'),
      );
      left.provider.shouldConnect = false;
      left.provider.destroy();
      await first.close();
      append(right.doc, 'The surviving instance remains writable.');
      await eventually(async () =>
        JSON.stringify(
          (await b.artifact(project.mainArtifactId, owner.user.id)).content,
        ).includes('surviving instance'),
      );
      const c = await store(schema),
        restarted = await server(c),
        restored = await connect(
          restarted,
          project.mainArtifactId,
          owner.token,
        );
      expect(text(restored.doc)).toContain('Left instance edits');
      expect(text(restored.doc)).toContain('Right instance edits');
      expect(text(restored.doc)).toContain('surviving instance');
    });
    it('queues initial frames before asynchronous authentication finishes', async () => {
      const schema = 'test_' + randomUUID().replaceAll('-', ''),
        database = await store(schema),
        owner = await identity(database),
        project = await database.createProject(
          owner.user,
          'Buffered handshake',
          '',
        );
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let blocking = true;
      const instance = await server(database, () =>
        blocking ? gate : Promise.resolve(),
      );
      const doc = new Y.Doc();
      append(doc, 'An edit sent during the awaited authentication boundary.');
      class AuthenticatedWebSocket extends WebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols, {
            headers: {
              Origin: origin,
              Cookie: `studio_session=${owner.token}`,
            },
          });
        }
      }
      const provider = new WebsocketProvider(
        instance.address + '/api/collaboration',
        project.mainArtifactId,
        doc,
        {
          connect: false,
          disableBc: true,
          WebSocketPolyfill: AuthenticatedWebSocket as any,
        },
      );
      cleanup.push(() => {
        provider.destroy();
        doc.destroy();
      });
      provider.connect();
      await eventually(() => provider.wsconnected);
      blocking = false;
      release();
      await eventually(() => provider.synced);
      await eventually(async () =>
        JSON.stringify(
          (await database.artifact(project.mainArtifactId, owner.user.id))
            .content,
        ).includes('awaited authentication boundary'),
      );
    });
    it('attributes presence across instances, permits large honest echoes, and suppresses revoked passive readers', async () => {
      // Each Node-only protocol client owns one exit listener; verify every one is removed after destroy.
      const listenerLimit = process.getMaxListeners(),
        exitListeners = process.listenerCount('exit');
      process.setMaxListeners(listenerLimit + 20);
      cleanup.push(() => {
        expect(process.listenerCount('exit')).toBe(exitListeners);
        process.setMaxListeners(listenerLimit);
      });
      const schema = 'test_' + randomUUID().replaceAll('-', ''),
        a = await store(schema),
        b = await store(schema),
        owner = await identity(a),
        project = await a.createProject(owner.user, 'Shared presence', '');
      const viewer = await identity(a, project.id, 'viewer'),
        first = await server(a),
        second = await server(b),
        writer = await connect(first, project.mainArtifactId, owner.token),
        passive = await connect(second, project.mainArtifactId, viewer.token);
      writer.provider.awareness.setLocalStateField('user', {
        id: 'forged',
        name: 'Forged administrator',
        color: '#000000',
      });
      await eventually(() =>
        [...passive.provider.awareness.getStates().values()].some(
          (state) => state.user?.id === owner.user.id,
        ),
      );
      expect(
        [...passive.provider.awareness.getStates().values()].find(
          (state) => state.user?.id === owner.user.id,
        )?.user.name,
      ).toBe(owner.user.name);
      const peers: Awaited<ReturnType<typeof connect>>[] = [];
      for (let index = 0; index < 11; index++)
        peers.push(
          await connect(
            index % 2 ? first : second,
            project.mainArtifactId,
            owner.token,
          ),
        );
      await expect
        .poll(
          () => ({
            visibleOwners: [
              ...passive.provider.awareness.getStates().values(),
            ].filter((state) => state.user?.id === owner.user.id).length,
            visibleTotal: passive.provider.awareness.getStates().size,
            connected: peers.filter((peer) => peer.provider.wsconnected)
              .length,
            serverA: first.collab.rooms.get(project.mainArtifactId)?.peers
              .size,
            serverB: second.collab.rooms.get(project.mainArtifactId)?.peers
              .size,
            ownerA: first.collab.rooms.get(project.mainArtifactId)?.owners
              .size,
            ownerB: second.collab.rooms.get(project.mainArtifactId)?.owners
              .size,
          }),
          { timeout: 10000 },
        )
        .toMatchObject({ visibleOwners: 12, connected: 11 });
      expect(peers.every((peer) => peer.provider.wsconnected)).toBe(true);
      let closed = false;
      passive.provider.shouldConnect = false;
      passive.provider.on('connection-close', () => {
        closed = true;
      });
      await a.tx(async () => {
        await a.db.lock('project:' + project.id);
        await a.exec(
          'DELETE FROM memberships WHERE project_id=? AND user_id=?',
          project.id,
          viewer.user.id,
        );
      });
      append(writer.doc, 'Private content after the distributed revocation.');
      await eventually(() => closed);
      expect(text(passive.doc)).not.toContain('Private content after');
      await eventually(async () =>
        JSON.stringify(
          (await b.artifact(project.mainArtifactId, owner.user.id)).content,
        ).includes('Private content after'),
      );
    });
    it('keeps a failed transactional document/outbox publication out of durable storage and live caches', async () => {
      const schema = 'test_' + randomUUID().replaceAll('-', ''),
        a = await store(schema),
        b = await store(schema),
        owner = await identity(a),
        project = await a.createProject(owner.user, 'Atomic publication', '');
      const first = await server(a),
        second = await server(b),
        left = await connect(first, project.mainArtifactId, owner.token),
        right = await connect(second, project.mainArtifactId, owner.token);
      const artifact = await a.artifact(
          project.mainArtifactId,
          owner.user.id,
        ),
        before = text(left.doc),
        originalPublish = first.collab.realtime.publish.bind(
          first.collab.realtime,
        );
      first.collab.realtime.publish = async () => {
        throw new Error('Injected outbox failure');
      };
      try {
        await expect(
          first.collab.replace(
            project.mainArtifactId,
            owner.user,
            {
              doc: {
                type: 'doc',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'Must never appear' }],
                  },
                ],
              },
            },
            artifact.version,
          ),
        ).rejects.toThrow('outbox failure');
      } finally {
        first.collab.realtime.publish = originalPublish;
      }
      expect(text(left.doc)).toBe(before);
      expect(text(right.doc)).toBe(before);
      expect(
        (await b.artifact(project.mainArtifactId, owner.user.id)).version,
      ).toBe(artifact.version);
    });
  },
);

describe('durable SQL realtime fan-out', () => {
  it('rolls back event publication with its source transaction and skips sender echoes', async () => {
    const database = await Store.open(':memory:');
    cleanup.push(() => database.close());
    const sender = new SqlRealtimeTransport(database, {
        instanceId: 'sender',
        pollMs: 10,
      }),
      receiver = new SqlRealtimeTransport(database, {
        instanceId: 'receiver',
        pollMs: 10,
      });
    cleanup.push(
      () => sender.close(),
      () => receiver.close(),
    );
    const own: any[] = [],
      received: any[] = [];
    await sender.subscribe('project:fixture', (message) => {
      own.push(message);
    });
    await receiver.subscribe('project:fixture', (message) => {
      received.push(message);
    });
    await expect(
      database.tx(async () => {
        await sender.publish('project:fixture', {
          type: 'changed',
          artifactId: 'rollback',
        });
        throw new Error('Rollback source');
      }),
    ).rejects.toThrow('Rollback source');
    await receiver.poll();
    expect(received).toHaveLength(0);
    await sender.publish('project:fixture', {
      type: 'changed',
      artifactId: 'committed',
    });
    await receiver.poll();
    expect(received.map((message) => message.data.artifactId)).toEqual([
      'committed',
    ]);
    await sender.poll();
    expect(own).toHaveLength(0);
  });
});
