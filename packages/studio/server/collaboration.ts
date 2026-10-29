import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as sync from 'y-protocols/sync';
import * as awareness from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import {
  prosemirrorJSONToYDoc,
  prosemirrorToYXmlFragment,
  yXmlFragmentToProsemirrorJSON,
} from 'y-prosemirror';
import { editorSchema } from '../shared/editor.ts';
import { validateContent, type User } from '../shared/domain.ts';
import { HttpError, type Store } from './store.ts';
import type { Auth } from './auth.ts';

type Peer = {
  socket: WebSocket;
  user: User;
  ids: Set<number>;
  check: () => void;
};
type Room = { doc: Y.Doc; awareness: awareness.Awareness; peers: Set<Peer> };
export class Collaboration {
  rooms = new Map<string, Room>();
  events = new Map<string, Set<{ socket: WebSocket; check: () => void }>>();
  heartbeat: ReturnType<typeof setInterval>;
  constructor(
    readonly store: Store,
    readonly auth: Auth,
  ) {
    this.heartbeat = setInterval(() => {
      for (const room of this.rooms.values())
        for (const p of room.peers)
          try {
            p.check();
            p.socket.ping();
          } catch {
            p.socket.close(1008, 'Session or membership expired');
          }
      for (const group of this.events.values())
        for (const p of group)
          try {
            p.check();
            p.socket.ping();
          } catch {
            p.socket.close(1008, 'Session or membership expired');
          }
    }, 30000);
    this.heartbeat.unref();
  }
  notify(projectId: string, artifactId?: string) {
    for (const p of this.events.get(projectId) ?? [])
      if (p.socket.readyState === 1) {
        try {
          p.check();
          p.socket.send(JSON.stringify({ type: 'changed', artifactId }));
        } catch {
          p.socket.close(1008);
        }
      }
  }
  private send(peer: Peer, bytes: Uint8Array) {
    if (peer.socket.readyState !== 1) return;
    try {
      peer.check();
      if (peer.socket.bufferedAmount > 4 * 1024 * 1024) {
        peer.socket.close(
          1013,
          'Client is too far behind; reconnect to resync',
        );
        return;
      }
      peer.socket.send(bytes);
    } catch {
      peer.socket.close(1008, 'Session or membership expired');
    }
  }
  room(id: string, userId: string): Room {
    let room = this.rooms.get(id);
    if (room) return room;
    const a = this.store.artifact(id, userId);
    if (a.kind !== 'design' && a.kind !== 'document')
      throw new HttpError(400, 'This artifact uses a versioned media editor');
    const persisted = this.store.state(id);
    const doc = persisted
      ? new Y.Doc()
      : prosemirrorJSONToYDoc(editorSchema(), a.content.doc, 'default');
    if (persisted) Y.applyUpdate(doc, persisted);
    else
      this.store.exec(
        'UPDATE artifacts SET ystate=? WHERE id=?',
        Y.encodeStateAsUpdate(doc),
        id,
      );
    room = { doc, awareness: new awareness.Awareness(doc), peers: new Set() };
    room.awareness.setLocalState(null);
    room.awareness.on(
      'update',
      (
        {
          added,
          updated,
          removed,
        }: { added: number[]; updated: number[]; removed: number[] },
        origin: Peer | null,
      ) => {
        if (origin && typeof origin === 'object' && origin.ids instanceof Set) {
          added.forEach((n) => origin.ids.add(n));
          removed.forEach((n) => origin.ids.delete(n));
        }
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, 1);
        encoding.writeVarUint8Array(
          e,
          awareness.encodeAwarenessUpdate(room!.awareness, [
            ...added,
            ...updated,
            ...removed,
          ]),
        );
        for (const p of room!.peers) this.send(p, encoding.toUint8Array(e));
      },
    );
    this.rooms.set(id, room);
    return room;
  }
  replace(
    id: string,
    user: User,
    content: Record<string, any>,
    version: number,
  ) {
    const a = this.store.artifact(id, user.id, 'write');
    if (a.version !== version)
      throw new HttpError(
        409,
        'The document changed. Review the latest version before applying.',
      );
    const validated = validateContent(a.kind, content),
      schema = editorSchema(),
      next = schema.nodeFromJSON(validated.doc);
    next.check();
    const room = this.room(id, user.id),
      before = Y.encodeStateVector(room.doc),
      candidate = new Y.Doc();
    try {
      // A failed validation or storage operation must leave connected editors on
      // the durable document. Build and persist a candidate before touching it.
      Y.applyUpdate(candidate, Y.encodeStateAsUpdate(room.doc));
      candidate.transact(
        () =>
          prosemirrorToYXmlFragment(next, candidate.getXmlFragment('default')),
        'server',
      );
      const state = Y.encodeStateAsUpdate(candidate);
      if (state.length > 4 * 1024 * 1024)
        throw new HttpError(400, 'Document is too large');
      const persisted = validateContent(a.kind, {
        doc: yXmlFragmentToProsemirrorJSON(candidate.getXmlFragment('default')),
      });
      schema.nodeFromJSON(persisted.doc).check();
      this.store.persistDoc(user, id, state, persisted);
      const update = Y.encodeStateAsUpdate(candidate, before);
      Y.applyUpdate(room.doc, update, 'server');
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, 0);
      sync.writeUpdate(e, update);
      for (const p of room.peers) this.send(p, encoding.toUint8Array(e));
      this.notify(a.projectId, id);
      return this.store.artifact(id, user.id);
    } finally {
      candidate.destroy();
      if (!room.peers.size) {
        room.awareness.destroy();
        room.doc.destroy();
        this.rooms.delete(id);
      }
    }
  }
  routes(app: FastifyInstance) {
    app.get<{ Params: { id: string } }>(
      '/api/projects/:id/events',
      { websocket: true },
      (socket, req) => {
        try {
          this.auth.assertOrigin(req);
          const user = this.auth.user(req),
            id = req.params.id;
          this.store.role(id, user.id);
          let group = this.events.get(id);
          if (!group) {
            group = new Set();
            this.events.set(id, group);
          }
          const p = {
            socket,
            check: () => {
              this.auth.user(req);
              this.store.role(id, user.id);
            },
          };
          group.add(p);
          socket.on('close', () => {
            group!.delete(p);
            if (group!.size === 0) this.events.delete(id);
          });
          socket.on('error', () => socket.close());
        } catch {
          socket.close(1008, 'Access denied');
        }
      },
    );
    app.get<{ Params: { id: string } }>(
      '/api/collaboration/:id',
      { websocket: true },
      (socket, req) => {
        let room: Room | undefined, peer: Peer | undefined;
        try {
          this.auth.assertOrigin(req);
          const user = this.auth.user(req),
            id = req.params.id;
          const a = this.store.artifact(id, user.id);
          room = this.room(id, user.id);
          if (room.peers.size >= 100)
            throw new HttpError(429, 'Document is at its participant limit');
          peer = {
            socket,
            user,
            ids: new Set(),
            check: () => {
              this.auth.user(req);
              this.store.artifact(id, user.id);
            },
          };
          room.peers.add(peer);
          const e = encoding.createEncoder();
          encoding.writeVarUint(e, 0);
          sync.writeSyncStep1(e, room.doc);
          socket.send(encoding.toUint8Array(e));
          if (room.awareness.getStates().size) {
            const a = encoding.createEncoder();
            encoding.writeVarUint(a, 1);
            encoding.writeVarUint8Array(
              a,
              awareness.encodeAwarenessUpdate(room.awareness, [
                ...room.awareness.getStates().keys(),
              ]),
            );
            socket.send(encoding.toUint8Array(a));
          }
          let burst = 0;
          let window = Date.now();
          socket.on('message', (raw) => {
            try {
              peer!.check();
              if (Date.now() - window > 1000) {
                window = Date.now();
                burst = 0;
              }
              if (++burst > 100) throw new Error('Too many updates');
              const data = new Uint8Array(raw as Buffer);
              if (data.length > 1024 * 1024)
                throw new Error('Update is too large');
              const d = decoding.createDecoder(data),
                type = decoding.readVarUint(d);
              if (type === 0) {
                const subtype = decoding.readVarUint(d);
                if (subtype === 0) {
                  const out = encoding.createEncoder();
                  encoding.writeVarUint(out, 0);
                  sync.readSyncStep1(d, out, room!.doc);
                  socket.send(encoding.toUint8Array(out));
                } else if (subtype === 1 || subtype === 2) {
                  const update = decoding.readVarUint8Array(d),
                    candidate = new Y.Doc();
                  try {
                    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(room!.doc));
                    Y.applyUpdate(candidate, update);
                    const state = Y.encodeStateAsUpdate(candidate);
                    if (state.length > 4 * 1024 * 1024)
                      throw new Error('Document is too large');
                    if (
                      Buffer.from(state).equals(
                        Buffer.from(Y.encodeStateAsUpdate(room!.doc)),
                      )
                    )
                      return;
                    this.store.role(a.projectId, user.id, 'write');
                    const content = validateContent(a.kind, {
                      doc: yXmlFragmentToProsemirrorJSON(
                        candidate.getXmlFragment('default'),
                      ),
                    });
                    // Validate against the actual editor schema, then persist before acknowledging/broadcasting.
                    editorSchema().nodeFromJSON(content.doc).check();
                    this.store.persistDoc(user, id, state, content);
                    Y.applyUpdate(room!.doc, update, peer);
                    const out = encoding.createEncoder();
                    encoding.writeVarUint(out, 0);
                    sync.writeUpdate(out, update);
                    for (const p of room!.peers)
                      if (p !== peer) this.send(p, encoding.toUint8Array(out));
                    this.notify(a.projectId, id);
                  } finally {
                    candidate.destroy();
                  }
                } else throw new Error('Invalid sync message');
              } else if (type === 1) {
                const update = decoding.readVarUint8Array(d);
                if (update.length > 8192)
                  throw new Error('Presence is too large');
                // Presence names and colors come from the authenticated identity, never a spoofable client label.
                const input = decoding.createDecoder(update),
                  count = decoding.readVarUint(input);
                if (count > 10) throw new Error('Too many presence identities');
                const owned: {
                  client: number;
                  clock: number;
                  state: unknown;
                }[] = [];
                for (let i = 0; i < count; i++) {
                  const client = decoding.readVarUint(input),
                    clock = decoding.readVarUint(input),
                    state = JSON.parse(decoding.readVarString(input));
                  // y-websocket forwards awareness it received from other peers. Ignore
                  // those echoes: changing their identity or closing the forwarding
                  // connection would spoof attribution or disconnect honest clients.
                  const owner = [...room!.peers].find(
                    (p) => p !== peer && p.ids.has(client),
                  );
                  if (owner) continue;
                  owned.push({
                    client,
                    clock,
                    state: state
                      ? {
                          ...state,
                          user: {
                            name: user.name,
                            color: user.color,
                            id: user.id,
                          },
                        }
                      : null,
                  });
                }
                const out = encoding.createEncoder();
                encoding.writeVarUint(out, owned.length);
                for (const { client, clock, state } of owned) {
                  encoding.writeVarUint(out, client);
                  encoding.writeVarUint(out, clock);
                  encoding.writeVarString(out, JSON.stringify(state));
                }
                awareness.applyAwarenessUpdate(
                  room!.awareness,
                  encoding.toUint8Array(out),
                  peer,
                );
              } else throw new Error('Invalid collaboration message');
            } catch {
              socket.close(1008, 'Update rejected; reload to reconnect');
            }
          });
        } catch {
          socket.close(1008, 'Access denied');
        }
        socket.on('close', () => {
          if (room && peer) {
            awareness.removeAwarenessStates(
              room.awareness,
              [...peer.ids],
              null,
            );
            room.peers.delete(peer);
            if (!room.peers.size) {
              room.awareness.destroy();
              room.doc.destroy();
              this.rooms.delete(req.params.id);
            }
          }
        });
        socket.on('error', () => socket.close());
      },
    );
  }
  close() {
    clearInterval(this.heartbeat);
    for (const r of this.rooms.values()) {
      for (const p of r.peers) p.socket.close(1001, 'Server shutting down');
      r.awareness.destroy();
      r.doc.destroy();
    }
    for (const g of this.events.values())
      for (const p of g) p.socket.close(1001);
    this.rooms.clear();
    this.events.clear();
  }
}
