import { describe, expect, it } from 'vitest';
import { runDriverConformance } from './driver-conformance.ts';
import { miniAcme } from './mini-acme-driver.ts';

// The kit is applied to a correct in-memory driver: everything must pass.
runDriverConformance('mini-acme (kit self-test)', () => miniAcme(), { appUrl: 'http://localhost:4173', slowMs: 800 });

// Without appUrl only the identity and policy tests run; the app-dependent ones are skipped, not failed.
runDriverConformance('mini-acme without an app url (kit self-test)', () => miniAcme());

// Fault injection: each fault flips the exact behavior one conformance test guards. The assertions below
// are the same ones the kit makes, so a driver with the fault would fail the kit.
describe('fault injection against the mini driver (what each conformance test guards)', () => {
  async function run(faults: Parameters<typeof miniAcme>[0], scenario: (s: import('../../src/contracts/index.ts').DriverSession) => Promise<void>): Promise<unknown> {
    const factory = miniAcme(faults);
    const driver = await factory.create({ projectRoot: '.', policy: { allowHosts: ['localhost'], denyVerbs: [] }, artifactsDir: '.', baseURL: 'http://localhost:4173' });
    const session = await driver.openSession({ scenarioId: 'x', baseURL: 'http://localhost:4173', policy: { allowHosts: ['localhost'], denyVerbs: [] }, resolveValue: (v) => ('literal' in v ? v.literal : 'correct-horse-battery') });
    try {
      await scenario(session);
      return undefined;
    } catch (err) {
      return err;
    } finally {
      await session.close();
    }
  }

  it('R-RN2: a driver that accepts stale refs would be caught by the stale-ref test', async () => {
    const stale = await run({ acceptStaleRefs: true }, async (s) => {
      await s.perform({ verb: 'navigate', url: 'http://localhost:4173/login' });
      const old = await s.observe();
      await s.observe();
      const out = await s.perform({ verb: 'click', target: { ref: old.nodes.find((n) => n.name === 'Sign in' && n.role === 'button')?.ref ?? '' } });
      expect(out.error?.code).toBe('STALE_REF');
    });
    expect(stale).toBeDefined();
  });

  it('R-AG3: a driver without a navigation policy would be caught by the policy tests', async () => {
    const err = await run({ skipPolicy: true }, async (s) => {
      const out = await s.perform({ verb: 'navigate', url: 'javascript:alert(1)' });
      expect(out.ok).toBe(false);
    });
    expect(err).toBeDefined();
  });

  it('R-SE2: a driver that never taints would be caught by the taint test', async () => {
    const err = await run({ neverTaint: true }, async (s) => {
      await s.perform({ verb: 'navigate', url: 'http://localhost:4173/login' });
      const obs = await s.observe();
      await s.perform({ verb: 'fill', target: { ref: obs.nodes.find((n) => n.name === 'Password')?.ref ?? '' }, value: { secret: 'adminPassword' } });
      expect((await s.observe()).tainted).toBe(true);
    });
    expect(err).toBeDefined();
  });

  it('R-SE1: a driver that leaks the typed password is visible to the kit (value found in the tree)', async () => {
    let leaked = '';
    await run({ leakPassword: true }, async (s) => {
      await s.perform({ verb: 'navigate', url: 'http://localhost:4173/login' });
      const obs = await s.observe();
      await s.perform({ verb: 'fill', target: { ref: obs.nodes.find((n) => n.name === 'Password')?.ref ?? '' }, value: { secret: 'adminPassword' } });
      leaked = (await s.observe()).treeText;
    });
    expect(leaked).toContain('correct-horse-battery');
  });

  it('R-RN2: a driver that shares state between sessions would be caught by the isolation test', async () => {
    const factory = miniAcme({ shareState: true });
    const policy = { allowHosts: ['localhost'], denyVerbs: [] };
    const driver = await factory.create({ projectRoot: '.', policy, artifactsDir: '.', baseURL: 'http://localhost:4173' });
    const resolveValue = (v: { literal: string } | { param: string } | { secret: string }): string => ('literal' in v ? v.literal : 'x');
    const a = await driver.openSession({ scenarioId: 'a', baseURL: 'http://localhost:4173', policy, resolveValue });
    const b = await driver.openSession({ scenarioId: 'b', baseURL: 'http://localhost:4173', policy, resolveValue });
    await a.perform({ verb: 'navigate', url: 'http://localhost:4173/todos' });
    const obs = await a.observe();
    await a.perform({ verb: 'fill', target: { ref: obs.nodes.find((n) => n.name === 'New todo')?.ref ?? '' }, value: { literal: 'shared-marker' } });
    const filled = await a.observe();
    await a.perform({ verb: 'click', target: { ref: filled.nodes.find((n) => n.name === 'Add')?.ref ?? '' } });
    await b.perform({ verb: 'navigate', url: 'http://localhost:4173/todos' });
    expect((await b.observe()).nodes.some((n) => n.name.includes('shared-marker'))).toBe(true);
  });

  it('R-RN1: a driver that never reports busy would be caught by the /slow test', async () => {
    const err = await run({ neverBusy: true }, async (s) => {
      await s.perform({ verb: 'navigate', url: 'http://localhost:4173/slow?ms=800' });
      expect((await s.observe()).busy).toBe(true);
    });
    expect(err).toBeDefined();
  });
});
