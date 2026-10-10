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
  await s.perform({ verb: 'navigate', url: '/login' });
  const obs = await s.observe();
  console.log(obs.treeText);
  console.log(await page.getByLabel('Password').evaluate('el => [el.type, el.closest("input[type=password], [data-ai-bdd-secret]") !== null]'));
  await b.close(); await fx.close();
});
