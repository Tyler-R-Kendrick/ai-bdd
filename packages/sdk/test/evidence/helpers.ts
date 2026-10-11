import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionOutcome, Clock, DriverCapabilities, DriverSession, Observation } from '../../src/contracts/index.ts';

export const FC_RUNS = Number(process.env['FC_RUNS'] ?? 200);

export interface FakeClock extends Clock { readonly time: number; readonly sleeps: number[] }

/** Virtual time: sleep advances `now` instantly; honors AbortSignal like the real clock. */
export function fakeClock(start = 1_000): FakeClock {
  let t = start;
  const sleeps: number[] = [];
  return {
    get time() { return t; },
    sleeps,
    now: () => t,
    sleep: async (ms, signal) => {
      if (signal?.aborted === true) throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
      sleeps.push(ms);
      t += ms;
    },
  };
}

export function obs(hash: string, opts: { busy?: boolean; pixels?: boolean } = {}): Observation {
  const o: Observation = { revision: 0, route: '/', nodes: [], busy: opts.busy ?? false, tainted: false, treeText: hash, treeHash: hash };
  if (opts.pixels === true) o.screenshot = { png: new Uint8Array([1, 2, 3]), sha256: 'a'.repeat(64), masked: false };
  return o;
}

const caps: DriverCapabilities = { verbs: ['click'], pixels: true, maskingProven: false, request: false, maxSessions: 1 };

export interface ScriptedSession extends DriverSession { readonly calls: { pixels: boolean }[] }

/**
 * Session whose observation is a function of the poll index (0-based, counting every observe call)
 * and whether pixels were requested.
 */
export function scriptedSession(script: (index: number, pixels: boolean) => Observation): ScriptedSession {
  const calls: { pixels: boolean }[] = [];
  const ok: ActionOutcome = { ok: true };
  return {
    id: 's1', driverId: 'fake', driverVersion: '1.0.0', capabilities: caps, calls,
    observe: async (o) => {
      const pixels = o?.pixels === true;
      calls.push({ pixels });
      const base = script(calls.length - 1, pixels);
      return pixels && base.screenshot === undefined ? { ...base, screenshot: obs('x', { pixels: true }).screenshot as NonNullable<Observation['screenshot']> } : base;
    },
    perform: async () => ok,
    close: async () => undefined,
  };
}

export async function tempDir(): Promise<{ dir: string; cleanup(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'ai-bdd-evidence-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export async function allFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(root, { withFileTypes: true })) {
    const p = join(root, e.name);
    if (e.isDirectory()) out.push(...(await allFiles(p)));
    else out.push(p);
  }
  return out.sort();
}

/** Concatenated bytes (latin1) of every file under root, with file names, for leak searches. */
export async function dumpTree(root: string): Promise<string> {
  const parts: string[] = [];
  for (const f of await allFiles(root)) parts.push(f, (await readFile(f)).toString('latin1'));
  return parts.join('\n');
}
