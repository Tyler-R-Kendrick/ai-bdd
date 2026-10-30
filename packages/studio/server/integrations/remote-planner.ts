import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { User } from '../../shared/domain.ts';
import type { Settings } from '../auth.ts';
import { HttpError, type Store } from '../store.ts';
import type { DurableJobContext } from '../runtime/contracts.ts';
import { RepositoryReader } from './repository.ts';

export type RemoteTurn = {
  artifactId: string;
  threadId: string;
  intent: 'chat' | 'edit' | 'research';
  context: string;
  brief: string;
  sources: unknown[];
  repository: string;
  revision?: string;
};
export type PlannerOutput = {
  text: string;
  content: Record<string, unknown> | null;
};
const outputSchema = z
  .object({
    text: z.string().max(50000),
    content: z.record(z.string(), z.json()).nullable(),
  })
  .strict();
const incoming = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('attach'),
      version: z.literal(1),
      artifactId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      type: z.literal('result'),
      requestId: z.string(),
      output: outputSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('tool'),
      requestId: z.string(),
      callId: z.string().max(100),
      name: z.enum([
        'repository_tree',
        'repository_file',
        'repository_pull_request',
      ]),
      input: z.record(z.string(), z.json()),
    })
    .strict(),
  z.object({ type: z.literal('ping') }).strict(),
]);
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');

