import { rm } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { AiBddError, type DriverFactory } from '../../src/contracts/index.ts';
import { createEngine } from '../../src/engine/index.ts';
import { makeFixture } from './fakes.ts';

const SECRET = 'Zq7-uniq/Secret+Value!99';

describe('engine.close() reports driver cleanup failures without leaking secrets', () => {
  it('a dispose() error that echoes the secret is thrown redacted; every driver is still disposed', async () => {
    const disposed: string[] = [];
    const leaky: DriverFactory = {
      id: 'leaky',
      async create() {
        return {
          id: 'leaky',
          version: '1.0.0',
          capabilities: { verbs: ['click'], pixels: false, maskingProven: false, request: false, maxSessions: 1 },
          openSession: () => Promise.reject(new Error('unused')),
          selfCheck: async () => ({ ok: true, problems: [] }),
          dispose: () => {
            disposed.push('leaky');
            return Promise.reject(new Error(`cleanup failed for password ${SECRET}`));
          },
        };
      },
    };
    const fx = await makeFixture({ user: { secrets: { adminPassword: { env: 'ADMIN_PASSWORD' } } }, env: { ADMIN_PASSWORD: SECRET }, driverFactories: { leaky } });
    try {
      const engine = await createEngine(fx.config, { modules: fx.modules, env: { ADMIN_PASSWORD: SECRET } });
      await engine.doctor({ offline: true }); // creates every configured driver
      const err = await engine.close().then(() => undefined, (e: unknown) => e as AiBddError);
      expect(err).toBeInstanceOf(AiBddError);
      expect(err?.code).toBe('INTERNAL');
      expect(err?.message).toContain('engine close failed: cleanup failed for password <secret:adminPassword>');
      expect(err?.message).not.toContain(SECRET);
      expect(disposed).toEqual(['leaky']);
      expect(fx.world.driversDisposed, 'the other drivers were disposed as well').toEqual(['fake']);
    } finally {
      await rm(fx.world.tmp, { recursive: true, force: true });
    }
  });
});
