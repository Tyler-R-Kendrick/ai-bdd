import { resolve } from 'node:path';
import { AiBddError, type CompileOptions, type Engine, type ResolvedConfig } from '../contracts/index.ts';
import { compile, analyze } from './compile.ts';
import { Core } from './core.ts';
import { doctor, prune, review } from './maintenance.ts';
import { defaultModules, systemClock, type EngineOverrides } from './modules.ts';
import { guardRecordingsMode, run, runTarget } from './run.ts';
import { findTarget, selectTargets } from './scenarios.ts';
import { redactFeatureResults } from './report.ts';
import { buildFeatureResults, loadFeatureResults, saveFeatureResults } from '../verification/index.ts';

/** One engine per config object (idempotent) unless overrides are given. */
const cache = new WeakMap<ResolvedConfig, Engine>();

/**
 * Create an engine. Cheap: sibling modules, drivers, run directories and the redactor are all created lazily on first use.
 * `overrides.modules` (internal) replaces any sibling module factory, which is how the unit tests inject fakes.
 */
export async function createEngine(config: ResolvedConfig, overrides?: EngineOverrides): Promise<Engine> {
  if (overrides === undefined) {
    const cached = cache.get(config);
    if (cached !== undefined) return cached;
  }
  const modules = { ...defaultModules(), ...(overrides?.modules ?? {}) };
  const core = new Core(
    config,
    modules,
    overrides?.clock ?? systemClock,
    overrides?.env ?? process.env,
    overrides?.models ?? config.models,
    overrides?.drivers ?? config.drivers,
  );

  const engine: Engine = {
    config,
    compile: (opts?: CompileOptions) => compile(core, opts),
    async status() {
      core.assertOpen();
      return (await analyze(core)).status;
    },
    plans() {
      core.assertOpen();
      return core.planStore().loadAll();
    },
    async listScenarios(filter) {
      core.assertOpen();
      return selectTargets(await core.planStore().loadAll(), filter);
    },
    review: (id, action) => review(core, id, action),
    async runScenario(scenarioId, opts) {
      core.assertOpen();
      guardRecordingsMode(core, opts?.updateRecordings === true);
      const target = findTarget(await core.planStore().loadAll(), scenarioId);
      const result = await runTarget(core, target, opts);
      core.scenarioResults.set(result.scenarioId, result);
      return result;
    },
    async featureResult(featureId) {
      core.assertOpen();
      const plans = await core.planStore().loadAll();
      const feature = plans.flatMap((plan) => plan.features).find((candidate) => candidate.id === featureId);
      if (feature === undefined) throw new AiBddError('SCENARIO_NOT_FOUND', `no feature with id ${JSON.stringify(featureId)}`, { details: { id: featureId } });
      const evidence = await core.sharedEvidence();
      const features = await buildFeatureResults({
        config, plans, results: [...core.scenarioResults.values()], previous: await loadFeatureResults(config), evidence,
        runId: evidence.runId, lastRunAt: new Date(core.clock.now()).toISOString(), selective: true,
      });
      const safe = redactFeatureResults(core.redactor(), features);
      await saveFeatureResults(config, safe);
      const result = safe.find((candidate) => candidate.featureId === featureId);
      if (result === undefined) throw new AiBddError('INTERNAL', `feature result was not created for ${featureId}`);
      return result;
    },
    run: (opts) => run(core, opts),
    verifyRun(runDir) {
      core.assertOpen();
      return modules.verifyRun(resolve(config.projectRoot, runDir));
    },
    prune: (opts) => prune(core, opts),
    doctor: (opts) => doctor(core, opts),
    on: (listener) => core.on(listener),
    async close() {
      if (cache.get(config) === engine) cache.delete(config);
      await core.close();
    },
  };
  if (overrides === undefined) cache.set(config, engine);
  return engine;
}
