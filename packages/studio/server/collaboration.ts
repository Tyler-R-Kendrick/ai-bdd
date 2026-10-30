import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import * as sync from 'y-protocols/sync';
import * as awareness from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import {
  prosemirrorToYXmlFragment,
  yXmlFragmentToProsemirrorJSON,
} from 'y-prosemirror';
import { editorSchema } from '../shared/editor.ts';
import { validateContent, type User } from '../shared/domain.ts';
import { HttpError, type Store } from './store.ts';
import type { Auth } from './auth.ts';
import {
  SqlRealtimeTransport,
  type RealtimeTransport,
  type RealtimeMessage,
} from './realtime/transport.ts';

type ChannelPeer = {
  socket: WebSocket;
  check: () => Promise<void>;
  outgoing: Promise<void>;
  queuedBytes: number;
  queuedFrames: number;
};
type Peer = ChannelPeer & { id: string; user: User; ids: Set<number> };
type PresenceOwner = {
  connectionId: string;
  instanceId: string;
  userId: string;
};
type PresenceChange = { client: number; clock: number; state: any };
type Room = {
  id: string;
  projectId: string;
  kind: 'design' | 'document';
  doc: Y.Doc;
  awareness: awareness.Awareness;
  peers: Set<Peer>;
  owners: Map<number, PresenceOwner>;
  queue: Promise<void>;
  pending: number;
  unsubscribe?: () => Promise<void>;
  idle?: ReturnType<typeof setTimeout>;
};
const packet = (type: number, write: (encoder: encoding.Encoder) => void) => {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, type);
  write(encoder);
  return encoding.toUint8Array(encoder);
};
const syncPacket = (update: Uint8Array) =>
  packet(0, (encoder) => sync.writeUpdate(encoder, update));
function awarenessBytes(changes: PresenceChange[]) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, changes.length);
  for (const change of changes) {
    encoding.writeVarUint(encoder, change.client);
    encoding.writeVarUint(encoder, change.clock);
    encoding.writeVarString(encoder, JSON.stringify(change.state));
  }
  return encoding.toUint8Array(encoder);
}

