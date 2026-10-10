import { it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createProject, openEngine, overriding, toolCall, readRecordings } from './helpers/kit.ts';
const SECRET = 'Zq7-uniq/Secret+Value!99';
it('scratch', async () => {
  const project = createProject({ docs: ['login'] });
  const model = overriding('act', (req) => {
    if (req.context['stepText'] === 'the administrator types admin@acme.example into the email field' && req.context['turn'] === 0) {
      const nodes = req.context['nodes'] as { ref: string; role: string; name: string }[];
      return toolCall('fill', { ref: nodes.find((n) => n.name === 'Email')!.ref, secret: 'adminPassword' });
    }
    return undefined;
  });
  const h = await openEngine(project, { env: { ACME_ADMIN_PASSWORD: SECRET }, prepare: { adminPassword: SECRET }, models: model });
  await h.compile();
  const r = await h.run({ titles: ['Administrator signs in with the admin password'] });
  console.log(r.scenarios[0]?.status, r.scenarios[0]?.recording);
  for (const rec of readRecordings(project)) {
    const text = readFileSync(rec.path, 'utf8');
    text.split('\n').forEach((l, i) => { if (l.includes(SECRET)) console.log(i, l.trim()); });
  }
  await h.close();
  project.cleanup();
});
