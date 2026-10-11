import type { sessionFromPage } from '@ai-bdd/driver-playwright';
import type { ScenarioFilter } from '@ai-bdd/sdk/contracts';

/** The page argument accepted by `sessionFromPage`, whatever concrete page type the driver declares. */
export type PageLike = Parameters<typeof sessionFromPage>[0];

/** The subset of Playwright's `TestInfo` that this integration uses. The real object is assignable to it. */
export interface TestInfoLike {
  annotations: { type: string; description?: string | undefined }[];
  attach(name: string, options: { body?: string | Buffer; contentType?: string; path?: string }): Promise<void>;
}

/** Fixtures handed to the test body. Only `page` is used. */
export interface TestFixturesLike {
  page: PageLike;
}

/**
 * The subset of Playwright's `test` object that this integration uses. The real `test` from
 * `@playwright/test` is assignable to it, and unit tests can pass a recording double.
 */
export interface TestLike {
  (
    title: string,
    details: { tag?: string[] },
    body: (fixtures: TestFixturesLike, testInfo: TestInfoLike) => Promise<void>,
  ): void;
  describe(title: string, body: () => void): void;
  /** Optional: when present, the memoized engine is closed after the last test of the file in each worker. */
  afterAll?: (body: () => Promise<void>) => void;
}

export interface RegisterOptions {
  /** The `test` object from `@playwright/test` (or a compatible double). */
  test: TestLike;
  /**
   * Path to the ai-bdd config file (`ai-bdd.config.ts|mjs|js|json`). Relative paths resolve against `process.cwd()`.
   * When omitted, the standard config lookup runs in `process.cwd()`.
   */
  configPath?: string | undefined;
  /**
   * Directory holding the committed `*.plan.json` files. It is read synchronously at collection time, before any
   * config can be loaded, so it is not taken from the config file. Defaults to `.ai-bdd/plans` next to the config
   * file (or in `process.cwd()`). Pass it explicitly when your config sets a custom `planDir`.
   */
  planDir?: string | undefined;
  /** Select a subset of scenarios. Rejected scenarios are always skipped. */
  filter?: ScenarioFilter | undefined;
  /** Fail the test when the scenario ended `healed` (default: a healed scenario passes and is annotated). */
  failOnHealed?: boolean | undefined;
}
