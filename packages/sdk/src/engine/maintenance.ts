import {
  AiBddError,
  type Engine,
  type ModelPurpose,
} from '../contracts/index.ts';
import { analyze } from './compile.ts';
import { assertOutputDirs } from './guard.ts';
import type { Core } from './core.ts';
import { allTargets } from './scenarios.ts';
import { PURPOSES } from './usage.ts';
import { errorMessage } from './util.ts';

export async function review(core: Core, id: string, action: 'accept' | 'reject' | 'pin' | 'unpin'): Promise<void> {
  core.assertOpen();
  await assertOutputDirs(core.config, ['plans'], ['plans']);
  const store = core.planStore();
  const plans = await store.loadAll();
  const plan = plans.find((p) => p.features.some((f) => f.id === id || f.scenarios.some((s) => s.id === id)));
  if (plan === undefined) throw new AiBddError('SCENARIO_NOT_FOUND', `No feature or scenario with id "${id}" in any plan`, { details: { id } });
  await store.save(core.planner().review(plan, id, action));
}

/** Remove recordings whose scenario is in no plan. Refuses to delete when recordings are read-only. */
export async function prune(core: Core, opts: { dryRun?: boolean } = {}): Promise<{ removed: string[] }> {
  core.assertOpen();
  await assertOutputDirs(core.config, ['plans', 'recordings'], opts.dryRun === true ? [] : ['recordings']);
  const known = new Set(allTargets(await core.planStore().loadAll()).map((t) => t.scenario.id));
  const store = core.recordings();
  const orphans = (await store.list()).filter((r) => !known.has(r.scenarioId));
  const removed = orphans.map((r) => `${r.driverId}/${r.scenarioId}`).sort();
  if (opts.dryRun === true || orphans.length === 0) return { removed };
  if (core.config.recordingsMode === 'read-only') {
    throw new AiBddError('RECORDING_READ_ONLY', 'Recordings are read-only; refusing to prune. Set AI_BDD_RECORDINGS=read-write to override.');
  }
  for (const r of orphans) await store.remove(r.driverId, r.scenarioId);
  return { removed };
}

type DoctorResult = Awaited<ReturnType<Engine['doctor']>>;

function nodeAtLeast(version: string, min: [number, number]): boolean {
  const [major = 0, minor = 0] = version.split('.').map((n) => Number.parseInt(n, 10));
  return major > min[0] || (major === min[0] && minor >= min[1]);
}

/** Diagnostics only: never throws, reports missing drivers and unreachable models as failed checks. */
export async function doctor(core: Core, opts: { offline?: boolean } = {}): Promise<DoctorResult> {
  const checks: DoctorResult['checks'] = [];
  const add = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };
  const { config } = core;

  add('node', nodeAtLeast(process.versions.node, [22, 18]), `Node ${process.versions.node} (requires >= 22.18.0)`);
  add('config', true, config.configPath === undefined ? `no config file (project ${config.projectRoot})` : `loaded ${config.configPath}`);

  const names = Object.keys(config.drivers);
  if (names.length === 0) add('drivers', false, 'no drivers configured');
  else if (config.defaultDriver === undefined) add('drivers', false, `no defaultDriver set (configured: ${names.join(', ')})`);
  else if (config.drivers[config.defaultDriver] === undefined) add('drivers', false, `defaultDriver "${config.defaultDriver}" is not a configured driver (${names.join(', ')})`);
  else add('drivers', true, `${names.length} driver(s), default "${config.defaultDriver}"`);

  for (const name of names) {
    try {
      await core.ensureDrivers([name]);
      const driver = core.driverMap.get(name);
      if (driver === undefined) {
        add(`driver:${name}`, false, 'driver was not created');
        continue;
      }
      const res = await driver.selfCheck();
      add(`driver:${name}`, res.ok, res.ok ? `${driver.id}@${driver.version} ok` : res.problems.join('; ') || 'selfCheck failed');
    } catch (err) {
      add(`driver:${name}`, false, errorMessage(err));
    }
  }

  if (config.models === undefined) {
    add('models', false, 'no models configured (set "models" in the config)');
  } else if (opts.offline === true) {
    add('models', true, 'reachability skipped (offline)');
  } else {
    const seen = new Map<string, ModelPurpose[]>();
    for (const p of PURPOSES) {
      const model = config.models[p];
      seen.set(model.id, [...(seen.get(model.id) ?? []), p]);
    }
    for (const [id, purposes] of seen) {
      const model = config.models[purposes[0] as ModelPurpose];
      try {
        await model.generate({
          purpose: purposes[0] as ModelPurpose,
          system: 'Connectivity check. Reply with OK.',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
          maxOutputTokens: 8,
          context: { doctor: true },
        });
        add(`model:${id}`, true, `reachable (${purposes.join(', ')})`);
      } catch (err) {
        // The model answered with an error that is not about availability (e.g. no scripted rule): it is reachable.
        const reachable = err instanceof AiBddError && err.code !== 'MODEL_UNAVAILABLE' && err.code !== 'INTERNAL';
        add(`model:${id}`, reachable, reachable ? `reachable (${purposes.join(', ')}); answered with ${(err as AiBddError).code}` : errorMessage(err));
      }
    }
  }

  try {
    const { status } = await analyze(core);
    const count = (s: string): number => status.docs.filter((d) => d.state === s).length;
    const stale = count('stale') + count('orphaned');
    const detail = `${status.docs.length} doc(s): ${count('fresh')} fresh, ${count('stale')} stale, ${count('new')} not compiled, ${count('orphaned')} orphaned`;
    add('plans', stale === 0, detail);
  } catch (err) {
    add('plans', false, errorMessage(err));
  }

  return { ok: checks.every((c) => c.ok), checks };
}
