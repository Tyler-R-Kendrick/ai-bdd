// @ts-nocheck
import type {
  CreateEngine,
  CreateRecordingStore,
  LoadConfig,
  VerifyRun,
} from '@ai-bdd/sdk/contracts';

/** Process-like IO the CLI reads and writes. Everything is injectable for tests. */
export interface CliIo {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
  env: Record<string, string | undefined>;
  cwd: string;
}

/**
 * Collaborators of `main`. Every member defaults to the public SDK implementation.
 */
export interface CliDeps {
  loadConfig?: LoadConfig;
  createEngine?: CreateEngine;
  createRecordingStore?: CreateRecordingStore;
  verifyRun?: VerifyRun;
  /** Overrides `process.versions.node` (doctor). */
  nodeVersion?: string;
  /** Cooperative cancellation, wired to SIGINT by `bin.ts`. */
  signal?: AbortSignal;
}
