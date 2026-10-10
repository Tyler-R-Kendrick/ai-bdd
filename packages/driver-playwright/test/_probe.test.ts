import { it } from 'vitest';
import { launchRaw } from './browser.ts';
import { startFixture } from './fixture.ts';
it('probe', async () => {
  const fx = await startFixture();
  const b = await launchRaw();
  const ctx = await b.newContext();
  const page = await ctx.newPage();
  await ctx.route('**/*', async (route) => {
    const r = route.request();
    console.log('ROUTE', r.url(), r.isNavigationRequest(), r.redirectedFrom()?.url());
    await route.continue();
  });
  ctx.on('request', (r) => console.log('REQ', r.url()));
  await page.goto(`${fx.url}/redirect-off`).catch((e) => console.log('ERR', e.message.split('\n')[0]));
  console.log('hits', fx.offHostHits, page.url());
  await b.close(); await fx.close();
});
