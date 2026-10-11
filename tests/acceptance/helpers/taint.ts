import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import type { DriverSession, Policy, ValueSource } from '@ai-bdd/sdk/contracts';
import { SPECIAL_PASSWORD } from './flows.ts';
import type { DriverTarget } from './targets.ts';

export interface TaintProbe {
  taintedBefore: boolean;
  taintedAfter: boolean;
  maskingProven: boolean;
  screenshotMasked: boolean | undefined;
  stalePasswordValue: string | undefined;
}

/** Drive a driver session directly: open /login, fill the password with {secret} and look at taint and screenshots (R-SE2). */
export async function taintProbe(target: DriverTarget): Promise<TaintProbe> {
  const prepared = await target.prepare({ adminPassword: SPECIAL_PASSWORD });
  const dir = mkdtempSync(join(tmpdir(), 'taint-'));
  const policy: Policy = { allowHosts: ['localhost', '127.0.0.1', '[::1]'], denyVerbs: [] };
  const driver = await prepared.factory.create({ projectRoot: dir, baseURL: prepared.baseURL, policy, artifactsDir: dir });
  let session: DriverSession | undefined;
  try {
    const resolveValue = (v: ValueSource): string => ('secret' in v ? SPECIAL_PASSWORD : 'literal' in v ? v.literal : '');
    session = await driver.openSession({ scenarioId: 'taint-probe', baseURL: prepared.baseURL, policy, resolveValue });
    const nav = await session.perform({ verb: 'navigate', url: '/login' });
    expect(nav.ok, JSON.stringify(nav)).toBe(true);
    const before = await session.observe();
    const field = before.nodes.find((n) => n.role === 'textbox' && n.name === 'Password');
    expect(field, 'Password textbox').toBeDefined();
    const filled = await session.perform({ verb: 'fill', target: { ref: (field as { ref: string }).ref }, value: { secret: 'adminPassword' } });
    expect(filled.ok, JSON.stringify(filled)).toBe(true);
    const after = await session.observe({ pixels: true });
    const passwordNode = after.nodes.find((n) => n.role === 'textbox' && n.name === 'Password');
    return {
      taintedBefore: before.tainted,
      taintedAfter: after.tainted,
      maskingProven: session.capabilities.maskingProven,
      screenshotMasked: after.screenshot?.masked,
      stalePasswordValue: passwordNode?.value,
    };
  } finally {
    await session?.close();
    await driver.dispose();
    await prepared.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

export function expectTaintProbe(p: TaintProbe): void {
  expect(p.taintedBefore).toBe(false);
  expect(p.taintedAfter).toBe(true);
  expect(p.maskingProven).toBe(true);
  expect(p.screenshotMasked).toBe(true);
  // the observation never exposes the secret value (V4)
  expect(p.stalePasswordValue ?? '').not.toContain(SPECIAL_PASSWORD);
}
