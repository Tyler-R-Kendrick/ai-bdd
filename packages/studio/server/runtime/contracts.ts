import type { User } from '../../shared/domain.ts';

export type DurableJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type DurableJob = {
  id: string;
  kind: string;
  projectId: string;
  artifactId: string;
  principalId: string;
  artifactVersion: number;
  snapshot: unknown;
  idempotencyKey: string;
  status: DurableJobStatus;
  attempt: number;
  maxAttempts: number;
  fence: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  availableAt: number;
  progress: { percent: number; label?: string } | null;
  result: unknown;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};
export type EnqueueJob = {
  kind: string;
  projectId: string;
  artifactId: string;
  principalId: string;
  artifactVersion: number;
  snapshot: unknown;
  idempotencyKey: string;
  maxAttempts?: number;
  availableAt?: number;
};
export type JobDelivery = {
  messageId: string;
  deliveryCount: number;
  region?: string;
  deadlineAt?: number;
  signal?: AbortSignal;
};
export interface DurableJobContext {
  readonly job: DurableJob;
  readonly snapshot: unknown;
  readonly fence: number;
  readonly signal: AbortSignal;
  /** Recheck the lease, principal membership, and optional source revision. */
  assertCurrent(options?: { requireCurrentVersion?: boolean }): Promise<void>;
  /** Persist bounded progress and renew only this attempt's fenced lease. */
  progress(value: { percent: number; label?: string }): Promise<void>;
  /** Cache a completed external step. Calls may repeat if the process dies before its receipt commits. */
  step<T>(
    name: string,
    operation: (idempotencyKey: string) => Promise<T>,
  ): Promise<T>;
  /** FINAL SQL publication, named receipt and canonical completed/result state commit atomically under job/project locks. Stage external uploads first. */
  commit<T>(
    name: string,
    operation: () => Promise<T>,
    options?: { requireCurrentVersion?: boolean },
  ): Promise<T>;
}
export type DurableJobHandler = (
  context: DurableJobContext,
) => Promise<unknown>;
/** Configuration and a persisted dispatch failure are distinct from proven queue delivery. */
export type DispatchReadiness = {
  state: 'configured' | 'degraded';
  reason?: 'outbox-dispatch-pending';
  verified: false;
};
export interface DurableJobRuntime {
  enqueue(input: EnqueueJob): Promise<DurableJob>;
  get(id: string): Promise<DurableJob | null>;
  register(kind: string, handler: DurableJobHandler): void;
  /** SQL-only lifecycle projection; awaited in the same fenced source transaction. */
  onStatus?(kind: string, listener: (job: DurableJob) => Promise<void>): void;
  executeJob(id: string, delivery: JobDelivery): Promise<void>;
  cancel(id: string, user: User): Promise<void>;
  /** A supplied jobId restricts publication to that job; it must not drain other intents. */
  flushOutbox(limit?: number, jobId?: string): Promise<void>;
  /** Async-scope only: keep SQL admissions but leave publication to maintenance. */
  deferDispatch?<T>(
    operation: () => Promise<T>,
    options?: { onAdmitted?: (jobIds: readonly string[]) => void },
  ): Promise<T>;
  /** Observes persisted failed dispatch intents; does not certify delivery or execution. */
  dispatchReadiness?(): Promise<DispatchReadiness>;
  /** Zero reconciles SQL intents/leases without calling the external publisher. */
  recover(options?: { dispatchLimit?: number }): Promise<void>;
  close(): Promise<void>;
}
