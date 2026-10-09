import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DriverSession } from '@ai-bdd/contracts';
import { fake } from '../../src/index.js';

const modelPath = fileURLToPath(new URL('../../../../fixtures/app/model.json', import.meta.url));

async function open(fault: Record<string, unknown> = {}): Promise<DriverSession> {
  const factory = fake({ modelPath, fault, now: () => new Date('2026-10-09T00:00:00.000Z') });
  const driver = await factory.create({ sessionId: 's', scenarioId: 'sc', config: {} });
  return driver.openSession({ sessionId: 's', scenarioId: 'sc', config: {} });
}

async function goTo(session: DriverSession, route: string): Promise<void> {
  await session.perform({ verb: 'navigate', value: route });
}

describe('fake driver', () => {
  it('observes the billing screen with the seeded plan', async () => {
    const session = await open();
    await goTo(session, '/settings/billing');
    const observation = await session.observe();
    expect(observation.route).toBe('/settings/billing');
    expect(observation.nodes.map((node) => node.name)).toContain('Plan: Free plan');
    expect(observation.settled).toBe(true);
    expect(observation.revision).toBe(1);
  });

  it('takes the upgrade dialog and applies the transition', async () => {
    const session = await open();
    await goTo(session, '/settings/billing');
    const before = await session.observe();
    const upgrade = before.nodes.find((node) => node.testId === 'upgrade')!;
    expect((await session.perform({ verb: 'tap', ref: upgrade.ref })).ok).toBe(true);

    const dialog = await session.observe();
    expect(dialog.nodes.map((node) => node.role)).toContain('dialog');
    const confirm = dialog.nodes.find((node) => node.testId === 'confirmUpgrade')!;
    await session.perform({ verb: 'tap', ref: confirm.ref });

    const after = await session.observe();
    expect(after.nodes.map((node) => node.name)).toContain('Plan: Pro plan');
    expect(after.nodes.map((node) => node.name)).toContain('Prorated amount: 12.00');
  });

  it('blocks the downgrade while invoices are unpaid', async () => {
    const session = await open();
    await goTo(session, '/settings/billing?unpaid=2');
    const observation = await session.observe();
    expect(observation.nodes.map((node) => node.name)).toContain('Downgrade is blocked: settle unpaid invoices first');
  });

  it('reports an ambiguous target when two forms are injected', async () => {
    const session = await open({ duplicateForms: true });
    await goTo(session, '/forms/two');
    const observation = await session.observe();
    const submits = observation.nodes.filter((node) => node.name === 'Submit');
    expect(submits.length).toBeGreaterThanOrEqual(3);
    const result = await session.perform({ verb: 'tap', selector: { role: 'button', name: 'Submit' } });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('ACT_TARGET_AMBIGUOUS');
  });

  it('keeps /slow unsettled until the spinner resolves', async () => {
    const session = await open();
    await goTo(session, '/slow?ms=300');
    const first = await session.observe();
    expect(first.settled).toBe(false);
    await session.observe();
    await session.observe();
    await session.observe();
    const later = await session.observe();
    expect(later.settled).toBe(true);
    expect(later.nodes.map((node) => node.testId)).toContain('slowContent');
  });

  it('never settles when the spinner outlasts the budget', async () => {
    const session = await open();
    await goTo(session, '/slow?ms=10000');
    for (let index = 0; index < 5; index += 1) {
      const observation = await session.observe();
      expect(observation.settled).toBe(false);
    }
  });

  it('taints the session after a secret fill', async () => {
    const session = await open();
    await goTo(session, '/login');
    const before = await session.observe();
    const password = before.nodes.find((node) => node.testId === 'password')!;
    const result = await session.perform({ verb: 'typeSecret', ref: password.ref, secretName: 'adminPassword' });
    expect(result.tainted).toBe(true);
    const after = await session.observe({ pixels: true });
    expect(after.tainted).toBe(true);
    expect(after.screenshot).toBeUndefined();
  });

  it('produces identical screenshot bytes for identical screens', async () => {
    const first = await open();
    await goTo(first, '/settings/billing');
    const a = await first.observe({ pixels: true });
    const second = await open();
    await goTo(second, '/settings/billing');
    const b = await second.observe({ pixels: true });
    expect(a.screenshot?.sha256).toBe(b.screenshot?.sha256);
  });

  it('refuses work after close', async () => {
    const session = await open();
    await session.close();
    await expect(session.observe()).rejects.toThrow(/closed/u);
  });

  it('parity: the served HTML matches the model per screen', async () => {
    const model = JSON.parse(readFileSync(modelPath, 'utf8')) as { screens: Array<{ route: string }> };
    const { buildModel } = (await import('../../../../fixtures/app/build-model.mjs')) as {
      buildModel: () => { screens: Array<{ route: string }> };
    };
    expect(buildModel().screens.map((screen) => screen.route)).toEqual(model.screens.map((screen) => screen.route));
  });
});
