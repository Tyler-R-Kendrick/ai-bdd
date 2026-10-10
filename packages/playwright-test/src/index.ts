import { dirname, resolve } from 'node:path';
import { loadPlansSync } from '@ai-bdd/sdk';
import type { Engine, ScenarioResult, Feature, Scenario, DocPlan } from '@ai-bdd/sdk/contracts';
import { sessionFromPage } from '@ai-bdd/driver-playwright';
import { getEngine, closeAiBddEngines } from './engine.ts';
import { collectScreenshots } from './evidence.ts';
import { failureMessage, formatSteps } from './format.ts';
import { normalizeTag, selectScenarios } from './select.ts';
import type { RegisterOptions, TestInfoLike, TestFixturesLike } from './types.ts';

export type { RegisterOptions, TestLike, TestInfoLike, TestFixturesLike } from './types.ts';
export { closeAiBddEngines } from './engine.ts';

const DEFAULT_PLAN_DIR = '.ai-bdd/plans';

/** Where plans are read from. Done before any config is loaded, because collection is synchronous (R-SDK1). */
export function resolvePlanDir(opts: Pick<RegisterOptions, 'configPath' | 'planDir'>): string {
  const base = opts.configPath === undefined ? process.cwd() : dirname(resolve(process.cwd(), opts.configPath));
  return resolve(base, opts.planDir ?? DEFAULT_PLAN_DIR);
}

function playwrightTags(scenario: Scenario): string[] {
  const tags = new Set<string>();
  for (const raw of scenario.tags) {
    const name = normalizeTag(raw).replace(/\s+/g, '-');
    if (name.length > 0) tags.add(`@${name}`);
  }
  return [...tags];
}

/** Returns `title`, or a stable disambiguated variant when the title was already used in this scope. */
function uniqueTitle(used: Set<string>, title: string, ...qualifiers: string[]): string {
  let candidate = title;
  for (const q of qualifiers) {
    if (!used.has(candidate)) break;
    candidate = `${title} (${q})`;
  }
  used.add(candidate);
  return candidate;
}

async function attachEvidence(testInfo: TestInfoLike, engine: Engine, result: ScenarioResult): Promise<void> {
  await testInfo.attach('ai-bdd-result.json', {
    body: `${JSON.stringify(result, null, 2)}\n`,
    contentType: 'application/json',
  });
  await testInfo.attach('ai-bdd-steps.txt', { body: formatSteps(result), contentType: 'text/plain' });
  for (const shot of await collectScreenshots(engine.config.runsDir, result.steps)) {
    await testInfo.attach(shot.name, { body: shot.body, contentType: 'image/png' });
  }
}

function annotate(testInfo: TestInfoLike, plan: DocPlan, scenario: Scenario, result: ScenarioResult): void {
  const add = (type: string, description: string): void => {
    testInfo.annotations.push({ type, description });
  };
  add('ai-bdd:scenario', scenario.id);
  add('ai-bdd:source', plan.docUri);
  add('ai-bdd:mode', `${result.mode} (recording ${result.recording})`);
  result.steps.forEach((step, i) => {
    const label = `step ${i + 1} ${step.kind}: ${step.text}`;
    if (step.status === 'healed') add('healed', label);
    if (step.determinism === 'fuzzy') {
      add('fuzzy', step.fuzzyReasons.length > 0 ? `${label} [${step.fuzzyReasons.join(', ')}]` : label);
    }
  });
}

async function runScenarioTest(
  args: { plan: DocPlan; feature: Feature; scenario: Scenario; opts: RegisterOptions },
  fixtures: TestFixturesLike,
  testInfo: TestInfoLike,
): Promise<void> {
  const { plan, feature, scenario, opts } = args;
  const engine = await getEngine(opts.configPath);
  const { config } = engine;
  const ctx = { policy: config.policy, ...(config.baseURL === undefined ? {} : { baseURL: config.baseURL }) };

  let result: ScenarioResult;
  try {
    // R-SDK3: the engine builds the SessionOptions; the host framework supplies the page.
    result = await engine.runScenario(scenario.id, {
      sessionFactory: (sessionOpts) => sessionFromPage(fixtures.page, sessionOpts, ctx),
    });
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'SCENARIO_NOT_FOUND') {
      throw new Error(
        `ai-bdd scenario "${scenario.id}" is in the plans read at collection time (${resolvePlanDir(opts)}) but not in ` +
          `the plans of the engine (${config.planDir}). Pass the matching planDir to registerAiBddScenarios.`,
        { cause: error },
      );
    }
    throw error;
  }

  annotate(testInfo, plan, scenario, result);
  await attachEvidence(testInfo, engine, result);

  const message = failureMessage(`${feature.title} > ${scenario.title}`, result, opts.failOnHealed === true);
  if (message !== null) throw new Error(message);
}

/**
 * Registers every non-rejected scenario of the committed plans as a Playwright test:
 * `test.describe(feature.title)` containing `test(scenario.title, ...)`.
 *
 * Registration is synchronous (R-SDK1): it reads the plan files and calls no model, driver or network. The engine
 * is created lazily by the first test of each worker. Each test adopts the Playwright `page` through the engine's
 * `sessionFactory` (R-SDK3), attaches the step results and screenshots, annotates healed and fuzzy steps, and fails
 * unless the scenario ended `passed` (or `healed`, unless `failOnHealed`).
 */
export function registerAiBddScenarios(opts: RegisterOptions): void {
  const planDir = resolvePlanDir(opts);
  const plans = loadPlansSync(planDir);
  const groups = selectScenarios(plans, opts.filter);

  const usedFeatureTitles = new Set<string>();
  for (const { plan, feature, scenarios } of groups) {
    const featureTitle = uniqueTitle(usedFeatureTitles, feature.title, plan.docUri, feature.id);
    opts.test.describe(featureTitle, () => {
      const usedScenarioTitles = new Set<string>();
      for (const scenario of scenarios) {
        const title = uniqueTitle(usedScenarioTitles, scenario.title, scenario.id);
        opts.test(title, { tag: playwrightTags(scenario) }, (fixtures, testInfo) =>
          runScenarioTest({ plan, feature, scenario, opts }, fixtures, testInfo),
        );
      }
    });
  }

  if (groups.length === 0) {
    console.warn(`ai-bdd: no scenarios registered from ${planDir} (run \`ai-bdd compile\`, or check planDir and the filter)`);
  } else if (typeof opts.test.afterAll === 'function') {
    // File-level hook: Playwright runs it once per worker after that worker's last test in this file. It is the
    // closest thing to a worker teardown available through the `test` object alone (see the README).
    opts.test.afterAll(() => closeAiBddEngines());
  }
}
