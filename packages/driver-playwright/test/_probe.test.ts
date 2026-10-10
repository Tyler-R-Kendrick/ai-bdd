import { it } from 'vitest';
import { startAcmeApp } from '@ai-bdd/testing';
import { playwright } from '../src/index.ts';
it('probe', async () => {
  const app = await startAcmeApp({});
  console.log('URL', app.url);
  const d = await playwright().create({ projectRoot: '.', policy: { allowHosts: ['localhost', '127.0.0.1'], denyVerbs: [] }, artifactsDir: '.' });
  const s = await d.openSession({ scenarioId: 'x', baseURL: app.url, policy: { allowHosts: ['localhost', '127.0.0.1'], denyVerbs: [] }, resolveValue: (v) => ('literal' in v ? v.literal : 'correct-horse-battery') });
  for (const r of ['/login', '/settings/billing', '/todos', '/forms/two', '/slow?ms=2000', '/notes']) {
    await s.perform({ verb: 'navigate', url: r });
    const o = await s.observe();
    console.log('=====', r, o.busy, o.title, '\n' + o.treeText);
  }
  await s.close(); await d.dispose(); await app.close();
}, 30000);
