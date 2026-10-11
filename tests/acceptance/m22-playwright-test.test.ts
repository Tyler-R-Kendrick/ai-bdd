import { afterEach, describe, expect, it } from 'vitest';
import { createEngine, loadConfig, loadPlansSync } from '@ai-bdd/sdk';
import type { DriverSession, ScenarioResult } from '@ai-bdd/sdk/contracts';
import { createFakeModels, fakeDriver } from '@ai-bdd/testing';
import { virtualClock } from './helpers/clock.ts';
import { countByPurpose } from './helpers/calls.ts';
import { openEngine } from './helpers/engine.ts';
import { ACME_DEFAULT_ADMIN_PASSWORD } from './helpers/paths.ts';
import { readPlans, readRecordings } from './helpers/plans.ts';
import { createProject, type Project } from './helpers/project.ts';

let project: Project | undefined;
afterEach(() => {
  project?.cleanup();
  project = undefined;
});

describe('M22 embedding ai-bdd in another test framework (SDK contract, fake driver)', () => {
  it('M22 R-SDK1 R-SDK3: plans load synchronously with no model call; runScenario adopts the host framework session through sessionFactory', async () => {
    const p = createProject({ docs: ['billing'] });
    project = p;
    const compileHandle = await openEngine(p);
    await compileHandle.compile();
    await compileHandle.close();

    // R-SDK1: collection time. Synchronous, reads committed JSON only.
    const plans = loadPlansSync(p.plansDir);
    expect(plans.map((x) => x.docUri)).toEqual(['docs/billing.md']);
    expect(readPlans(p)).toEqual(plans);

    // the host framework owns the driver/session: this is the whole integration (SPEC section 4)
    const env = { ACME_ADMIN_PASSWORD: ACME_DEFAULT_ADMIN_PASSWORD };
    const config = { ...(await loadConfig({ cwd: p.dir, env })), baseURL: 'http://localhost:4173' };
    const models = createFakeModels({ rulesDir: p.rulesDir });
    const hostDriver = await fakeDriver({}).create({ projectRoot: p.dir, baseURL: config.baseURL, policy: config.policy, artifactsDir: p.path('host-artifacts') });
    const engine = await createEngine(config, { models, drivers: { fake: fakeDriver({}) }, clock: virtualClock(), env });
    const adopted: DriverSession[] = [];
    const results: ScenarioResult[] = [];
    try {
      for (const plan of plans) {
        for (const f of plan.features) {
          for (const s of f.scenarios) {
            if (s.review === 'rejected') continue;
            const r = await engine.runScenario(s.id, {
              driver: 'fake',
              sessionFactory: async (o) => {
                const session = await hostDriver.openSession(o);
                adopted.push(session);
                return session;
              },
            });
            results.push(r);
          }
        }
      }
    } finally {
      await engine.close();
      await hostDriver.dispose();
    }
    expect(results).toHaveLength(5);
    for (const r of results) expect(r.status, `${r.title}`).toBe('passed');
    expect(adopted.length).toBeGreaterThanOrEqual(results.length);
    // the adopted session's driver id selects the recordings directory
    const files = readRecordings(p);
    expect(files.length).toBeGreaterThan(0);
    expect(new Set(files.map((x) => x.driverId))).toEqual(new Set(['fake']));
    // the engine used the models only for what the host cannot do (acting, checks, judging)
    const counts = countByPurpose(models.calls as never);
    expect(counts.extract).toBe(0);
    expect(counts.act + counts.checkgen + counts.judge).toBeGreaterThan(0);
  });
});
