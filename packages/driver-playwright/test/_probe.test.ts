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
    if (r.isNavigationRequest()) {
      const resp = await route.fetch({ maxRedirects: 0 });
      console.log('  fetched', resp.status(), resp.headers()['location']);
      const loc = resp.headers()['location'];
      if (loc && loc.includes('127.0.0.1')) { await route.abort('blockedbyclient'); return; }
      console.log('  headers', JSON.stringify(resp.headers())); const h = { ...resp.headers() }; for (const k of ['connection','keep-alive','transfer-encoding','content-encoding','content-length']) delete h[k]; await route.fulfill({ status: resp.status(), headers: h, body: await resp.body() });
      return;
    }
    await route.continue();
  });
  ctx.on('request', (r) => console.log('REQ', r.url()));
  await page.goto(`${fx.url}/redirect-same`).catch((e) => console.log('ERR', e.message.split('\n')[0]));
  console.log('same-redirect landed', page.url());
  await page.goto(`${fx.url}/redirect-off`).catch((e) => console.log('ERR', e.message.split('\n')[0]));
  console.log('hits', fx.offHostHits, page.url());
  await page.goto(`${fx.url}/set-cookie?v=1`);
  await page.goto(`${fx.url}/whoami`);
  console.log(await page.title(), await page.locator('h1').textContent());
  await b.close(); await fx.close();
});