/** Room state is a cache. SQL owns canonical documents, access revocation, and cross-instance notifications. */
export class Collaboration {
  readonly rooms = new Map<string, Room>();
  readonly events = new Map<string, Set<ChannelPeer>>();
  readonly realtime: RealtimeTransport;
  private readonly initializing = new Map<string, Promise<Room>>();
  private readonly projectSubscriptions = new Map<
    string,
    Promise<() => Promise<void>>
  >();
  private readonly background = new Set<Promise<unknown>>();
  private closed = false;
  readonly heartbeat: ReturnType<typeof setInterval>;
  constructor(
    readonly store: Store,
    readonly auth: Auth,
    options: { realtime?: RealtimeTransport; pollMs?: number } = {},
  ) {
    this.realtime =
      options.realtime ??
      new SqlRealtimeTransport(store, { pollMs: options.pollMs });
    this.heartbeat = setInterval(() => {
      this.track(
        (async () => {
          for (const room of this.rooms.values())
            for (const peer of room.peers) {
              try {
                await peer.check();
                if (peer.socket.readyState === 1) peer.socket.ping();
              } catch {
                peer.socket.close(1008, 'Session or membership expired');
              }
            }
          for (const peers of this.events.values())
            for (const peer of peers) {
              try {
                await peer.check();
                if (peer.socket.readyState === 1) peer.socket.ping();
              } catch {
                peer.socket.close(1008, 'Session or membership expired');
              }
            }
        })(),
      );
    }, 30000);
    this.heartbeat.unref();
  }
  async initialize() {
    await this.realtime.ready;
  }
  private track<T>(promise: Promise<T>) {
    this.background.add(promise);
    void promise
      .catch(() => {})
      .finally(() => this.background.delete(promise));
    return promise;
  }
  private async send(peer: ChannelPeer, data: Uint8Array | string) {
    if (peer.socket.readyState !== 1) return;
    const bytes =
      typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
    if (
      peer.queuedBytes + bytes > 8 * 1024 * 1024 ||
      peer.queuedFrames >= 64
    ) {
      peer.socket.close(
        1013,
        'Client is too far behind; reconnect to resync',
      );
      return;
    }
    peer.queuedBytes += bytes;
    peer.queuedFrames++;
    peer.outgoing = peer.outgoing
      .then(async () => {
        if (peer.socket.readyState !== 1) return;
        await peer.check();
        if (peer.socket.readyState !== 1) return;
        if (peer.socket.bufferedAmount > 8 * 1024 * 1024) {
          peer.socket.close(
            1013,
            'Client is too far behind; reconnect to resync',
          );
          return;
        }
        peer.socket.send(data);
      })
      .catch(() => {
        peer.socket.close(1008, 'Session or membership expired');
      })
      .finally(() => {
        peer.queuedBytes -= bytes;
        peer.queuedFrames--;
      });
    await peer.outgoing;
  }
  private async notifyLocal(projectId: string, artifactId?: string) {
    await Promise.all(
      [...(this.events.get(projectId) ?? [])].map((peer) =>
        this.send(peer, JSON.stringify({ type: 'changed', artifactId })),
      ),
    );
  }
  async notify(projectId: string, artifactId?: string) {
    await this.realtime.publish('project:' + projectId, {
      type: 'changed',
      projectId,
      ...(artifactId ? { artifactId } : {}),
    });
    await this.notifyLocal(projectId, artifactId);
  }
  /** SQL metadata only; safe to append inside an outer publication transaction. */
  async publishDocumentMetadata(projectId: string, artifactId: string) {
    await this.realtime.publish('artifact:' + artifactId, {
      type: 'document',
      projectId,
      artifactId,
    });
    await this.realtime.publish('project:' + projectId, {
      type: 'changed',
      projectId,
      artifactId,
    });
  }
  /** Call after the outer source transaction commits, never from an onPersist hook. */
  async refreshArtifact(id: string, userId: string) {
    const room = this.rooms.get(id);
    if (room) await this.serial(room, () => this.refresh(room, userId));
    const artifact = await this.store.artifact(id, userId);
    await this.notifyLocal(artifact.projectId, id);
  }
  private async documentPublished(room: Room) {
    await this.realtime.publish('artifact:' + room.id, {
      type: 'document',
      artifactId: room.id,
      projectId: room.projectId,
    });
    await this.realtime.publish('project:' + room.projectId, {
      type: 'changed',
      artifactId: room.id,
      projectId: room.projectId,
    });
  }
  private async serial<T>(
    room: Room,
    operation: () => Promise<T>,
  ): Promise<T> {
    clearTimeout(room.idle);
    room.pending++;
    const previous = room.queue;
    let release!: () => void;
    room.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      room.pending--;
      release();
      this.release(room);
    }
  }
  private release(room: Room) {
    if (room.peers.size || room.pending || room.idle) return;
    room.idle = setTimeout(() => {
      room.idle = undefined;
      if (room.peers.size || room.pending || this.rooms.get(room.id) !== room)
        return;
      this.rooms.delete(room.id);
      this.track(
        (async () => {
          await room.unsubscribe?.();
          room.awareness.destroy();
          room.doc.destroy();
        })(),
      );
    }, 0);
    room.idle.unref();
  }
  private async validPeer(room: Room) {
    for (const peer of room.peers) {
      try {
        await peer.check();
        return peer;
      } catch {
        peer.socket.close(1008, 'Session or membership expired');
      }
    }
    return undefined;
  }
  private async mergeDurable(
    room: Room,
    state: Uint8Array,
    broadcast = true,
  ) {
    const before = Y.encodeStateVector(room.doc);
    Y.applyUpdate(room.doc, state, 'durable');
    const delta = Y.encodeStateAsUpdate(room.doc, before);
    if (broadcast && delta.length > 2)
      await Promise.all(
        [...room.peers].map((peer) => this.send(peer, syncPacket(delta))),
      );
  }
  private async refresh(room: Room, userId?: string) {
    const peer = userId ? undefined : await this.validPeer(room);
    const reader = userId ?? peer?.user.id;
    if (!reader) return;
    const state = await this.store.documentState(room.id, reader);
    await this.mergeDurable(room, state);
  }
  private async presence(
    room: Room,
    changes: PresenceChange[],
    owner: PresenceOwner,
    publish: boolean,
  ) {
    const accepted: PresenceChange[] = [];
    for (const change of changes) {
      const existing = room.owners.get(change.client);
      if (
        existing &&
        existing.connectionId !== owner.connectionId &&
        existing.userId !== owner.userId &&
        existing.connectionId < owner.connectionId
      )
        continue;
      if (change.state === null) {
        if (!existing || existing.connectionId === owner.connectionId)
          room.owners.delete(change.client);
        else continue;
      } else room.owners.set(change.client, owner);
      accepted.push(change);
    }
    if (!accepted.length) return;
    awareness.applyAwarenessUpdate(
      room.awareness,
      awarenessBytes(accepted),
      owner,
    );
    if (publish)
      await this.realtime.publish('artifact:' + room.id, {
        type: 'presence',
        artifactId: room.id,
        owner,
        changes: accepted,
      });
  }
  private async remote(room: Room, message: RealtimeMessage) {
    if (
      message.createdAt < Date.now() - 60000 &&
      message.data.type === 'presence'
    )
      return;
    await this.serial(room, async () => {
      if (message.data.type === 'document' || message.data.type === 'reset')
        await this.refresh(room);
      if (
        message.data.type === 'presence' &&
        Array.isArray(message.data.changes) &&
        message.data.changes.length <= 10 &&
        typeof message.data.owner?.connectionId === 'string'
      ) {
        await this.presence(
          room,
          message.data.changes,
          message.data.owner,
          false,
        );
      }
      if (
        message.data.type === 'presence-request' ||
        message.data.type === 'reset'
      ) {
        for (const peer of room.peers) {
          try {
            await peer.check();
            const changes = [...peer.ids].flatMap((client) => {
              const state = room.awareness.getStates().get(client),
                metadata = room.awareness.meta.get(client);
              return state && metadata
                ? [{ client, clock: metadata.clock, state }]
                : [];
            });
            if (changes.length)
              await this.realtime.publish('artifact:' + room.id, {
                type: 'presence',
                artifactId: room.id,
                owner: {
                  connectionId: peer.id,
                  instanceId: this.realtime.instanceId,
                  userId: peer.user.id,
                },
                changes,
              });
          } catch {
            peer.socket.close(1008, 'Session or membership expired');
          }
        }
      }
    });
  }
  async room(id: string, userId: string): Promise<Room> {
    if (this.closed)
      throw new HttpError(503, 'Collaboration is shutting down');
    const existing = this.rooms.get(id);
    if (existing) {
      clearTimeout(existing.idle);
      existing.idle = undefined;
      return existing;
    }
    const pending = this.initializing.get(id);
    if (pending) return pending;
    if (this.rooms.size + this.initializing.size >= 64)
      throw new HttpError(
        429,
        'This collaboration instance is at its open-document capacity',
      );
    const initialization = (async () => {
      const artifact = await this.store.artifact(id, userId);
      if (artifact.kind !== 'design' && artifact.kind !== 'document')
        throw new HttpError(
          400,
          'This artifact uses a versioned media editor',
        );
      const state = await this.store.documentState(id, userId),
        doc = new Y.Doc();
      Y.applyUpdate(doc, state);
      const room: Room = {
        id,
        projectId: artifact.projectId,
        kind: artifact.kind,
        doc,
        awareness: new awareness.Awareness(doc),
        peers: new Set(),
        owners: new Map(),
        queue: Promise.resolve(),
        pending: 1,
      };
      room.awareness.setLocalState(null);
      room.awareness.on(
        'update',
        ({
          added,
          updated,
          removed,
        }: {
          added: number[];
          updated: number[];
          removed: number[];
        }) => {
          for (const client of removed)
            if (!room.awareness.getStates().has(client))
              room.owners.delete(client);
          const bytes = packet(1, (encoder) =>
            encoding.writeVarUint8Array(
              encoder,
              awareness.encodeAwarenessUpdate(room.awareness, [
                ...added,
                ...updated,
                ...removed,
              ]),
            ),
          );
          this.track(
            Promise.all(
              [...room.peers].map((peer) => this.send(peer, bytes)),
            ),
          );
        },
      );
      this.rooms.set(id, room);
      try {
        room.unsubscribe = await this.realtime.subscribe(
          'artifact:' + id,
          (message) => this.remote(room, message),
        );
        await this.serial(room, () => this.refresh(room, userId));
        await this.realtime.publish('artifact:' + id, {
          type: 'presence-request',
          artifactId: id,
        });
        room.pending--;
        return room;
      } catch (error) {
        this.rooms.delete(id);
        await room.unsubscribe?.();
        room.awareness.destroy();
        doc.destroy();
        throw error;
      }
    })();
    this.initializing.set(id, initialization);
    try {
      return await initialization;
    } finally {
      this.initializing.delete(id);
    }
  }
  async replace(
    id: string,
    user: User,
    content: Record<string, any>,
    version: number,
    onPersist?: () => void | Promise<void>,
  ) {
    const artifact = await this.store.artifact(id, user.id, 'write');
    const validated = validateContent(artifact.kind, content),
      schema = editorSchema(),
      next = schema.nodeFromJSON(validated.doc);
    next.check();
    const room = await this.room(id, user.id);
    return this.serial(room, async () => {
      await this.refresh(room, user.id);
      const candidate = new Y.Doc();
      try {
        Y.applyUpdate(candidate, Y.encodeStateAsUpdate(room.doc));
        candidate.transact(
          () =>
            prosemirrorToYXmlFragment(
              next,
              candidate.getXmlFragment('default'),
            ),
          'server',
        );
        const state = Y.encodeStateAsUpdate(candidate);
        if (state.length > 4 * 1024 * 1024)
          throw new HttpError(400, 'Document is too large');
        const persisted = validateContent(artifact.kind, {
          doc: yXmlFragmentToProsemirrorJSON(
            candidate.getXmlFragment('default'),
          ),
        });
        schema.nodeFromJSON(persisted.doc).check();
        const committed = await this.store.persistDoc(
          user,
          id,
          state,
          persisted,
          async () => {
            await onPersist?.();
            await this.documentPublished(room);
          },
          version,
        );
        await this.mergeDurable(room, committed.state);
        await this.notifyLocal(room.projectId, id);
        return committed.artifact;
      } finally {
        candidate.destroy();
      }
    });
  }
  private async consume(room: Room, peer: Peer, bytes: Uint8Array) {
    await peer.check();
    await this.serial(room, async () => {
      await this.refresh(room, peer.user.id);
      const decoder = decoding.createDecoder(bytes),
        type = decoding.readVarUint(decoder);
      if (type === 0) {
        const subtype = decoding.readVarUint(decoder);
        if (subtype === 0) {
          const response = packet(0, (encoder) =>
            sync.readSyncStep1(decoder, encoder, room.doc),
          );
          await this.send(peer, response);
        } else if (subtype === 1 || subtype === 2) {
          const update = decoding.readVarUint8Array(decoder),
            candidate = new Y.Doc();
          try {
            const current = Y.encodeStateAsUpdate(room.doc);
            Y.applyUpdate(candidate, current);
            Y.applyUpdate(candidate, update);
            const state = Y.encodeStateAsUpdate(candidate);
            if (state.length > 4 * 1024 * 1024)
              throw new Error('Document is too large');
            if (Buffer.from(state).equals(Buffer.from(current))) return;
            await this.store.role(room.projectId, peer.user.id, 'write');
            const content = validateContent(room.kind, {
              doc: yXmlFragmentToProsemirrorJSON(
                candidate.getXmlFragment('default'),
              ),
            });
            editorSchema().nodeFromJSON(content.doc).check();
            const committed = await this.store.persistDoc(
              peer.user,
              room.id,
              state,
              content,
              () => this.documentPublished(room),
            );
            await this.mergeDurable(room, committed.state);
            await this.notifyLocal(room.projectId, room.id);
          } finally {
            candidate.destroy();
          }
        } else throw new Error('Invalid sync message');
      } else if (type === 1) {
        const raw = decoding.readVarUint8Array(decoder);
        if (raw.length > 128 * 1024) throw new Error('Presence is too large');
        const input = decoding.createDecoder(raw),
          count = decoding.readVarUint(input);
        if (count > 1000)
          throw new Error('Too many echoed presence identities');
        const changes: PresenceChange[] = [];
        for (let index = 0; index < count; index++) {
          const client = decoding.readVarUint(input),
            clock = decoding.readVarUint(input),
            source = decoding.readVarString(input);
          const owner = room.owners.get(client);
          if (owner && owner.connectionId !== peer.id) continue;
          const state = JSON.parse(source);
          if (
            state !== null &&
            (typeof state !== 'object' || Array.isArray(state))
          )
            throw new Error('Invalid presence state');
          if (state) peer.ids.add(client);
          else peer.ids.delete(client);
          changes.push({
            client,
            clock,
            state: state
              ? {
                  ...state,
                  user: {
                    id: peer.user.id,
                    name: peer.user.name,
                    color: peer.user.color,
                  },
                }
              : null,
          });
        }
        if (changes.length > 10 || awarenessBytes(changes).byteLength > 8192)
          throw new Error(
            'Too many owned presence identities or oversized state',
          );
        await this.presence(
          room,
          changes,
          {
            connectionId: peer.id,
            instanceId: this.realtime.instanceId,
            userId: peer.user.id,
          },
          true,
        );
      } else throw new Error('Invalid collaboration message');
    });
  }
  private check(
    request: FastifyRequest,
    user: User,
    projectId: string,
    artifactId?: string,
  ) {
    return async () => {
      const current = await this.auth.user(request);
      if (current.id !== user.id)
        throw new HttpError(401, 'The session identity changed');
      if (artifactId) await this.store.artifact(artifactId, user.id);
      else await this.store.role(projectId, user.id);
    };
  }
  routes(app: FastifyInstance) {
    app.get<{ Params: { id: string } }>(
      '/api/projects/:id/events',
      { websocket: true },
      (socket, request) => {
        let peer: ChannelPeer | undefined,
          group: Set<ChannelPeer> | undefined,
          disconnected = false;
        socket.on('message', () =>
          socket.close(1008, 'This notification connection is read-only'),
        );
        socket.on('error', () => socket.close());
        socket.on('close', () => {
          disconnected = true;
          if (peer && group) {
            group.delete(peer);
            if (!group.size) {
              this.events.delete(request.params.id);
              const subscription = this.projectSubscriptions.get(
                request.params.id,
              );
              this.projectSubscriptions.delete(request.params.id);
              if (subscription)
                this.track(subscription.then((unsubscribe) => unsubscribe()));
            }
          }
        });
        this.track(
          (async () => {
            try {
              this.auth.assertOrigin(request);
              const user = await this.auth.user(request),
                projectId = request.params.id;
              await this.store.role(projectId, user.id);
              if (disconnected || this.closed) return socket.close(1001);
              group = this.events.get(projectId);
              if (!group) {
                group = new Set();
                this.events.set(projectId, group);
              }
              peer = {
                socket,
                check: this.check(request, user, projectId),
                outgoing: Promise.resolve(),
                queuedBytes: 0,
                queuedFrames: 0,
              };
              group.add(peer);
              if (!this.projectSubscriptions.has(projectId))
                this.projectSubscriptions.set(
                  projectId,
                  this.realtime.subscribe(
                    'project:' + projectId,
                    async (message) => {
                      await this.notifyLocal(
                        projectId,
                        message.data.artifactId,
                      );
                      for (const room of this.rooms.values())
                        if (room.projectId === projectId)
                          await this.validPeer(room);
                    },
                  ),
                );
              await this.projectSubscriptions.get(projectId);
              // Close the gap between the browser's initial HTTP read and its subscription.
              await this.send(peer, JSON.stringify({ type: 'changed' }));
            } catch {
              socket.close(1008, 'Access denied');
            }
          })(),
        );
      },
    );
    app.get<{ Params: { id: string } }>(
      '/api/collaboration/:id',
      { websocket: true },
      (socket, request) => {
        let room: Room | undefined,
          peer: Peer | undefined,
          initialized = false,
          disconnected = false,
          draining = false;
        const queued: Uint8Array[] = [];
        let queuedBytes = 0,
          burst = 0,
          windowStart = Date.now();
        const drain = async () => {
          if (draining || !initialized || !room || !peer) return;
          draining = true;
          try {
            while (!disconnected && queued.length) {
              const bytes = queued.shift()!;
              queuedBytes -= bytes.byteLength;
              await this.consume(room, peer, bytes);
            }
          } catch {
            socket.close(1008, 'Update rejected; reload to reconnect');
          } finally {
            draining = false;
          }
        };
        // Install the bounded queue before the first awaited authentication call.
        socket.on('message', (raw: RawData) => {
          const bytes = new Uint8Array(
            Array.isArray(raw)
              ? Buffer.concat(raw)
              : raw instanceof ArrayBuffer
                ? raw
                : (raw as Buffer),
          );
          if (Date.now() - windowStart > 1000) {
            windowStart = Date.now();
            burst = 0;
          }
          if (
            ++burst > 100 ||
            bytes.byteLength > 1024 * 1024 ||
            queuedBytes + bytes.byteLength > 2 * 1024 * 1024 ||
            queued.length >= 32
          ) {
            socket.close(
              1013,
              'Too many pending updates; reconnect to resync',
            );
            return;
          }
          queued.push(bytes);
          queuedBytes += bytes.byteLength;
          this.track(drain());
        });
        socket.on('error', () => socket.close());
        socket.on('close', () => {
          disconnected = true;
          queued.length = 0;
          queuedBytes = 0;
          if (room && peer) {
            const target = room,
              closedPeer = peer;
            target.peers.delete(closedPeer);
            this.track(
              this.serial(target, async () => {
                const changes = [...closedPeer.ids].map((client) => ({
                  client,
                  clock: (target.awareness.meta.get(client)?.clock ?? 0) + 1,
                  state: null,
                }));
                await this.presence(
                  target,
                  changes,
                  {
                    connectionId: closedPeer.id,
                    instanceId: this.realtime.instanceId,
                    userId: closedPeer.user.id,
                  },
                  true,
                );
              }),
            );
          }
        });
        this.track(
          (async () => {
            try {
              this.auth.assertOrigin(request);
              const user = await this.auth.user(request),
                id = request.params.id,
                artifact = await this.store.artifact(id, user.id);
              if (disconnected || this.closed) return socket.close(1001);
              room = await this.room(id, user.id);
              if (disconnected || this.closed) {
                this.release(room);
                return socket.close(1001);
              }
              if (room.peers.size >= 100)
                throw new HttpError(
                  429,
                  'Document is at its participant limit',
                );
              peer = {
                id: randomUUID(),
                socket,
                user,
                ids: new Set(),
                check: this.check(request, user, artifact.projectId, id),
                outgoing: Promise.resolve(),
                queuedBytes: 0,
                queuedFrames: 0,
              };
              clearTimeout(room.idle);
              room.idle = undefined;
              room.peers.add(peer);
              await this.send(
                peer,
                packet(0, (encoder) =>
                  sync.writeSyncStep1(encoder, room!.doc),
                ),
              );
              if (room.awareness.getStates().size)
                await this.send(
                  peer,
                  packet(1, (encoder) =>
                    encoding.writeVarUint8Array(
                      encoder,
                      awareness.encodeAwarenessUpdate(room!.awareness, [
                        ...room!.awareness.getStates().keys(),
                      ]),
                    ),
                  ),
                );
              initialized = true;
              await drain();
            } catch {
              if (room && !peer) this.release(room);
              socket.close(1008, 'Access denied');
            }
          })(),
        );
      },
    );
  }
  async close() {
    this.closed = true;
    clearInterval(this.heartbeat);
    for (const room of this.rooms.values())
      for (const peer of room.peers)
        peer.socket.close(1001, 'Server shutting down');
    for (const group of this.events.values())
      for (const peer of group) peer.socket.close(1001);
    await Promise.allSettled([
      ...this.initializing.values(),
      ...this.background,
    ]);
    for (const room of this.rooms.values()) {
      clearTimeout(room.idle);
      await room.queue;
      await room.unsubscribe?.();
      room.awareness.destroy();
      room.doc.destroy();
    }
    for (const subscription of this.projectSubscriptions.values())
      await (
        await subscription
      )();
    await this.realtime.close();
    this.rooms.clear();
    this.events.clear();
    this.projectSubscriptions.clear();
  }
}
