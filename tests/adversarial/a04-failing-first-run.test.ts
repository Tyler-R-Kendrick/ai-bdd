// Attack 4: get a recording committed from a failing (or otherwise not-clean) first run.
// R-CH1: a recording is persisted only if the WHOLE scenario passes the document oracle, in read-write mode, after the confirm runs.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeDriver } from '@ai-bdd/testing';
import type { DriverFactory } from '@ai-bdd/sdk/contracts';
import {
  ACME_DEFAULT_ADMIN_PASSWORD,
  compose,
  createProject,
  fakeTarget,
  judgeSays,
  openEngine,
  overriding,
  readRecordings,
  scenarioId,
  toolCall,
  walkFiles,
  type Project,
} from './helpers/kit.ts';

let project: Project | undefined;
afterEach(() => {
  project?.cleanup();
  project = undefined;
});

const UPGRADE = 'Upgrade from Free to Pro';
const LAST_THEN = 'an upgrade confirmation message appears';
const MIDDLE_WHEN = 'the customer confirms the upgrade';

/** No file at all below the recordings directory (not even an empty temp file). */
const noRecordingFiles = (p: Project): string[] => walkFiles(p.recordingsDir);

/** Fresh session #1 is healthy, every later session (the confirm run) runs the `bug-upgrade-noop` flag. */
function flakyAcrossSessions(): (f: DriverFactory) => DriverFactory {
  return (factory) => ({
    id: factory.id,
    async create(ctx) {
      const good = await factory.create(ctx);
      const bad = await fakeDriver({ flags: ['bug-upgrade-noop'], adminPassword: ACME_DEFAULT_ADMIN_PASSWORD }).create(ctx);
      let n = 0;
      return { ...good, openSession: (o) => (n++ === 0 ? good : bad).openSession(o), dispose: async () => { await good.dispose(); await bad.dispose(); } };
    },
  });
}

