/** Provider-neutral contracts; application/domain modules import no Vercel SDK. */
export type ObjectDescriptor = {
  key: string;
  byteSize: number;
  contentType: string;
  sha256: string;
  etag?: string;
};
export type StoredObject = ObjectDescriptor & { bytes: Uint8Array };
export interface ObjectStore {
  readonly provider: string;
  /** Immutable: writing identical content is idempotent; different content conflicts. */
  put(
    key: string,
    bytes: Uint8Array,
    options: { contentType: string },
  ): Promise<ObjectDescriptor>;
  get(
    key: string,
    options: { maxBytes: number; expectedSha256?: string },
  ): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
}
export type DispatchReceipt = { provider: string; messageId?: string };
export interface JobDispatcher {
  readonly provider: string;
  /** Payload is only the durable job identity; source, credentials, and ownership stay in SQL. */
  publish(
    jobId: string,
    options?: { delaySeconds?: number },
  ): Promise<DispatchReceipt>;
}
export type JobExecutionContext = {
  messageId: string;
  deliveryCount: number;
  region?: string;
  deadlineAt?: number;
  signal?: AbortSignal;
};
/** Executor must claim/fence durable state and publish idempotently before returning. */
export type JobExecutor = (
  jobId: string,
  context: JobExecutionContext,
) => Promise<void>;
export type WorkspaceReference = {
  key: string;
  sha256: string;
  files: number;
  byteSize: number;
};
export interface WorkspaceStore {
  readonly provider: string;
  save(workspaceId: string, directory: string): Promise<WorkspaceReference>;
  restore(reference: WorkspaceReference, directory: string): Promise<void>;
}
export type HostingServices = {
  objects: ObjectStore;
  jobs: JobDispatcher;
  workspaces: WorkspaceStore;
};
