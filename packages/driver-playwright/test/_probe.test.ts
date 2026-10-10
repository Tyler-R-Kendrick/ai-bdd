import { it } from 'vitest';
import { launchRaw } from './browser.ts';
import { startFixture } from './fixture.ts';
import { sessionFromPage } from '../src/index.ts';
it('probe', async () => {
  const fx = await startFixture();
  const b = await launchRaw();
  const ctx = await b.newContext({ acceptDownloads: false });
  const page = await ctx.newPage();
  const s = await sessionFromPage(page, { scenarioId: 's', policy: { allowHosts: ['localhost'], denyVerbs: [] }, resolveValue: () => '' }, { policy: { allowHosts: ['localhost'], denyVerbs: [] }, baseURL: fx.url });
  await s.perform({ verb: 'navigate', url: '/popup' });
  for (const name of ['Open off-host', 'Open data', 'Open redirecting']) {
    const obs = await s.observe();
    const n = obs.nodes.find((x) => x.name === name)!;
    ctx.on('page', (p) => console.log('  new page', p.url()));
    await s.perform({ verb: 'click', target: { ref: n.ref } });
    await new Promise((r) => setTimeout(r, 700));
    console.log(name, 'pages', ctx.pages().map((p) => p.url()), 'hits', fx.offHostHits);
  }
  await b.close(); await fx.close();
});
