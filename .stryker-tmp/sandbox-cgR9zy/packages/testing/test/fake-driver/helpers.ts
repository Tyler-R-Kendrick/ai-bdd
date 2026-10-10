// @ts-nocheck
import type { Driver, DriverSession, ObservedNode, Observation, Policy, SessionOptions, ValueSource } from '@ai-bdd/sdk/contracts';
import { fakeDriver } from '../../src/fake-driver/index.ts';

export const POLICY: Policy = { allowHosts: ['localhost', '127.0.0.1', '[::1]'], denyVerbs: [] };
export const BASE = 'http://localhost:4173';

export const secrets: Record<string, string> = { adminPassword: 'correct-horse-battery' };
export const params: Record<string, string> = {};

export function resolveValue(v: ValueSource): string {
  if ('literal' in v) return v.literal;
  if ('param' in v) return params[v.param] ?? '';
  return secrets[v.secret] ?? '';
}

export function sessionOptions(over: Partial<SessionOptions> = {}): SessionOptions {
  return { scenarioId: 'test', baseURL: BASE, policy: POLICY, resolveValue, ...over };
}

export async function openDriver(opts: Parameters<typeof fakeDriver>[0] = {}): Promise<Driver> {
  return fakeDriver(opts).create({ projectRoot: '/tmp', baseURL: BASE, policy: POLICY, artifactsDir: '/tmp/artifacts' });
}

export async function openSession(opts: Parameters<typeof fakeDriver>[0] = {}, so: Partial<SessionOptions> = {}): Promise<DriverSession> {
  const driver = await openDriver(opts);
  return driver.openSession(sessionOptions(so));
}

export function find(obs: Observation, role: string, name: string, nth = 0): ObservedNode {
  const hits = obs.nodes.filter((n) => n.role === role && n.name === name);
  const hit = hits[nth];
  if (hit === undefined) throw new Error(`no ${role} "${name}" in:\n${obs.treeText}`);
  return hit;
}

export const has = (obs: Observation, role: string, name: string): boolean => obs.nodes.some((n) => n.role === role && n.name === name);

/** navigate + observe */
export async function goto(session: DriverSession, path: string): Promise<Observation> {
  const out = await session.perform({ verb: 'navigate', url: path });
  if (!out.ok) throw new Error(`navigate ${path} failed: ${JSON.stringify(out.error)}`);
  return session.observe();
}

export async function click(session: DriverSession, role: string, name: string, nth = 0): Promise<Observation> {
  const obs = await session.observe();
  const out = await session.perform({ verb: 'click', target: { ref: find(obs, role, name, nth).ref } });
  if (!out.ok) throw new Error(`click ${role} "${name}" failed: ${JSON.stringify(out.error)}`);
  return session.observe();
}

export async function fill(session: DriverSession, name: string, value: { literal: string } | { secret: string }, nth = 0): Promise<void> {
  const obs = await session.observe();
  const out = await session.perform({ verb: 'fill', target: { ref: find(obs, 'textbox', name, nth).ref }, value });
  if (!out.ok) throw new Error(`fill "${name}" failed: ${JSON.stringify(out.error)}`);
}
