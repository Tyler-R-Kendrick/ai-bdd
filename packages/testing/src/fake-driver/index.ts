import {
  AiBddError,
  type Driver,
  type DriverCapabilities,
  type DriverContext,
  type DriverFactory,
  type DriverSession,
  type SessionOptions,
  type Verb,
} from '@ai-bdd/sdk/contracts';
import { DEFAULT_TEST_TOKEN, initialState } from '../app/model.ts';
import { FakeSession } from './session.ts';

export { FAKE_EPOCH_MS } from './session.ts';

export const FAKE_DRIVER_VERSION = '1.0.0';
const ALL_VERBS: Verb[] = ['navigate', 'click', 'fill', 'press', 'select', 'check', 'hover', 'scroll', 'back', 'wait'];

export interface FakeDriverOptions {
  /** Acme feature flags (`v2`, `bug-upgrade-noop`) every new session starts with. */
  flags?: string[];
  adminPassword?: string;
  /** Fake time added per `observe` (default 100). Drives `/slow` and the `/todos` sync status. */
  clockStepMs?: number;
  /** Concurrent session cap, advertised and enforced (default 8). */
  maxSessions?: number;
  exclusiveResource?: string;
  /** Test API token the in-process test API expects (default `acme-test`). */
  testToken?: string;
}

/**
 * The deterministic in-process driver over the Acme model (SPEC 13.2).
 * Every session has its own state and fake clock; nothing is shared between sessions.
 */
export function fakeDriver(opts: FakeDriverOptions = {}): DriverFactory {
  const clockStepMs = opts.clockStepMs ?? 100;
  const maxSessions = opts.maxSessions ?? 8;
  const testToken = opts.testToken ?? DEFAULT_TEST_TOKEN;
  // Validates the flags eagerly so a typo fails at construction, not mid-run.
  initialState({ flags: opts.flags ?? [] });
  const capabilities: DriverCapabilities = {
    verbs: [...ALL_VERBS],
    pixels: true,
    maskingProven: true,
    request: true,
    maxSessions,
    ...(opts.exclusiveResource === undefined ? {} : { exclusiveResource: opts.exclusiveResource }),
  };

  return {
    id: 'fake',
    async create(_ctx: DriverContext): Promise<Driver> {
      const open = new Set<FakeSession>();
      let counter = 0;
      return {
        id: 'fake',
        version: FAKE_DRIVER_VERSION,
        capabilities,
        async openSession(so: SessionOptions): Promise<DriverSession> {
          if (open.size >= maxSessions) {
            throw new AiBddError('SESSION_LIMIT', `fake driver supports at most ${maxSessions} concurrent sessions`, { retryable: false });
          }
          counter += 1;
          const session: FakeSession = new FakeSession({
            id: `fake-${counter}`,
            driverId: 'fake',
            driverVersion: FAKE_DRIVER_VERSION,
            capabilities,
            options: so,
            flags: opts.flags ?? [],
            adminPassword: opts.adminPassword,
            clockStepMs,
            testToken,
            onClose: () => {
              open.delete(session);
            },
          });
          open.add(session);
          return session;
        },
        async selfCheck() {
          return { ok: true, problems: [] };
        },
        async dispose() {
          await Promise.all([...open].map((s) => s.close()));
        },
      };
    },
  };
}
