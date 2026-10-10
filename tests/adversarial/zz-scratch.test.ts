import { it } from 'vitest';
import { createProject, openEngine, readPlans } from './helpers/kit.ts';

it('scratch', async () => {
  const project = createProject({ docs: ['billing'] });
  const h = await openEngine(project);
  await h.compile();
  const DOWN = 'docs-billing--downgrade-from-pro';
  await h.engine.review(DOWN, 'accept');
  await h.engine.review(`${DOWN}/downgrade-is-blocked-with-unpaid-invoices`, 'reject');
  const show = async (l: string) => { for (const p of await h.plans()) for (const f of p.features) console.log(l, f.id, f.review, f.scenarios.map((s) => `${s.title}:${s.review}`).join(' | ')); };
  await show('after reject');
  await h.compile();
  await show('after compile');
  await h.compile({ full: true });
  await show('after full');
  await h.close();
  project.cleanup();
});
