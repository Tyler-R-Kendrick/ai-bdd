import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { AgentProfile } from '../../shared/agent-profile.ts';
import type { User } from '../../shared/domain.ts';
import type { Settings } from '../auth.ts';
import { HttpError, type Store } from '../store.ts';
import type { DurableJobContext } from '../runtime/contracts.ts';
import { RepositoryReader, type RepositoryReadPort } from './repository.ts';
import {
  remoteIncomingSchema as incoming,
  remoteOutputSchema as outputSchema,
  remoteFeatures,
  remoteRepositoryTools,
  type RemoteFeature,
} from '../../shared/remote-agent.ts';
import { RemoteActivityService } from './remote-activity.ts';
import { redactRemoteError } from '../../shared/remote-stream.ts';
export type RemotePlannerScope = {
  user: User;
  artifactId: string;
  assignmentId: string;
  epoch: number;
};

export type RemoteTurn = {
  profile: AgentProfile;
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
      repositoryRead?: RepositoryReadPort;
      cancelJob?: (jobId: string, user: User) => Promise<void>;
      authenticateScoped?: (
        request: FastifyRequest,
      ) => Promise<RemotePlannerScope | null>;
      assertScoped?: (scope: RemotePlannerScope) => Promise<void>;
      activity?: RemoteActivityService;
    },
  ) {
    this.activity =
      options.activity ??
      new RemoteActivityService({
        store: options.store,
        origin: options.settings.origin,
        authenticate: (request) => this.principal(request),
        cancelJob: options.cancelJob,
        allowed: options.allowed,
      });
  }
  readonly activity: RemoteActivityService;
  private async principal(request: FastifyRequest): Promise<{
    user: User;
    artifactId?: string;
    assignmentId?: string;
    epoch?: number;
  }> {
    const scoped = await this.options.authenticateScoped?.(request);
    if (scoped) {
      await this.options.assertScoped?.(scoped);
      return scoped;
    }
    return { user: await this.options.authenticate(request) };
  }
  private readonly sockets = new Set<WebSocket>();
  private readonly connections = new Set<Promise<void>>();
  private closing = false;
  async initialize() {
    await this.options.store.tx(async () => {
      await this.options.store.db.lock('schema:studio.remote-planner');
      await this.options.store.db
        .exec(`CREATE TABLE IF NOT EXISTS studio_remote_planners(artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),connection_id TEXT NOT NULL,epoch BIGINT NOT NULL,expires BIGINT NOT NULL);
   CREATE TABLE IF NOT EXISTS studio_remote_requests(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES studio_durable_jobs(id) ON DELETE CASCADE,fence BIGINT NOT NULL,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),input_json TEXT NOT NULL,input_sha256 TEXT NOT NULL,status TEXT NOT NULL,output_json TEXT,created_at TEXT NOT NULL,tool_calls INTEGER NOT NULL DEFAULT 0);
   CREATE INDEX IF NOT EXISTS studio_remote_pending ON studio_remote_requests(artifact_id,status,created_at);`);
      if (this.options.store.db.dialect === 'postgres') {
        await this.options.store.db.exec(
          'ALTER TABLE studio_remote_requests ADD COLUMN IF NOT EXISTS tool_calls INTEGER NOT NULL DEFAULT 0',
        );
      } else {
        const columns = await this.options.store.all(
          'PRAGMA table_info(studio_remote_requests)',
        );
        if (!columns.some((column) => column.name === 'tool_calls'))
          await this.options.store.db.exec(
            'ALTER TABLE studio_remote_requests ADD COLUMN tool_calls INTEGER NOT NULL DEFAULT 0',
          );
      }
    });
    await this.options.store.tx(async () => {
      await this.options.store.lock('schema:studio.remote-planner');
      if (this.options.store.db.dialect === 'postgres') {
        await this.options.store.exec(
          'ALTER TABLE studio_remote_planners ADD COLUMN IF NOT EXISTS assignment_id TEXT',
        );
        await this.options.store.exec(
          'ALTER TABLE studio_remote_planners ADD COLUMN IF NOT EXISTS assignment_epoch BIGINT',
        );
      } else {
        const columns = await this.options.store.all(
          'PRAGMA table_info(studio_remote_planners)',
        );
        if (!columns.some((c) => c.name === 'assignment_id'))
          await this.options.store.exec(
            'ALTER TABLE studio_remote_planners ADD COLUMN assignment_id TEXT',
          );
        if (!columns.some((c) => c.name === 'assignment_epoch'))
          await this.options.store.exec(
            'ALTER TABLE studio_remote_planners ADD COLUMN assignment_epoch BIGINT',
          );
      }
    });
    await this.activity.initialize();
  }
  register(app: FastifyInstance) {
    this.activity.register(app);
    app.get('/api/planner/connect', { websocket: true }, (socket, request) => {
      void this.connect(socket, request);
    });
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
      'SELECT user_id,expires,assignment_id,assignment_epoch FROM studio_remote_planners WHERE artifact_id=?',
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
    await this.activity.prepare(
      id,
      ctx.job,
      turn.threadId,
      attached.assignment_id
        ? {
            assignmentId: attached.assignment_id,
            epoch: Number(attached.assignment_epoch),
          }
        : undefined,
    );
    let completed = false;
    try {
      while (true) {
        await ctx.assertCurrent({ requireCurrentVersion: false });
        if (attached.assignment_id)
          await this.options.assertScoped?.({
            user: await store.publicUser(ctx.job.principalId),
            artifactId: turn.artifactId,
            assignmentId: attached.assignment_id,
            epoch: Number(attached.assignment_epoch),
          });
        ctx.signal.throwIfAborted();
        const row = await store.one(
          'SELECT status,output_json,input_sha256 FROM studio_remote_requests WHERE id=?',
          id,
        );
        if (!row || row.input_sha256 !== digest(source))
          throw new HttpError(409, 'Remote Planner request integrity changed');
        if (row.status === 'completed') {
          completed = true;
          return outputSchema.parse(JSON.parse(row.output_json));
        }
        if (row.status === 'cancelled')
          throw new HttpError(409, 'Remote Planner request was cancelled');
        if (row.status === 'failed') {
          const activity = await store.one(
            'SELECT stream_json FROM studio_remote_activity WHERE request_id=?',
            id,
          );
          const protocolError =
            activity && JSON.parse(activity.stream_json).error;
          throw new HttpError(
            protocolError ? 400 : 502,
            protocolError ||
              'The attached remote Planner could not complete this turn',
          );
        }
        await delay(this.options.pollMs ?? 100, undefined, {
          signal: ctx.signal,
        });
      }
    } finally {
      if (!completed) {
        await store
          .exec(
            "UPDATE studio_remote_requests SET status='cancelled' WHERE id=? AND status='pending'",
            id,
          )
          .catch(() => {});
        await this.activity.ended(id).catch(() => {});
      }
    }
  }
  async hasLiveActivity(
    artifactId: string,
    userId: string,
    scope?: { assignmentId: string; epoch: number },
  ) {
    return this.activity.hasLiveActivity(artifactId, userId, scope);
  }
  async exportPage(
    artifactId: string,
    after: number,
    cutoff: number,
    limit = 20,
    user?: User,
  ) {
    return this.activity.exportPage(artifactId, after, cutoff, limit, user);
  }
  private async connect(socket: WebSocket, request: FastifyRequest) {
    if (this.closing) {
      socket.close(1001, 'Planner service is shutting down');
      return;
    }
    this.sockets.add(socket);
    let finishConnection!: () => void;
    const connection = new Promise<void>((resolve) => {
      finishConnection = resolve;
    });
    this.connections.add(connection);
    let peer:
      | {
          user: User;
          artifactId: string;
          connectionId: string;
          epoch: number;
          scope?: RemotePlannerScope;
          features: Set<RemoteFeature>;
        }
      | undefined;
    let queuedBytes = 0,
      frames = 0,
      closed = false,
      working = Promise.resolve();
    const inbox: { data: Buffer; binary: boolean }[] = [];
    let currentFrameRequest: string | undefined;
    let ready = false,
      draining = false,
      timer: ReturnType<typeof setInterval> | undefined,
      polling = false,
      pollWork = Promise.resolve();
    const sent = new Set<string>(),
      sentInputs = new Set<string>(),
      sentControls = new Set<string>(),
      aborted = new Set<string>();
    let lastHeard = Date.now(),
      lastPing = 0;
    socket.on('pong', () => {
      lastHeard = Date.now();
    });
    const store = this.options.store;
    const check = async () => {
      if (closed) throw new HttpError(409, 'Planner connection closed');
      if (!peer) throw new HttpError(401, 'Attach a Planner first');
      const currentUser = peer.scope
        ? (await this.options.assertScoped?.(peer.scope), peer.scope.user)
        : await this.options.authenticate(request);
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
    const requestRow = async (id: string, background = false) => {
      await check();
      const row = await store.one(
        'SELECT r.*,j.status AS job_status,j.fence AS job_fence,j.lease_expires,j.project_id FROM studio_remote_requests r JOIN studio_durable_jobs j ON j.id=r.job_id WHERE r.id=? AND r.artifact_id=? AND r.user_id=?',
        id,
        peer!.artifactId,
        peer!.user.id,
      );
      if (
        !row ||
        !(
          row.job_status === 'running' ||
          (background &&
            row.job_status === 'completed' &&
            row.status === 'completed')
        ) ||
        Number(row.fence) !== Number(row.job_fence) ||
        (row.job_status === 'running' &&
          Number(row.lease_expires) <= Date.now())
      )
        throw new HttpError(
          409,
          'Remote Planner request lost its execution lease',
        );
      const activity = await this.activity.row(id);
      if (activity && !this.activity.bindingCurrent(activity))
        throw new HttpError(
          409,
          'This request belongs to a replaced Planner assignment',
        );
      if (digest(row.input_json) !== row.input_sha256)
        throw new HttpError(409, 'Remote Planner input integrity changed');
      return row;
    };
    const consume = async (data: Buffer, binary: boolean) => {
      if (binary)
        throw new HttpError(400, 'Remote Planner uses JSON text frames');
      const raw = JSON.parse(data.toString());
      currentFrameRequest =
        typeof raw?.requestId === 'string' && raw.requestId.length <= 128
          ? raw.requestId
          : undefined;
      const message = incoming.parse(raw);
      if (message.type === 'attach') {
        if (peer)
          throw new HttpError(409, 'This connection is already attached');
        const principal = await this.principal(request),
          user = principal.user;
        if (principal.artifactId && principal.artifactId !== message.artifactId)
          throw new HttpError(
            403,
            'This Planner credential belongs to another artifact',
          );
        const requested = String(
            request.headers['studio-planner-features'] ?? '',
          )
            .split(',')
            .map((value) => value.trim())
            .slice(0, 16),
          features = new Set(
            remoteFeatures.filter((feature) => requested.includes(feature)),
          );
        const artifact = await store.artifact(
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
            ...(principal.assignmentId
              ? { scope: principal as RemotePlannerScope }
              : {}),
            features,
          };
          await store.exec(
            'INSERT INTO studio_remote_planners(artifact_id,user_id,connection_id,epoch,expires,assignment_id,assignment_epoch) VALUES(?,?,?,?,?,?,?) ON CONFLICT(artifact_id) DO UPDATE SET user_id=excluded.user_id,connection_id=excluded.connection_id,epoch=excluded.epoch,expires=excluded.expires,assignment_id=excluded.assignment_id,assignment_epoch=excluded.assignment_epoch',
            artifact.id,
            user.id,
            peer.connectionId,
            peer.epoch,
            Date.now() + 30000,
            peer.scope?.assignmentId ?? null,
            peer.scope?.epoch ?? null,
          );
        });
        await send({
          type: 'attached',
          version: 1,
          artifact: { id: artifact.id, title: artifact.title },
          tools: remoteRepositoryTools,
          ...(request.headers['studio-planner-features'] !== undefined
            ? { features: [...features] }
            : {}),
        });
        return;
      }
      await check();
      if (message.type === 'ping') {
        await send({ type: 'pong' });
        return;
      }
      if ('eventId' in message) {
        const receipt = await this.activity.accept(
          message,
          peer!.features,
          () => requestRow(message.requestId, true),
        );
        await send({
          type: 'event-accepted',
          requestId: message.requestId,
          eventId: message.eventId,
          sequence: receipt.sequence,
        });
        return;
      }
      if (message.type === 'control-result') {
        await this.activity.controlResult(message, () =>
          requestRow(message.requestId),
        );
        return;
      }
      const row = await requestRow(message.requestId);
      if (message.type === 'failed') {
        await store.tx(async () => {
          await store.db.lock('project:' + row.project_id);
          await store.db.lock('job:' + row.job_id);
          await requestRow(row.id);
          await store.exec(
            "UPDATE studio_remote_requests SET status='failed' WHERE id=? AND status='pending'",
            row.id,
          );
        });
        await this.activity.ended(row.id);
        return;
      }
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
        await this.activity.finishTurn(row.id);
        await send({ type: 'result-accepted', requestId: row.id });
        return;
      }
      const turn = JSON.parse(row.input_json) as RemoteTurn;
      const state = await this.activity.row(row.id);
      if (
        JSON.parse(state.stream_json).calls.some(
          (call: any) => call.id === message.callId,
        )
      )
        throw new HttpError(409, 'A tool call identity cannot repeat');
      await this.activity.hostPart(
        row.id,
        'call:' + message.callId,
        {
          type: 'tool-call',
          toolCallId: message.callId,
          toolName: message.name,
          input: message.input,
          providerExecuted: true,
        },
        () => requestRow(row.id),
      );
      await store.tx(async () => {
        await store.db.lock('project:' + row.project_id);
        await store.db.lock('job:' + row.job_id);
        const current = await requestRow(row.id);
        if (current.status !== 'pending' || Number(current.tool_calls) >= 12)
          throw new HttpError(
            429,
            'Remote Planner repository tool budget exhausted',
          );
        await store.exec(
          'UPDATE studio_remote_requests SET tool_calls=tool_calls+1 WHERE id=?',
          row.id,
        );
      });
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
        fetch,
        this.options.repositoryRead
          ? (input, signal) =>
              this.options.repositoryRead!(
                peer!.user,
                turn.repository,
                input,
                signal,
              )
          : undefined,
      );
      reader.pin(turn.revision);
      let value: unknown,
        isError = false;
      try {
        value =
          message.name === 'repository_tree'
            ? await reader.tree()
            : message.name === 'repository_file'
              ? await reader.file(z.string().max(500).parse(message.input.path))
              : message.name === 'repository_pull_request'
                ? await reader.pullRequest(
                    z.number().int().positive().parse(message.input.number),
                  )
                : message.name === 'repository_search'
                  ? await reader.search(
                      z.string().max(500).parse(message.input.query),
                      message.input.limit === undefined
                        ? 10
                        : z
                            .number()
                            .int()
                            .min(1)
                            .max(20)
                            .parse(message.input.limit),
                    )
                  : await reader.history({
                      path:
                        message.input.path === undefined
                          ? undefined
                          : z.string().max(500).parse(message.input.path),
                      limit:
                        message.input.limit === undefined
                          ? 10
                          : z
                              .number()
                              .int()
                              .min(1)
                              .max(20)
                              .parse(message.input.limit),
                    });
      } catch (error) {
        await requestRow(row.id);
        isError = true;
        value = {
          error: redactRemoteError(
            error instanceof Error
              ? error.message
              : 'The repository tool could not complete',
          ),
        };
      }
      await this.activity.hostPart(
        row.id,
        'result:' + message.callId,
        {
          type: 'tool-result',
          toolCallId: message.callId,
          toolName: message.name,
          result: value,
          ...(isError ? { isError: true } : {}),
        },
        () => requestRow(row.id),
      );
      await send({
        type: 'tool-result',
        requestId: row.id,
        callId: message.callId,
        value,
        ...(isError ? { isError: true } : {}),
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
        .catch(async (error) => {
          const message = redactRemoteError(
            error instanceof Error ? error.message : 'Invalid remote frame',
          ).slice(0, 4000);
          if (currentFrameRequest)
            await this.activity
              .failProtocol(currentFrameRequest, message, () =>
                requestRow(currentFrameRequest!),
              )
              .catch(() => {});
          if (socket.readyState === 1)
            socket.send(
              JSON.stringify({
                type: 'error',
                code: 'frame-rejected',
                message,
              }),
            );
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
      lastHeard = Date.now();
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
      void (async () => {
        if (peer)
          await store
            .exec(
              'UPDATE studio_remote_planners SET expires=0 WHERE artifact_id=? AND connection_id=? AND epoch=?',
              peer.artifactId,
              peer.connectionId,
              peer.epoch,
            )
            .catch(() => {});
        await Promise.allSettled([working, pollWork]);
      })().finally(() => {
        this.connections.delete(connection);
        finishConnection();
      });
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
      await this.principal(request);
      ready = true;
      drain();
      timer = setInterval(() => {
        if (polling || !peer || closed) return;
        polling = true;
        pollWork = (async () => {
          await check();
          if (Date.now() - lastHeard > 120000) {
            socket.close(1001, 'Unresponsive Planner');
            return;
          }
          if (
            Date.now() - lastPing > 15000 &&
            socket.bufferedAmount < 1024000
          ) {
            socket.ping();
            lastPing = Date.now();
          }
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
                ...(peer!.features.size
                  ? {
                      resume: {
                        cursor: Number(
                          (await this.activity.row(row.id))?.cursor ?? 0,
                        ),
                        stateUrl: `/api/artifacts/${peer!.artifactId}/planner/requests/${row.id}`,
                      },
                    }
                  : {}),
              });
              sent.add(row.id);
            }
          if (peer!.features.has('run-cards')) {
            const completed = await store.all(
              "SELECT r.id,r.input_json FROM studio_remote_requests r JOIN studio_durable_jobs j ON j.id=r.job_id JOIN studio_remote_activity a ON a.request_id=r.id WHERE r.artifact_id=? AND r.user_id=? AND r.status='completed' AND j.status='completed' AND j.fence=r.fence ORDER BY a.ordinal DESC LIMIT 8",
              peer!.artifactId,
              peer!.user.id,
            );
            for (const value of completed)
              if (!sent.has(value.id)) {
                const state = await this.activity.row(value.id);
                if (
                  state &&
                  this.activity.bindingCurrent(state) &&
                  this.activity.hasBackgroundWork(state)
                ) {
                  await send({
                    type: 'resume-session',
                    requestId: value.id,
                    input: JSON.parse(value.input_json),
                    resume: { cursor: Number(state.cursor) },
                  });
                  sent.add(value.id);
                }
              }
          }
          for (const id of sent) {
            const current = await this.activity.row(id);
            if (!current) continue;
            if (
              (['failed', 'cancelled'].includes(current.request_status) ||
                ['failed', 'cancelled'].includes(current.job_status) ||
                (current.job_status === 'completed' &&
                  !this.activity.hasBackgroundWork(current)) ||
                Number(current.fence) !== Number(current.job_fence)) &&
              !aborted.has(id)
            ) {
              if (peer!.features.size)
                await send({
                  type:
                    current.request_status === 'completed' &&
                    current.job_status === 'completed'
                      ? 'request-closed'
                      : 'abort',
                  requestId: id,
                });
              aborted.add(id);
              await this.activity.ended(id);
              continue;
            }
            const deliveries = await this.activity.deliveries(id);
            for (const input of deliveries.questions) {
              const key = id + ':' + input.questionId + ':' + input.revision;
              if (!sentInputs.has(key)) {
                await send(input);
                sentInputs.add(key);
              }
            }
            for (const control of deliveries.controls)
              if (!sentControls.has(control.controlId)) {
                await send(control);
                sentControls.add(control.controlId);
              }
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
    this.closing = true;
    const sockets = [...this.sockets];
    for (const socket of sockets)
      socket.close(1001, 'Planner service is shutting down');
    const terminate = setTimeout(() => {
      for (const socket of sockets) socket.terminate();
    }, 1000);
    terminate.unref();
    await Promise.allSettled([...this.connections]);
    clearTimeout(terminate);
    this.closing = false;
  }
}