describe('A4 R-CH1 R-CH2 R-CH6 no recording from a failing first run', () => {
  it('A4 R-CH1: the judge fails ONLY the last assertion after five clean steps: the scenario fails, nothing is written, not even a partial file', async () => {
    project = createProject({ docs: ['billing'] });
    const h = await openEngine(project, { models: overriding('judge', (req) => (String(req.context['criterion']).includes(LAST_THEN) ? judgeSays('fails', 0.05) : undefined)) });
    await h.compile();
    const r = await h.runScenario(UPGRADE);
    await h.close();
    expect(r.status).toBe('failed');
    expect(r.recording).toBe('discarded');
    expect(r.steps.filter((s) => s.status === 'passed').length).toBe(5);
    expect(r.steps.at(-1)?.error?.code).toBe('JUDGE_FAILED');
    expect(noRecordingFiles(project)).toEqual([]);
  });

  it('A4 R-CH1 R-JU2: an inconclusive judge (score inside the band) is not a pass: nothing is recorded', async () => {
    project = createProject({ docs: ['billing'] });
    const h = await openEngine(project, { models: overriding('judge', (req) => (String(req.context['criterion']).includes(LAST_THEN) ? judgeSays('holds', 0.6) : undefined)) });
    await h.compile();
    const r = await h.runScenario(UPGRADE);
    await h.close();
    expect(r.status).toBe('inconclusive');
    expect(r.recording).toBe('discarded');
    expect(noRecordingFiles(project)).toEqual([]);
  });

  it('A4 R-CH1: a "cannot_tell" judge never passes, whatever probability it reports', async () => {
    project = createProject({ docs: ['billing'] });
    const h = await openEngine(project, { models: overriding('judge', (req) => (String(req.context['criterion']).includes(LAST_THEN) ? judgeSays('cannot_tell', 1) : undefined)) });
    await h.compile();
    const r = await h.runScenario(UPGRADE);
    await h.close();
    expect(r.status).toBe('inconclusive');
    expect(noRecordingFiles(project)).toEqual([]);
  });

  it('A4 R-CH1: a judge that contradicts itself (verdict "fails" with probability 0.99, verdict "holds" with probability 0.01) cannot pass', async () => {
    project = createProject({ docs: ['billing'] });
    for (const lie of [judgeSays('fails', 0.99), judgeSays('holds', 0.01)]) {
      const h = await openEngine(project, { models: overriding('judge', (req) => (String(req.context['criterion']).includes(LAST_THEN) ? lie : undefined)) });
      await h.compile();
      const r = await h.runScenario(UPGRADE);
      await h.close();
      expect(r.status, JSON.stringify(lie)).not.toBe('passed');
      expect(noRecordingFiles(project)).toEqual([]);
    }
  });

  it('A4 R-CH1: the agent reports "blocked" on a middle step: the scenario fails and nothing is written', async () => {
    project = createProject({ docs: ['billing'] });
    const h = await openEngine(project, { models: overriding('act', (req) => (req.context['stepText'] === MIDDLE_WHEN ? toolCall('complete_step', { status: 'blocked', summary: 'cannot find it' }) : undefined)) });
    await h.compile();
    const r = await h.runScenario(UPGRADE);
    await h.close();
    expect(r.status).toBe('failed');
    expect(r.steps.find((s) => s.text === MIDDLE_WHEN)?.error?.code).toBe('ACT_BLOCKED');
    expect(r.recording).toBe('discarded');
    expect(noRecordingFiles(project)).toEqual([]);
  });

  it('A4 R-CH1: the agent runs out of model calls (never completes the step): ACT_BUDGET_EXHAUSTED, nothing is written', async () => {
    project = createProject({ docs: ['billing'], options: { agent: { maxModelCalls: 3 } } });
    const h = await openEngine(project, { models: overriding('act', (req) => (req.context['stepText'] === MIDDLE_WHEN ? toolCall('wait', { ms: 1 }) : undefined)) });
    await h.compile();
    const r = await h.runScenario(UPGRADE);
    await h.close();
    expect(r.status).toBe('failed');
    expect(r.steps.find((s) => s.text === MIDDLE_WHEN)?.error?.code).toBe('ACT_BUDGET_EXHAUSTED');
    expect(noRecordingFiles(project)).toEqual([]);
  });

  it('A4 R-CH1 R-SE1: a missing secret makes the step (and so the scenario) an error: nothing is written', async () => {
    project = createProject({ docs: ['login'] });
    const h = await openEngine(project, { env: { ACME_ADMIN_PASSWORD: undefined } });
    await h.compile();
    const r = await h.runScenario('Administrator signs in with the admin password');
    await h.close();
    expect(r.status).toBe('error');
    expect(r.steps.some((s) => s.error?.code === 'SECRET_MISSING')).toBe(true);
    expect(r.recording).toBe('discarded');
    expect(noRecordingFiles(project)).toEqual([]);
  });

  it('A4 R-CH1: a checkgen model that throws turns the step into an error: nothing is written', async () => {
    project = createProject({ docs: ['billing'] });
    const h = await openEngine(project, { models: overriding('checkgen', () => { throw new Error('checkgen exploded'); }) });
    await h.compile();
    const r = await h.runScenario(UPGRADE);
    await h.close();
    expect(r.status).toBe('error');
    expect(noRecordingFiles(project)).toEqual([]);
  });

  it('A4 R-CH1: a judge call that fails with MODEL_UNAVAILABLE is an error, not a pass: nothing is written', async () => {
    project = createProject({ docs: ['billing'] });
    const h = await openEngine(project, { models: overriding('judge', () => { throw Object.assign(new Error('down'), { code: 'MODEL_UNAVAILABLE' }); }) });
    await h.compile();
    const r = await h.runScenario(UPGRADE);
    await h.close();
    expect(['error', 'failed']).toContain(r.status);
    expect(r.status).not.toBe('passed');
    expect(noRecordingFiles(project)).toEqual([]);
  });

  it('A4 R-CH2 R-CH1: the first run passes but the confirm run (a fresh session) hits the bug: CHARACTERIZATION_UNSTABLE, scenario failed, nothing is written', async () => {
    project = createProject({ docs: ['billing'] });
    const h = await openEngine(project, { wrapFactory: flakyAcrossSessions() });
    await h.compile();
    const r = await h.runScenario(UPGRADE);
    await h.close();
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('CHARACTERIZATION_UNSTABLE');
    expect(r.recording).toBe('discarded');
    expect(r.confirm?.failed).toBe(true);
    expect(noRecordingFiles(project)).toEqual([]);
  });

  it('A4 R-CH1 R-CH6: -u on a buggy app fails the oracle and leaves the previously committed recording byte-identical', async () => {
    project = createProject({ docs: ['billing'] });
    const h1 = await openEngine(project);
    await h1.compile();
    const id = scenarioId(await h1.plans(), UPGRADE);
    expect((await h1.runScenario(id)).status).toBe('passed');
    await h1.close();
    const files = readRecordings(project).map((r) => r.path);
    expect(files).toHaveLength(1);
    const bytes = readFileSync(files[0] as string);
    const mtime = statSync(files[0] as string).mtimeMs;

    const h2 = await openEngine(project, { prepare: { flags: ['bug-upgrade-noop'] } });
    const r = await h2.runScenario(id, { updateRecordings: true });
    await h2.close();
    expect(r.status).toBe('failed');
    expect(r.mode).toBe('characterize');
    expect(r.recording).toBe('discarded');
    expect(readFileSync(files[0] as string).equals(bytes)).toBe(true);
    expect(statSync(files[0] as string).mtimeMs).toBe(mtime);
    expect(walkFiles(project.recordingsDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('A4 R-CH1: an aborted run (signal fires after the first agent turn) is an error and writes nothing', async () => {
    project = createProject({ docs: ['billing'] });
    const ac = new AbortController();
    const h = await openEngine(project, { models: overriding('act', (_req, st) => { if (st.calls >= 2) ac.abort(); return undefined; }) });
    await h.compile();
    const r = await h.runScenario(UPGRADE, { signal: ac.signal });
    await h.close();
    expect(r.status).not.toBe('passed');
    expect(r.recording === 'none' || r.recording === 'discarded').toBe(true);
    expect(noRecordingFiles(project)).toEqual([]);
  });

  it('A4 R-CH6: recordings mode "read-only" and "off" never create a file or directory, even for a clean pass (and -u is refused in read-only mode)', async () => {
    for (const mode of ['read-only', 'off'] as const) {
      project?.cleanup();
      project = createProject({ docs: ['billing'] });
      const h = await openEngine(project, { env: { AI_BDD_RECORDINGS: mode } });
      await h.compile();
      const r = await h.runScenario(UPGRADE);
      expect(r.status, mode).toBe('passed');
      expect(r.recording === 'none' || r.recording === 'discarded', mode).toBe(true);
      expect(existsSync(project.recordingsDir), mode).toBe(false);
      if (mode === 'read-only') {
        await expect(h.engine.runScenario(r.scenarioId, { updateRecordings: true })).rejects.toMatchObject({ code: 'RECORDING_READ_ONLY' });
        const run = h.engine.run({ updateRecordings: true, compile: false });
        await expect(run).rejects.toMatchObject({ code: 'RECORDING_READ_ONLY' });
      }
      await h.close();
      expect(existsSync(project.recordingsDir), mode).toBe(false);
    }
  });

  it('A4 R-CH1: a failed run through engine.run() reports exit code 1 and leaves the recordings directory absent', async () => {
    project = createProject({ docs: ['billing'] });
    const h = await openEngine(project, { prepare: { flags: ['bug-upgrade-noop'] } });
    await h.compile();
    const report = await h.run({ titles: [UPGRADE] });
    await h.close();
    expect(report.exitCode).toBe(1);
    expect(report.scenarios[0]?.recording).toBe('discarded');
    expect(existsSync(project.recordingsDir)).toBe(false);
    // the run directory exists, but holds no recording
    const dirs = existsSync(project.runsDir) ? readdirSync(project.runsDir) : [];
    expect(dirs.length).toBeGreaterThan(0);
  });

  it('A4 R-CH1: the same healthy scenario does record (control: the attacks above are not passing because recording is broken)', async () => {
    project = createProject({ docs: ['billing'] });
    const h = await openEngine(project);
    await h.compile();
    const r = await h.runScenario(UPGRADE);
    await h.close();
    expect(r.status).toBe('passed');
    expect(r.recording).toBe('created');
    expect(readRecordings(project)).toHaveLength(1);
    void compose;
    void fakeTarget;
  });
});