/** Versioned remote model transport. The server retains source authorization, read-only tools, leases and final publication. */
export class RemotePlanner {
  constructor(
    readonly options: {
      store: Store;
      settings: Settings;
      authenticate: (request: FastifyRequest) => Promise<User>;
      claim: (user: User, id: string) => Promise<void>;
      allowed: (user: User, id: string) => Promise<boolean>;
      pollMs?: number;
    },
  ) {}
  private readonly sockets = new Set<WebSocket>();
  async initialize() {
    await this.options.store.tx(async () => {
      await this.options.store.db.lock('schema:studio.remote-planner');
      await this.options.store.db
        .exec(`CREATE TABLE IF NOT EXISTS studio_remote_planners(artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),connection_id TEXT NOT NULL,epoch BIGINT NOT NULL,expires BIGINT NOT NULL);
   CREATE TABLE IF NOT EXISTS studio_remote_requests(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES studio_durable_jobs(id) ON DELETE CASCADE,fence BIGINT NOT NULL,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),input_json TEXT NOT NULL,input_sha256 TEXT NOT NULL,status TEXT NOT NULL,output_json TEXT,created_at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS studio_remote_pending ON studio_remote_requests(artifact_id,status,created_at);`);
    });
  }
  register(app: FastifyInstance) {
    app.get(
      '/api/planner/connect',
      { websocket: true },
      (socket, request) => {
        void this.connect(socket, request);
      },
    );
  }
  async invoke(
    ctx: DurableJobContext,
    turn: RemoteTurn,
    key: string,
  ): Promise<PlannerOutput> {
    const source = JSON.stringify(turn);
    if (Buffer.byteLength(source) > 400000)
      throw new HttpError(
        413,
        'Remote Planner input exceeds the bounded context limit',
      );
    const id = digest(key + ':' + ctx.fence),
      store = this.options.store;
    await ctx.assertCurrent({ requireCurrentVersion: false });
    const attached = await store.one(
      'SELECT user_id,expires FROM studio_remote_planners WHERE artifact_id=?',
      turn.artifactId,
    );
    if (
      !attached ||
      attached.user_id !== ctx.job.principalId ||
      Number(attached.expires) <= Date.now()
    )
      throw new HttpError(
        503,
        'No eligible remote Planner is attached. Connect the Planner client and retry this durable request.',
      );
    await store.tx(async () => {
      await store.db.lock('project:' + ctx.job.projectId);
      await ctx.assertCurrent({ requireCurrentVersion: false });
      await store.exec(
        "INSERT INTO studio_remote_requests(id,job_id,fence,artifact_id,user_id,input_json,input_sha256,status,created_at) VALUES(?,?,?,?,?,?,?,'pending',?) ON CONFLICT(id) DO NOTHING",
        id,
        ctx.job.id,
        ctx.fence,
        turn.artifactId,
        ctx.job.principalId,
        source,
        digest(source),
        new Date().toISOString(),
      );
    });
    while (true) {
      await ctx.assertCurrent({ requireCurrentVersion: false });
      ctx.signal.throwIfAborted();
      const row = await store.one(
        'SELECT status,output_json,input_sha256 FROM studio_remote_requests WHERE id=?',
        id,
      );
      if (!row || row.input_sha256 !== digest(source))
        throw new HttpError(409, 'Remote Planner request integrity changed');
      if (row.status === 'completed')
        return outputSchema.parse(JSON.parse(row.output_json));
      if (row.status === 'cancelled')
        throw new HttpError(409, 'Remote Planner request was cancelled');
      await delay(this.options.pollMs ?? 100, undefined, {
        signal: ctx.signal,
      });
    }
  }
  private async connect(socket: WebSocket, request: FastifyRequest) {
    this.sockets.add(socket);
    let peer:
      | {
          user: User;
          artifactId: string;
          connectionId: string;
          epoch: number;
        }
      | undefined;
    let queuedBytes = 0,
      frames = 0,
      closed = false,
      working = Promise.resolve();
    const inbox: { data: Buffer; binary: boolean }[] = [];
    let ready = false,
      draining = false,
      timer: ReturnType<typeof setInterval> | undefined,
      polling = false;
    const sent = new Set<string>();
    const store = this.options.store;
    const check = async () => {
      if (!peer) throw new HttpError(401, 'Attach a Planner first');
      const currentUser = await this.options.authenticate(request);
      if (currentUser.id !== peer.user.id)
        throw new HttpError(401, 'Planner authentication changed');
      await store.artifact(peer.artifactId, peer.user.id, 'write');
      if (!(await this.options.allowed(peer.user, peer.artifactId)))
        throw new HttpError(
          403,
          'Planner ownership, pause or implementation state prevents this turn',
        );
      const row = await store.one(
        'SELECT * FROM studio_remote_planners WHERE artifact_id=?',
        peer.artifactId,
      );
      if (
        !row ||
        row.connection_id !== peer.connectionId ||
        Number(row.epoch) !== peer.epoch ||
        Number(row.expires) <= Date.now()
      )
        throw new HttpError(
          409,
          'Remote Planner connection was superseded or expired',
        );
    };
    const send = async (value: unknown) => {
      await check();
      const data = JSON.stringify(value);
      if (
        Buffer.byteLength(data) > 512000 ||
        socket.bufferedAmount > 1024 * 1024
      )
        throw new HttpError(429, 'Remote Planner output queue is full');
      if (socket.readyState === 1) socket.send(data);
    };
    const requestRow = async (id: string) => {
      await check();
      const row = await store.one(
        'SELECT r.*,j.status AS job_status,j.fence AS job_fence,j.lease_expires,j.project_id FROM studio_remote_requests r JOIN studio_durable_jobs j ON j.id=r.job_id WHERE r.id=? AND r.artifact_id=? AND r.user_id=?',
        id,
        peer!.artifactId,
        peer!.user.id,
      );
      if (
        !row ||
        row.job_status !== 'running' ||
        Number(row.fence) !== Number(row.job_fence) ||
        Number(row.lease_expires) <= Date.now()
      )
        throw new HttpError(
          409,
          'Remote Planner request lost its execution lease',
        );
      if (digest(row.input_json) !== row.input_sha256)
        throw new HttpError(409, 'Remote Planner input integrity changed');
      return row;
    };
    const consume = async (data: Buffer, binary: boolean) => {
      if (binary)
        throw new HttpError(400, 'Remote Planner uses JSON text frames');
      const message = incoming.parse(JSON.parse(data.toString()));
      if (message.type === 'attach') {
        if (peer)
          throw new HttpError(409, 'This connection is already attached');
        const user = await this.options.authenticate(request),
          artifact = await store.artifact(
            message.artifactId,
            user.id,
            'write',
          );
        await store.tx(async () => {
          await store.db.lock('project:' + artifact.projectId);
          await store.artifact(artifact.id, user.id, 'write');
          await this.options.claim(user, artifact.id);
          const previous = await store.one(
            'SELECT epoch FROM studio_remote_planners WHERE artifact_id=?',
            artifact.id,
          );
          peer = {
            user,
            artifactId: artifact.id,
            connectionId: randomUUID(),
            epoch: Number(previous?.epoch ?? 0) + 1,
          };
          await store.exec(
            'INSERT INTO studio_remote_planners VALUES(?,?,?,?,?) ON CONFLICT(artifact_id) DO UPDATE SET user_id=excluded.user_id,connection_id=excluded.connection_id,epoch=excluded.epoch,expires=excluded.expires',
            artifact.id,
            user.id,
            peer.connectionId,
            peer.epoch,
            Date.now() + 30000,
          );
        });
        await send({
          type: 'attached',
          version: 1,
          artifact: { id: artifact.id, title: artifact.title },
          tools: [
            'repository_tree',
            'repository_file',
            'repository_pull_request',
          ],
        });
        return;
      }
      await check();
      if (message.type === 'ping') {
        await send({ type: 'pong' });
        return;
      }
      const row = await requestRow(message.requestId);
      if (message.type === 'result') {
        if (row.status === 'completed') {
          if (row.output_json !== JSON.stringify(message.output))
            throw new HttpError(
              409,
              'This request already has a different result',
            );
        } else
          await store.tx(async () => {
            await store.db.lock('project:' + row.project_id);
            await store.db.lock('job:' + row.job_id);
            await requestRow(row.id);
            if (Buffer.byteLength(JSON.stringify(message.output)) > 400000)
              throw new HttpError(
                413,
                'Remote Planner output exceeds its limit',
              );
            await store.exec(
              "UPDATE studio_remote_requests SET status='completed',output_json=? WHERE id=? AND status='pending'",
              JSON.stringify(message.output),
              row.id,
            );
          });
        await send({ type: 'result-accepted', requestId: row.id });
        return;
      }
      const turn = JSON.parse(row.input_json) as RemoteTurn;
      if (!turn.repository || !turn.revision)
        throw new HttpError(
          409,
          'This turn has no captured repository revision',
        );
      const reader = new RepositoryReader(
        turn.repository,
        this.options.settings,
        () => requestRow(row.id),
        AbortSignal.timeout(30000),
      );
      reader.pin(turn.revision);
      const value =
        message.name === 'repository_tree'
          ? await reader.tree()
          : message.name === 'repository_file'
            ? await reader.file(z.string().max(500).parse(message.input.path))
            : await reader.pullRequest(
                z.number().int().positive().parse(message.input.number),
              );
      await send({
        type: 'tool-result',
        requestId: row.id,
        callId: message.callId,
        value,
      });
    };
    const drain = () => {
      if (!ready || draining) return;
      draining = true;
      working = working
        .then(async () => {
          while (inbox.length && !closed) {
            const next = inbox.shift()!;
            queuedBytes -= next.data.length;
            frames--;
            await consume(next.data, next.binary);
          }
        })
        .catch(() => {
          socket.close(
            4403,
            'Planner frame rejected; check access and protocol',
          );
        })
        .finally(() => {
          draining = false;
          if (inbox.length && !closed) drain();
        });
    };
    // Install bounded input handling before any awaited authentication or source access.
    socket.on('message', (raw, binary) => {
      const data = Buffer.isBuffer(raw)
        ? raw
        : Array.isArray(raw)
          ? Buffer.concat(raw)
          : Buffer.from(raw);
      const size = data.length;
      if (size > 512000 || (queuedBytes += size) > 1024000 || ++frames > 32) {
        socket.close(1009, 'Planner input queue limit exceeded');
        return;
      }
      inbox.push({ data, binary });
      drain();
    });
    socket.on('close', () => {
      closed = true;
      this.sockets.delete(socket);
      clearInterval(timer);
      if (peer)
        void store
          .exec(
            'UPDATE studio_remote_planners SET expires=0 WHERE artifact_id=? AND connection_id=? AND epoch=?',
            peer.artifactId,
            peer.connectionId,
            peer.epoch,
          )
          .catch(() => {});
    });
    try {
      const origin = request.headers.origin;
      if (origin && origin !== this.options.settings.origin)
        throw new HttpError(403, 'Foreign Planner origin');
      if (
        !(request.headers['sec-websocket-protocol'] ?? '')
          .split(',')
          .map((v) => v.trim())
          .includes('studio.planner.v1')
      )
        throw new HttpError(426, 'Offer studio.planner.v1');
      await this.options.authenticate(request);
      ready = true;
      drain();
      timer = setInterval(() => {
        if (polling || !peer || closed) return;
        polling = true;
        void (async () => {
          await check();
          await store.exec(
            'UPDATE studio_remote_planners SET expires=? WHERE artifact_id=? AND connection_id=? AND epoch=?',
            Date.now() + 30000,
            peer!.artifactId,
            peer!.connectionId,
            peer!.epoch,
          );
          const rows = await store.all(
            "SELECT r.id,r.input_json,r.input_sha256 FROM studio_remote_requests r JOIN studio_durable_jobs j ON j.id=r.job_id WHERE r.artifact_id=? AND r.user_id=? AND r.status='pending' AND j.status='running' AND j.fence=r.fence AND j.lease_expires>? ORDER BY r.created_at LIMIT 4",
            peer!.artifactId,
            peer!.user.id,
            Date.now(),
          );
          for (const row of rows)
            if (!sent.has(row.id)) {
              await requestRow(row.id);
              await send({
                type: 'turn',
                requestId: row.id,
                input: JSON.parse(row.input_json),
              });
              sent.add(row.id);
            }
        })()
          .catch(() =>
            socket.close(4403, 'Planner access or ownership changed'),
          )
          .finally(() => {
            polling = false;
          });
      }, this.options.pollMs ?? 250);
      timer.unref();
    } catch {
      socket.close(4401, 'Planner authentication or protocol failed');
    }
  }
  async close() {
    for (const socket of this.sockets)
      socket.close(1001, 'Planner service is shutting down');
    this.sockets.clear();
  }
}
