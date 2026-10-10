// @ts-nocheck
import type { DriverFactory, DriverSession } from '@ai-bdd/sdk/contracts';

/**
 * Wraps a driver so that its screenshots are NOT masked and masking is NOT proven. After a secret fill the observation
 * is tainted, so (R-JU3 / R-SE2) no model request may carry an image from then on.
 */
export function withoutProvenMasking(inner: DriverFactory): DriverFactory {
  return {
    id: inner.id,
    async create(ctx) {
      const driver = await inner.create(ctx);
      const caps = { ...driver.capabilities, maskingProven: false };
      return {
        id: driver.id,
        version: driver.version,
        capabilities: caps,
        selfCheck: () => driver.selfCheck(),
        dispose: () => driver.dispose(),
        async openSession(o) {
          const s = await driver.openSession(o);
          const wrapped: DriverSession = {
            id: s.id,
            driverId: s.driverId,
            driverVersion: s.driverVersion,
            capabilities: caps,
            async observe(opts) {
              const obs = await s.observe(opts);
              return obs.screenshot === undefined ? obs : { ...obs, screenshot: { ...obs.screenshot, masked: false } };
            },
            perform: (a) => s.perform(a),
            ...(s.request === undefined ? {} : { request: (r: Parameters<NonNullable<DriverSession['request']>>[0]) => (s.request as NonNullable<DriverSession['request']>)(r) }),
            close: () => s.close(),
          };
          return wrapped;
        },
      };
    },
  };
}
