import { it } from 'vitest';
import { createProject, openEngine } from './helpers/kit.ts';

it('scratch', async () => {
  const project = createProject({ docs: ['login'] });
  const h = await openEngine(project, { env: { ACME_ADMIN_PASSWORD: undefined } });
  await h.compile();
  const r = await h.runScenario('Administrator signs in with the admin password');
  console.log(r.status, JSON.stringify(r.steps.map((s) => [s.text, s.status, s.error]), null, 1), JSON.stringify(r.error));
  const rep = await h.run({ titles: ['Administrator signs in with the admin password'] });
  console.log('exit', rep.exitCode);
  await h.close();
  project.cleanup();
});
