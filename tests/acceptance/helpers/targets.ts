import { existsSync } from 'node:fs';
import type { DriverFactory } from '@ai-bdd/sdk/contracts';
import { fakeDriver, startAcmeApp } from '@ai-bdd/testing';
import { ACME_DEFAULT_ADMIN_PASSWORD, PW_BROWSERS_PATH } from './paths.ts';
import { chromiumArgs, realEnvironment, unavailableReason } from '../../../packages/driver-cua/test/environment.ts';
import { FAST_REAL, type ConfigOverrides } from './project.ts';

export interface PrepareOptions {
  /** Acme app flags: v2, bug-upgrade-noop */
  flags?: string[];
  adminPassword?: string;
  /** fake driver only */
  exclusiveResource?: string;
  /** fake driver only */
  maxSessions?: number;
}

export interface PreparedTarget {
  /** key under which the factory is registered with the engine (== the factory id; also the recordings directory) */
  driverId: string;
  factory: DriverFactory;
  baseURL: string;
  /** config overrides that suit the target's clock (real browsers need short real-time windows) */
  defaults: ConfigOverrides;
  /** true when the engine must use the system clock (real browser); false when a virtual clock is fine */
  realTime: boolean;
  dispose(): Promise<void>;
}

/** A driver under test: the fake driver, or real Chromium against startAcmeApp. Both must give identical statuses. */
export interface DriverTarget {
  readonly name: 'fake' | 'playwright' | 'cua';
  prepare(opts?: PrepareOptions): Promise<PreparedTarget>;
}

export const fakeTarget: DriverTarget = {
  name: 'fake',
  async prepare(opts = {}) {
    const factory = fakeDriver({
      flags: opts.flags ?? [],
      adminPassword: opts.adminPassword ?? ACME_DEFAULT_ADMIN_PASSWORD,
      ...(opts.exclusiveResource === undefined ? {} : { exclusiveResource: opts.exclusiveResource }),
      ...(opts.maxSessions === undefined ? {} : { maxSessions: opts.maxSessions }),
    });
    return {
      driverId: factory.id,
      factory,
      baseURL: 'http://localhost:4173',
      defaults: {},
      realTime: false,
      dispose: async () => {},
    };
  },
};

export const playwrightTarget: DriverTarget = {
  name: 'playwright',
  async prepare(opts = {}) {
    const { playwright } = await import('@ai-bdd/driver-playwright');
    const app = await startAcmeApp({
      flags: opts.flags ?? [],
      adminPassword: opts.adminPassword ?? ACME_DEFAULT_ADMIN_PASSWORD,
    });
    const factory = playwright({ browser: 'chromium', headless: true });
    return {
      driverId: factory.id,
      factory,
      baseURL: app.url,
      defaults: FAST_REAL,
      realTime: true,
      dispose: () => app.close(),
    };
  },
};

/** The Cua Driver (cua.ai) operating a real Chromium window on a real desktop, against the Acme server. */
export const cuaTarget: DriverTarget = {
  name: 'cua',
  async prepare(opts = {}) {
    const { cua } = await import('@ai-bdd/driver-cua');
    const env = realEnvironment();
    if (env === undefined) throw new Error('the Cua Driver environment is not available');
    const app = await startAcmeApp({
      flags: opts.flags ?? [],
      adminPassword: opts.adminPassword ?? ACME_DEFAULT_ADMIN_PASSWORD,
    });
    const factory = cua({ kind: 'browser', launch: { command: env.chromium, args: chromiumArgs() }, startTimeoutMs: 30_000 });
    return {
      driverId: factory.id,
      factory,
      baseURL: app.url,
      defaults: FAST_REAL,
      realTime: true,
      dispose: () => app.close(),
    };
  },
};

/** Why the Playwright parity tests cannot run here, or null when they can. `AI_BDD_REQUIRE_PW=1` turns a skip into a failure. */
export function playwrightUnavailableReason(): string | null {
  if (process.env['AI_BDD_REQUIRE_PW'] === '1') return null;
  if (process.env['AI_BDD_SKIP_PW'] === '1') return 'AI_BDD_SKIP_PW=1';
  if (process.platform !== 'linux') return `platform ${process.platform} is not linux`;
  const dirs = [PW_BROWSERS_PATH, '/opt/pw-browsers'].filter((d): d is string => d !== undefined);
  if (!dirs.some((d) => existsSync(d)) && process.env['AI_BDD_CHROMIUM_PATH'] === undefined) {
    return 'no Chromium found (set PLAYWRIGHT_BROWSERS_PATH or AI_BDD_CHROMIUM_PATH)';
  }
  return null;
}

/** Why the Cua Driver tests cannot run here, or null when they can. `AI_BDD_REQUIRE_CUA=1` turns a skip into a failure. */
export function cuaUnavailableReason(): string | null {
  if (process.env['AI_BDD_REQUIRE_CUA'] === '1') return null;
  const reason = unavailableReason();
  return reason === undefined ? null : `needs a Linux desktop session, the cua-driver executable and Chromium: ${reason}`;
}
