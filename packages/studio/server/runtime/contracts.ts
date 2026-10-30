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
export interface DurableJobRuntime {
  enqueue(input: EnqueueJob): Promise<DurableJob>;
  get(id: string): Promise<DurableJob | null>;
  register(kind: string, handler: DurableJobHandler): void;
  executeJob(id: string, delivery: JobDelivery): Promise<void>;
  cancel(id: string, user: User): Promise<void>;
  flushOutbox(limit?: number): Promise<void>;
  recover(options?: { dispatchLimit?: number }): Promise<void>;
  close(): Promise<void>;
}
