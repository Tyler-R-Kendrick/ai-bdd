import { it } from 'vitest';
import { using } from '../../../../tests/acceptance/helpers/flows.ts';
import { fakeTarget } from '../../../../tests/acceptance/helpers/targets.ts';
import { createProject } from '../../../../tests/acceptance/helpers/project.ts';
import { openEngine } from '../../../../tests/acceptance/helpers/engine.ts';
import { recordingOf, scenarioId, T } from '../../../../tests/acceptance/helpers/plans.ts';

it('debug', async () => {
  const project = createProject({ docs: ['billing'] });
  const out: unknown[] = [];
  try {
    const id = await using(fakeTarget, {}, async (prepared) => {
      const h = await openEngine(project, { target: fakeTarget, prepared });
      await h.compile();
      const sid = scenarioId(await h.plans(), T.upgrade);
      const r = await h.runScenario(sid);
      out.push({ first: r.status, steps: r.steps.map((s) => [s.text, s.status, s.path, s.determinism, s.fuzzyReasons]), confirm: r.confirm, rec: r.recording });
      await h.close();
      return sid;
    });
    const rec = recordingOf(project, id);
    out.push({ eff: rec?.steps[2]?.act?.effect, startRoute: rec?.steps[2]?.act?.startRoute });
    await using(fakeTarget, { flags: ['bug-upgrade-noop'] }, async (prepared) => {
      const h = await openEngine(project, { target: fakeTarget, prepared });
      const result = await h.runScenario(id);
      out.push({ second: result.status, mode: result.mode, steps: result.steps.map((s) => [s.text, s.status, s.path, s.determinism, s.error?.code]) });
      await h.close();
    });
  } finally {
    project.cleanup();
  }
  process.stderr.write(JSON.stringify(out, null, 1) + '\n');
}, 60000);
