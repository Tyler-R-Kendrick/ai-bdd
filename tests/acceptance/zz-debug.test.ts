import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
const require_fs_write = (s: string): void => writeFileSync('/tmp/claude-0/-home-user-ai-bdd/0a1cf405-8758-5453-981b-eb6b83c053de/scratchpad/debug.json', s);
import { openEngine } from './helpers/engine.ts';
import { scenarioId, T } from './helpers/plans.ts';
import { createProject } from './helpers/project.ts';

it('debug', async () => {
  const p = createProject({ docs: ['billing'] });
  try {
    const h = await openEngine(p);
    await h.compile();
    const id = scenarioId(await h.plans(), T.upgrade);
    await h.runScenario(id);
    await h.close();
    const hb = await openEngine(p, { prepare: { flags: ['bug-upgrade-noop'] } });
    const r = await hb.runScenario(id);
    require_fs_write(JSON.stringify({ status: r.status, error: r.error, steps: r.steps.map((s) => ({ t: s.text, s: s.status, p: s.path, e: s.error })) }, null, 1));
    await hb.close();
  } finally { p.cleanup(); }
});
