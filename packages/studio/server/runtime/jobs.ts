import { createHash, randomUUID } from 'node:crypto';
import type { Store } from '../store.ts';
import { HttpError } from '../store.ts';
import type { User } from '../../shared/domain.ts';
import { SqlRealtimeTransport } from '../realtime/transport.ts';
import type {
  DurableJob,
  DurableJobContext,
  DurableJobHandler,
  DurableJobRuntime,
  EnqueueJob,
  JobDelivery,
} from './contracts.ts';

export class JobLeaseLostError extends Error {}
export class TerminalJobError extends Error {}
export type DurableJobOptions = {
  store: Store;
  dispatcher: {
    readonly provider: string;
    publish(
      jobId: string,
      options?: { dispatchId?: string; delaySeconds?: number },
    ): Promise<{ provider: string; messageId?: string }>;
  };
  instanceId?: string;
  leaseMs?: number;
  clock?: () => number;
};
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
function json(value: unknown) {
  let source: string | undefined;
  try {
    source = JSON.stringify(value);
  } catch {}
  if (!source || Buffer.byteLength(source) > 2 * 1024 * 1024)
    throw new TerminalJobError('Durable job data must be bounded JSON');
  return source;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
const terminal = (status: string) =>
  ['completed', 'failed', 'cancelled'].includes(status);

/** Durable intent, fenced attempts and idempotent SQL publication. External calls are at-least-once before a receipt. */
export class DurableJobCoordinator implements DurableJobRuntime {
  readonly ready: Promise<void>;
  readonly instanceId: string;
  readonly leaseMs: number;
  private readonly handlers = new Map<string, DurableJobHandler>();
  private readonly listeners = new Map<
    string,
    (job: DurableJob) => Promise<void>
  >();
  private readonly notifications: SqlRealtimeTransport;
  private readonly executions = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly clock: () => number;
  private closing = false;
  constructor(readonly options: DurableJobOptions) {
    this.instanceId = options.instanceId ?? randomUUID();
    this.leaseMs = options.leaseMs ?? 60000;
    if (
      !Number.isSafeInteger(this.leaseMs) ||
      this.leaseMs < 100 ||
      this.leaseMs > 300000
    )
      throw new Error('Durable job lease must be between100 and300000ms');
    this.clock = options.clock ?? Date.now;
    this.notifications = new SqlRealtimeTransport(options.store, {
      instanceId: 'jobs-' + this.instanceId,
    });
    this.ready = this.initialize();
    void this.ready.catch(() => {});
  }
  private get store() {
    return this.options.store;
  }
  private stamp() {
    return new Date(this.clock()).toISOString();
  }
  private async initialize() {
    await this.notifications.ready;
    await this.store.tx(async () => {
      await this.store.db.lock('schema:studio.jobs');
      await this.store.db.exec(`
        CREATE TABLE IF NOT EXISTS studio_durable_jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,principal_id TEXT NOT NULL REFERENCES users(id),artifact_version INTEGER NOT NULL,input_json TEXT NOT NULL,input_sha256 TEXT NOT NULL,idempotency_key TEXT UNIQUE NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,max_attempts INTEGER NOT NULL,fence BIGINT NOT NULL DEFAULT 0,lease_owner TEXT,lease_expires BIGINT,available_at BIGINT NOT NULL,progress_json TEXT,output_json TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS studio_durable_due ON studio_durable_jobs(status,available_at,lease_expires);
        CREATE INDEX IF NOT EXISTS studio_durable_artifact ON studio_durable_jobs(artifact_id,created_at);
        CREATE TABLE IF NOT EXISTS studio_job_receipts(job_id TEXT NOT NULL REFERENCES studio_durable_jobs(id) ON DELETE CASCADE,name TEXT NOT NULL,phase TEXT NOT NULL,value_json TEXT NOT NULL,value_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(job_id,name,phase));
        CREATE TABLE IF NOT EXISTS studio_job_outbox(id TEXT PRIMARY KEY,intent_key TEXT UNIQUE NOT NULL,job_id TEXT NOT NULL REFERENCES studio_durable_jobs(id) ON DELETE CASCADE,status TEXT NOT NULL,available_at BIGINT NOT NULL,retry_at BIGINT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,dispatch_owner TEXT,dispatch_expires BIGINT,receipt_json TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS studio_job_outbox_due ON studio_job_outbox(status,retry_at,dispatch_expires);
      `);
    });
  }
  register(kind: string, handler: DurableJobHandler) {
    if (!/^[a-z][a-z0-9.-]{0,79}$/.test(kind))
      throw new Error('Invalid durable job kind');
    if (this.handlers.has(kind) && this.handlers.get(kind) !== handler)
      throw new Error('A durable job kind already has a registered handler');
    this.handlers.set(kind, handler);
  }
  onStatus(kind: string, listener: (job: DurableJob) => Promise<void>) {
    if (this.listeners.has(kind))
      throw new Error('Job kind already has a lifecycle projection');
    this.listeners.set(kind, listener);
  }
  private async statusChanged(row: any) {
    const listener = this.listeners.get(row.kind);
    if (listener) {
      let job: DurableJob | undefined;
      try {
        job = this.read(row);
      } catch (error) {
        if (!(error instanceof TerminalJobError)) throw error;
      }
      if (job) await listener(job);
    }
    await this.notifications.publish('project:' + row.project_id, {
      type: 'changed',
      projectId: row.project_id,
      artifactId: row.artifact_id,
      jobId: row.id,
    });
  }
  private read(row: any): DurableJob {
    if (digest(row.input_json) !== row.input_sha256)
      throw new TerminalJobError(
        'The immutable job snapshot failed its integrity check',
      );
    return {
      id: row.id,
      kind: row.kind,
      projectId: row.project_id,
      artifactId: row.artifact_id,
      principalId: row.principal_id,
      artifactVersion: Number(row.artifact_version),
      snapshot: freeze(JSON.parse(row.input_json)),
      idempotencyKey: row.idempotency_key,
      status: row.status,
      attempt: Number(row.attempts),
      maxAttempts: Number(row.max_attempts),
      fence: Number(row.fence),
      leaseOwner: row.lease_owner,
      leaseExpiresAt:
        row.lease_expires === null ? null : Number(row.lease_expires),
      availableAt: Number(row.available_at),
      progress: row.progress_json ? JSON.parse(row.progress_json) : null,
      result: row.output_json ? JSON.parse(row.output_json) : null,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  async get(id: string) {
    await this.ready;
    const row = await this.store.one(
      'SELECT * FROM studio_durable_jobs WHERE id=?',
      id,
    );
    return row ? this.read(row) : null;
  }
  private async intent(jobId: string, key: string, availableAt: number) {
    const timestamp = this.stamp();
    await this.store.exec(
      "INSERT INTO studio_job_outbox(id,intent_key,job_id,status,available_at,retry_at,created_at,updated_at) VALUES(?,?,?,'pending',?,?,?,?) ON CONFLICT(intent_key) DO NOTHING",
      randomUUID(),
      key,
      jobId,
      availableAt,
      this.clock(),
      timestamp,
      timestamp,
    );
  }
  async enqueue(input: EnqueueJob): Promise<DurableJob> {
    await this.ready;
    if (this.closing) throw new Error('Durable runtime is shutting down');
    if (!this.handlers.has(input.kind))
      throw new Error('Register the durable job kind before enqueueing work');
    if (!input.idempotencyKey || input.idempotencyKey.length > 300)
      throw new HttpError(
        400,
        'A bounded stable idempotency key is required',
      );
    const source = json(input.snapshot),
      checksum = digest(source),
      attempts = input.maxAttempts ?? 3;
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10)
      throw new HttpError(400, 'Choose between1 and10 durable attempts');
    return this.store.tx(async () => {
      await this.store.db.lock('project:' + input.projectId);
      const artifact = await this.store.artifact(
        input.artifactId,
        input.principalId,
        'write',
      );
      if (artifact.projectId !== input.projectId)
        throw new HttpError(
          409,
          'The artifact changed before this immutable work snapshot was approved',
        );
      const existing = await this.store.one(
        'SELECT * FROM studio_durable_jobs WHERE idempotency_key=?',
        input.idempotencyKey,
      );
      if (existing) {
        if (
          existing.kind !== input.kind ||
          existing.project_id !== input.projectId ||
          existing.artifact_id !== input.artifactId ||
          existing.principal_id !== input.principalId ||
          Number(existing.artifact_version) !== input.artifactVersion ||
          existing.input_sha256 !== checksum
        )
          throw new HttpError(
            409,
            'This idempotency key already identifies different approved work',
          );
        return this.read(existing);
      }
      if (artifact.version !== input.artifactVersion)
        throw new HttpError(
          409,
          'The artifact changed before this immutable work snapshot was approved',
        );
      if (
        (
          await this.store.one(
            "SELECT count(*) AS n FROM studio_durable_jobs WHERE project_id=? AND status IN ('queued','running')",
            input.projectId,
          )
        ).n >= 100
      )
        throw new HttpError(
          429,
          'This project has reached its active durable-work limit',
        );
      const id = randomUUID(),
        timestamp = this.stamp(),
        available = input.availableAt ?? this.clock();
      if (
        !Number.isSafeInteger(available) ||
        available < 0 ||
        available > this.clock() + 86400000
      )
        throw new HttpError(
          400,
          'The work schedule is outside its bounded window',
        );
      await this.store.exec(
        "INSERT INTO studio_durable_jobs(id,kind,project_id,artifact_id,principal_id,artifact_version,input_json,input_sha256,idempotency_key,status,max_attempts,available_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'queued',?,?,?,?)",
        id,
        input.kind,
        input.projectId,
        input.artifactId,
        input.principalId,
        input.artifactVersion,
        source,
        checksum,
        input.idempotencyKey,
        attempts,
        available,
        timestamp,
        timestamp,
      );
      await this.intent(id, 'enqueue:' + id, available);
      await this.notifications.publish('project:' + input.projectId, {
        type: 'changed',
        projectId: input.projectId,
        artifactId: input.artifactId,
        jobId: id,
      });
      return this.read(
        await this.store.one(
          'SELECT * FROM studio_durable_jobs WHERE id=?',
          id,
        ),
      );
    });
  }
  private async locked<T>(
    jobId: string,
    operation: (row: any) => Promise<T>,
  ) {
    const scope = await this.store.one(
      'SELECT project_id FROM studio_durable_jobs WHERE id=?',
      jobId,
    );
    if (!scope)
      throw new JobLeaseLostError('The durable job no longer exists');
    return this.store.tx(async () => {
      await this.store.db.lock('project:' + scope.project_id);
      await this.store.db.lock('job:' + jobId);
      const row = await this.store.one(
        'SELECT * FROM studio_durable_jobs WHERE id=?',
        jobId,
      );
      if (!row)
        throw new JobLeaseLostError('The durable job no longer exists');
      const result = await operation(row);
      const after = await this.store.one(
        'SELECT * FROM studio_durable_jobs WHERE id=?',
        jobId,
      );
      if (after && row.status !== after.status)
        await this.statusChanged(after);
      return result;
    });
  }
  private lease(row: any, job: DurableJob) {
    if (
      row.status !== 'running' ||
      Number(row.fence) !== job.fence ||
      row.lease_owner !== this.instanceId ||
      Number(row.lease_expires) <= this.clock()
    )
      throw new JobLeaseLostError(
        'This durable job attempt lost its publication lease',
      );
  }
  private async authorized(row: any, version: boolean) {
    const artifact = await this.store.artifact(
      row.artifact_id,
      row.principal_id,
      'write',
    );
    if (
      artifact.projectId !== row.project_id ||
      (version && artifact.version !== Number(row.artifact_version))
    )
      throw new TerminalJobError(
        'The approved source revision is stale; no replacement was published',
      );
  }
  private async claim(id: string) {
    return this.locked(id, async (row) => {
      if (terminal(row.status)) return null;
      const now = this.clock();
      if (
        (row.status === 'running' && Number(row.lease_expires) > now) ||
        (row.status === 'queued' && Number(row.available_at) > now)
      ) {
        await this.intent(
          id,
          `wake:${id}:${row.fence}:${Math.floor(now / 30000)}`,
          row.status === 'running'
            ? Number(row.lease_expires) + 10
            : Number(row.available_at),
        );
        return null;
      }
      if (Number(row.attempts) >= Number(row.max_attempts)) {
        await this.store.exec(
          "UPDATE studio_durable_jobs SET status='failed',fence=fence+1,error=?,lease_owner=NULL,lease_expires=NULL,updated_at=? WHERE id=?",
          'The durable retry limit was reached',
          this.stamp(),
          id,
        );
        return null;
      }
      await this.store.exec(
        "UPDATE studio_durable_jobs SET status='running',attempts=attempts+1,fence=fence+1,lease_owner=?,lease_expires=?,error=NULL,updated_at=? WHERE id=?",
        this.instanceId,
        now + this.leaseMs,
        this.stamp(),
        id,
      );
      const claimed = await this.store.one(
        'SELECT * FROM studio_durable_jobs WHERE id=?',
        id,
      );
      await this.intent(
        id,
        `lease:${id}:${claimed.fence}`,
        now + this.leaseMs + 10,
      );
      return claimed;
    });
  }
  private async receipt(jobId: string, name: string, phase: string) {
    const row = await this.store.one(
      'SELECT value_json,value_sha256 FROM studio_job_receipts WHERE job_id=? AND name=? AND phase=?',
      jobId,
      name,
      phase,
    );
    if (!row) return undefined;
    if (digest(row.value_json) !== row.value_sha256)
      throw new TerminalJobError(
        'A durable step receipt failed its integrity check',
      );
    return { value: JSON.parse(row.value_json) };
  }
  private async saveReceipt(
    jobId: string,
    name: string,
    phase: string,
    value: unknown,
  ) {
    const source = json(value);
    await this.store.exec(
      'INSERT INTO studio_job_receipts(job_id,name,phase,value_json,value_sha256,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(job_id,name,phase) DO NOTHING',
      jobId,
      name,
      phase,
      source,
      digest(source),
      this.stamp(),
    );
  }
  private context(
    job: DurableJob,
    controller: AbortController,
  ): DurableJobContext {
    const nameCheck = (name: string) => {
      if (!/^[a-zA-Z0-9_.:-]{1,100}$/.test(name))
        throw new TerminalJobError('Use a bounded stable step name');
    };
    const finalReceipts = new Map<string, unknown>();
    const check = async (version = false) =>
      this.locked(job.id, async (row) => {
        this.lease(row, job);
        await this.authorized(row, version);
      });
    return {
      job,
      snapshot: job.snapshot,
      fence: job.fence,
      signal: controller.signal,
      assertCurrent: (options) =>
        check(options?.requireCurrentVersion ?? true),
      progress: async (value) => {
        if (
          !Number.isFinite(value.percent) ||
          value.percent < 0 ||
          value.percent > 100 ||
          (value.label?.length ?? 0) > 300
        )
          throw new TerminalJobError('Progress exceeds its bounds');
        await this.locked(job.id, async (row) => {
          this.lease(row, job);
          await this.authorized(row, false);
          await this.store.exec(
            'UPDATE studio_durable_jobs SET progress_json=?,lease_expires=?,updated_at=? WHERE id=? AND fence=?',
            json(value),
            this.clock() + this.leaseMs,
            this.stamp(),
            job.id,
            job.fence,
          );
        });
      },
      step: async <T>(
        name: string,
        operation: (key: string) => Promise<T>,
      ) => {
        nameCheck(name);
        controller.signal.throwIfAborted();
        const cached = await this.locked(job.id, async (row) => {
          this.lease(row, job);
          const receipt = await this.receipt(job.id, name, 'step');
          if (!receipt) await this.authorized(row, false);
          return receipt;
        });
        if (cached) return cached.value as T;
        // The stable key may be passed to providers supporting their own idempotency, but no universal provider guarantee is assumed.
        const result = await operation(`${job.id}:${name}`);
        controller.signal.throwIfAborted();
        return this.locked(job.id, async (row) => {
          this.lease(row, job);
          await this.authorized(row, false);
          const existing = await this.receipt(job.id, name, 'step');
          if (existing) return existing.value as T;
          await this.saveReceipt(job.id, name, 'step', result);
          return result;
        });
      },
      commit: async <T>(
        name: string,
        operation: () => Promise<T>,
        options?: { requireCurrentVersion?: boolean },
      ) => {
        nameCheck(name);
        if (finalReceipts.has(name)) return finalReceipts.get(name) as T;
        controller.signal.throwIfAborted();
        const result = await this.locked(job.id, async (row) => {
          this.lease(row, job);
          const existing = await this.receipt(job.id, name, 'publication');
          if (existing) return existing.value as T;
          await this.authorized(row, options?.requireCurrentVersion ?? true);
          const value = await operation();
          await this.saveReceipt(job.id, name, 'publication', value);
          await this.store.exec(
            "UPDATE studio_durable_jobs SET status='completed',output_json=?,progress_json=?,lease_owner=NULL,lease_expires=NULL,error=NULL,updated_at=? WHERE id=? AND fence=?",
            json(value),
            json({ percent: 100 }),
            this.stamp(),
            job.id,
            job.fence,
          );
          return value;
        });
        finalReceipts.set(name, result);
        return result;
      },
    };
  }
  readonly executeJob = async (
    id: string,
    delivery: JobDelivery,
  ): Promise<void> => {
    await this.ready;
    if (this.closing) throw new Error('Durable runtime is shutting down');
    const existing = this.executions.get(id);
    if (existing) return existing;
    const execution = this.run(id, delivery);
    this.executions.set(id, execution);
    try {
      await execution;
      if (!this.closing) await this.flushOutbox(20, id);
    } finally {
      this.executions.delete(id);
    }
  };
  private async run(id: string, delivery: JobDelivery) {
    const before = await this.store.one(
      'SELECT kind,status FROM studio_durable_jobs WHERE id=?',
      id,
    );
    if (!before || terminal(before.status)) return;
    const handler = this.handlers.get(before.kind);
    if (!handler)
      throw new Error(
        'This instance has not registered the durable job handler',
      );
    const claimed = await this.claim(id);
    if (!claimed) return;
    let job: DurableJob;
    try {
      job = this.read(claimed);
    } catch {
      await this.locked(id, async (row) => {
        if (
          row.lease_owner === this.instanceId &&
          row.fence === claimed.fence
        )
          await this.store.exec(
            "UPDATE studio_durable_jobs SET status='failed',fence=fence+1,error=?,lease_owner=NULL,lease_expires=NULL,updated_at=? WHERE id=?",
            'The immutable job snapshot failed its integrity check',
            this.stamp(),
            id,
          );
      });
      return;
    }
    const controller = new AbortController();
    this.controllers.set(id, controller);
    if (this.closing) controller.abort(new Error('Worker is shutting down'));
    let revoked = false,
      terminalReason: string | undefined,
      renewal: Promise<void> | undefined;
    const renew = async () => {
      await this.locked(id, async (row) => {
        this.lease(row, job);
        await this.authorized(row, false);
        await this.store.exec(
          'UPDATE studio_durable_jobs SET lease_expires=?,updated_at=? WHERE id=? AND fence=?',
          this.clock() + this.leaseMs,
          this.stamp(),
          id,
          job.fence,
        );
      });
    };
    const heartbeat = setInterval(
      () => {
        if (!renewal) {
          renewal = renew()
            .catch((error) => {
              revoked =
                error instanceof HttpError &&
                [401, 403, 404].includes(error.statusCode);
              if (
                error instanceof HttpError &&
                error.statusCode >= 400 &&
                error.statusCode < 500 &&
                ![408, 425, 429].includes(error.statusCode)
              )
                terminalReason = error.message.slice(0, 1000);
              controller.abort(error);
            })
            .finally(() => {
              renewal = undefined;
            });
        }
      },
      Math.max(25, Math.floor(this.leaseMs / 3)),
    );
    heartbeat.unref();
    const abortDelivery = () => controller.abort(delivery.signal?.reason);
    delivery.signal?.addEventListener('abort', abortDelivery, { once: true });
    if (delivery.signal?.aborted) abortDelivery();
    const deadline = delivery.deadlineAt
      ? setTimeout(
          () =>
            controller.abort(
              new Error('The delivery deadline is approaching'),
            ),
          Math.max(0, delivery.deadlineAt - Date.now() - 1000),
        )
      : undefined;
    deadline?.unref();
    try {
      controller.signal.throwIfAborted();
      const result = await handler(this.context(job, controller));
      await this.locked(id, async (row) => {
        if (row.status === 'completed') return; // Publication already completed atomically, including before a cleanup error.
        this.lease(row, job);
        await this.authorized(row, false);
        await this.store.exec(
          "UPDATE studio_durable_jobs SET status='completed',output_json=?,progress_json=?,lease_owner=NULL,lease_expires=NULL,error=NULL,updated_at=? WHERE id=? AND fence=?",
          json(result ?? null),
          json({ percent: 100 }),
          this.stamp(),
          id,
          job.fence,
        );
      });
    } catch (error) {
      await this.locked(id, async (row) => {
        if (
          terminal(row.status) ||
          Number(row.fence) !== job.fence ||
          row.lease_owner !== this.instanceId
        )
          return;
        if (
          error instanceof JobLeaseLostError &&
          Number(row.lease_expires) <= this.clock()
        )
          return;
        const denied =
          revoked ||
          (error instanceof HttpError &&
            [401, 403, 404].includes(error.statusCode));
        const permanent =
          denied ||
          error instanceof TerminalJobError ||
          !!terminalReason ||
          (error instanceof HttpError &&
            error.statusCode >= 400 &&
            error.statusCode < 500 &&
            ![408, 425, 429].includes(error.statusCode)) ||
          Number(row.attempts) >= Number(row.max_attempts);
        if (permanent) {
          await this.store.exec(
            'UPDATE studio_durable_jobs SET status=?,fence=fence+1,error=?,lease_owner=NULL,lease_expires=NULL,updated_at=? WHERE id=?',
            denied ? 'cancelled' : 'failed',
            denied
              ? 'The artifact or requesting account is no longer available for this work'
              : (terminalReason ??
                  (error instanceof TerminalJobError ||
                  (error instanceof HttpError &&
                    error.statusCode >= 400 &&
                    error.statusCode < 500 &&
                    ![408, 425, 429].includes(error.statusCode))
                    ? error.message.slice(0, 1000)
                    : 'The bounded durable retry limit was reached')),
            this.stamp(),
            id,
          );
        } else {
          const available =
            this.clock() +
            Math.min(
              60000,
              1000 * 2 ** Math.min(6, Number(row.attempts) - 1),
            );
          await this.store.exec(
            "UPDATE studio_durable_jobs SET status='queued',lease_owner=NULL,lease_expires=NULL,available_at=?,error=?,updated_at=? WHERE id=?",
            available,
            this.closing
              ? 'Worker shut down; durable work will resume'
              : 'This attempt did not complete; a bounded retry is scheduled',
            this.stamp(),
            id,
          );
          await this.intent(id, `retry:${id}:${job.fence}`, available);
        }
      });
    } finally {
      clearInterval(heartbeat);
      if (deadline) clearTimeout(deadline);
      delivery.signal?.removeEventListener('abort', abortDelivery);
      await renewal;
      this.controllers.delete(id);
    }
  }
  async cancel(id: string, user: User) {
    await this.ready;
    await this.locked(id, async (row) => {
      await this.store.artifact(row.artifact_id, user.id, 'write');
      if (terminal(row.status)) return;
      await this.store.exec(
        "UPDATE studio_durable_jobs SET status='cancelled',fence=fence+1,lease_owner=NULL,lease_expires=NULL,error=?,updated_at=? WHERE id=?",
        'Cancelled by an authorized project member',
        this.stamp(),
        id,
      );
    });
    this.controllers
      .get(id)
      ?.abort(new Error('Cancelled by a project member'));
  }
  async flushOutbox(limit = 20, jobId?: string) {
    await this.ready;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Outbox batch must be between1 and100');
    const rows = await this.store.all(
      "SELECT id FROM studio_job_outbox WHERE ((status='pending' AND retry_at<=?) OR (status='dispatching' AND dispatch_expires<=?))" +
        (jobId ? ' AND job_id=?' : '') +
        ' ORDER BY created_at,id LIMIT ?',
      this.clock(),
      this.clock(),
      ...(jobId ? [jobId] : []),
      limit,
    );
    let failed = false;
    for (const candidate of rows) {
      const owner = randomUUID();
      const intent = await this.store.tx(async () => {
        await this.store.db.lock('outbox:' + candidate.id);
        const row = await this.store.one(
          'SELECT * FROM studio_job_outbox WHERE id=?',
          candidate.id,
        );
        if (
          !row ||
          row.status === 'dispatched' ||
          (row.status === 'dispatching' &&
            Number(row.dispatch_expires) > this.clock()) ||
          Number(row.retry_at) > this.clock()
        )
          return null;
        const job = await this.store.one(
          'SELECT status FROM studio_durable_jobs WHERE id=?',
          row.job_id,
        );
        if (!job || terminal(job.status)) {
          await this.store.exec(
            "UPDATE studio_job_outbox SET status='dispatched',updated_at=? WHERE id=?",
            this.stamp(),
            row.id,
          );
          return null;
        }
        await this.store.exec(
          "UPDATE studio_job_outbox SET status='dispatching',dispatch_owner=?,dispatch_expires=?,attempts=attempts+1,updated_at=? WHERE id=?",
          owner,
          this.clock() + 30000,
          this.stamp(),
          row.id,
        );
        return row;
      });
      if (!intent) continue;
      try {
        const receipt = await this.options.dispatcher.publish(intent.job_id, {
          dispatchId: intent.id,
          delaySeconds: Math.max(
            0,
            Math.ceil((Number(intent.available_at) - this.clock()) / 1000),
          ),
        });
        await this.store.exec(
          "UPDATE studio_job_outbox SET status='dispatched',receipt_json=?,dispatch_owner=NULL,dispatch_expires=NULL,error=NULL,updated_at=? WHERE id=? AND dispatch_owner=?",
          json({
            provider: receipt.provider,
            ...(receipt.messageId ? { messageId: receipt.messageId } : {}),
          }),
          this.stamp(),
          intent.id,
          owner,
        );
      } catch {
        failed = true;
        await this.store.exec(
          "UPDATE studio_job_outbox SET status='pending',dispatch_owner=NULL,dispatch_expires=NULL,retry_at=?,error=?,updated_at=? WHERE id=? AND dispatch_owner=?",
          this.clock() +
            Math.min(60000, 1000 * 2 ** Math.min(6, Number(intent.attempts))),
          'The configured queue did not confirm this dispatch',
          this.stamp(),
          intent.id,
          owner,
        );
      }
    }
    if (failed)
      throw new Error('One or more durable dispatch intents remain pending');
  }
  async recover(options: { dispatchLimit?: number } = {}) {
    await this.ready;
    const now = this.clock();
    const rows = await this.store.all(
      "SELECT id FROM studio_durable_jobs WHERE (status='queued' AND available_at<=?) OR (status='running' AND lease_expires<=?) ORDER BY created_at,id LIMIT 100",
      now,
      now,
    );
    for (const candidate of rows)
      await this.locked(candidate.id, async (row) => {
        if (
          terminal(row.status) ||
          (row.status === 'running' && Number(row.lease_expires) > now) ||
          (row.status === 'queued' && Number(row.available_at) > now)
        )
          return;
        await this.intent(
          row.id,
          `recover:${row.id}:${Math.floor(now / 30000)}`,
          now,
        );
      });
    await this.flushOutbox(options.dispatchLimit ?? 20);
  }
  async close() {
    this.closing = true;
    for (const controller of this.controllers.values())
      controller.abort(new Error('Worker is shutting down'));
    await Promise.allSettled([...this.executions.values()]);
    await this.ready.catch(() => {});
    await this.notifications.close();
  }
}
export async function createDurableJobRuntime(options: DurableJobOptions) {
  const runtime = new DurableJobCoordinator(options);
  await runtime.ready;
  return runtime;
}
