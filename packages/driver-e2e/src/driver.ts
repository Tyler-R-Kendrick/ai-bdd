import type {
  Capabilities,
  Driver,
  DriverContext,
  DriverFactory,
  DriverSession,
  JsonValue,
  SelfCheckResult,
} from '@ai-bdd/contracts';
import { AiBddError } from '@ai-bdd/contracts';
import { E2eMcpClient } from './client.js';
import { E2eSession } from './session.js';
import { E2E_CATALOG, capabilitiesFromCatalog, normalizeMaxSessions } from './verbs.js';
import type { McpCaller } from './mcp.js';

export interface E2eDriverOptions {
  /** Path to the e2e config file. */
  config?: string;
  /** Target name inside the e2e config. */
  target?: string;
  /** Session cap, 1..16 (default 4). */
  maxSessions?: number;
  /** Override the spawned command (default `npx e2e`). */
  command?: string;
  commandArgs?: string[];
  /** Inject a caller instead of spawning `e2e mcp` (used by tests). */
  caller?: McpCaller;
  now?: () => Date;
}

export const E2E_DRIVER_MAJOR = 1;

/**
 * The e2e driver: raw observe/act through `e2e mcp` (R-K1b, R-K2).
 *
 * `e2e mcp` is raw-only, so this driver never runs an agent loop, a cache or a
 * judge: it observes, performs verbs and closes. Everything else lives in the
 * ai-bdd daemon.
 */
export function e2e(options: E2eDriverOptions = {}): DriverFactory {
  const maxSessions = normalizeMaxSessions(options.maxSessions);
  return {
    id: 'e2e',
    target: options.target ?? 'default',
    async create(ctx: DriverContext): Promise<Driver> {
      const caller = options.caller ?? new E2eMcpClient(options);
      if (!options.caller && 'connect' in caller) {
        await (caller as E2eMcpClient).connect();
      }

      const capabilities: Capabilities = capabilitiesFromCatalog([...E2E_CATALOG]);
      const driver: Driver = {
        id: 'e2e',
        major: E2E_DRIVER_MAJOR,
        capabilities,
        concurrency: { maxSessions },
        async selfCheck(): Promise<SelfCheckResult> {
          const problems: string[] = [];
          try {
            const session = await caller.openSession({});
            const catalog = session.catalog.length > 0 ? session.catalog : await caller.listCatalog(session.sessionId);
            for (const tool of ['observe', 'tap', 'type', 'screenshot']) {
              if (!catalog.includes(tool)) problems.push(`the session catalog is missing \`${tool}\``);
            }
            await caller.closeSession(session.sessionId);
          } catch (error) {
            problems.push(error instanceof Error ? error.message : String(error));
          }
          return { ok: problems.length === 0, driver: 'e2e', problems };
        },
        async openSession(openCtx: DriverContext): Promise<DriverSession> {
          const target = readTarget(openCtx.target) ?? options.target;
          let opened;
          try {
            opened = await caller.openSession({
              ...(target ? { target } : {}),
              ...(options.config ? { config: options.config } : {}),
            });
          } catch (error) {
            throw AiBddError.from(error);
          }
          const catalog =
            opened.catalog.length > 0 ? opened.catalog : await caller.listCatalog(opened.sessionId);
          return new E2eSession({
            caller,
            sessionId: opened.sessionId,
            catalog,
            driverId: driver.id,
            driverMajor: driver.major,
            ...(target !== undefined ? { target } : {}),
            ...(opened.url !== undefined ? { initialRoute: routeOf(opened.url) } : {}),
            ...(options.now ? { now: options.now } : {}),
          });
        },
      };
      void ctx;
      return driver;
    },
  };
}

function routeOf(url: string): string {
  try {
    const parsed = new URL(url, 'http://localhost');
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function readTarget(target: JsonValue | undefined): string | undefined {
  if (target && typeof target === 'object' && !Array.isArray(target)) {
    const value = (target as Record<string, JsonValue>).target;
    if (typeof value === 'string') return value;
  }
  if (typeof target === 'string') return target;
  return undefined;
}
