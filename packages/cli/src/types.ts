import type {
  CreateEngine,
  CreateRecordingStore,
  DriverFactory,
  LoadConfig,
  ModelSet,
  ResolveConfig,
  VerifyRun,
} from '@ai-bdd/sdk/contracts';

/** Process-like IO the CLI reads and writes. Everything is injectable for tests. */
export interface CliIo {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
  env: Record<string, string | undefined>;
  cwd: string;
}

/** The slice of `@ai-bdd/testing` used by `AI_BDD_FAKE=1` (§5.3). */
export interface TestingModule {
  createFakeModels(opts: { rulesDir?: string }): ModelSet;
  fakeDriver(opts: { flags?: string[] }): DriverFactory;
}

/**
 * Collaborators of `main`. Every member defaults to the public SDK implementation (or, for
 * `importTesting`, to a dynamic import of the optional `@ai-bdd/testing` package).
 */
export interface CliDeps {
  loadConfig?: LoadConfig;
  resolveConfig?: ResolveConfig;
  createEngine?: CreateEngine;
  createRecordingStore?: CreateRecordingStore;
  verifyRun?: VerifyRun;
  /** Loads `@ai-bdd/testing`; only called when `AI_BDD_FAKE=1`. Rejects when the package is missing. */
  importTesting?: () => Promise<unknown>;
  /** Overrides `process.versions.node` (doctor). */
  nodeVersion?: string;
  /** Cooperative cancellation, wired to SIGINT by `bin.ts`. */
  signal?: AbortSignal;
}
