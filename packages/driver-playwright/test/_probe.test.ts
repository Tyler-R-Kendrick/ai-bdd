import { it } from 'vitest';
import { launchRaw } from './browser.ts';
import { startFixture } from './fixture.ts';
it('probe', async () => {
  const fx = await startFixture();
  const b = await launchRaw();
  const ctx = await b.newContext({ acceptDownloads: false });
  const page = await ctx.newPage();
  await ctx.route('**/*', async (route) => {
    const r = route.request();
    if (r.isNavigationRequest()) {
      const resp = await route.fetch({ maxRedirects: 0 });
      const loc = resp.headers()['location'];
      if (loc && loc.includes('127.0.0.1')) { console.log('deny'); await route.fulfill({ status: 200, headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment' }, body: '' }); return; }
      const h = { ...resp.headers() };
      for (const k of ['connection','keep-alive','transfer-encoding','content-encoding','content-length']) delete h[k];
      await route.fulfill({ status: resp.status(), headers: h, body: await resp.body() });
      return;
    }
    await route.continue();
  });
  await page.goto(`${fx.url}/links`);
  console.log('A', page.url());
  const r = await page.goto(`${fx.url}/redirect-off`).catch((e) => console.log('ERR', e.message.split('\n')[0]));
  console.log('B', page.url(), r);
  await new Promise(r => setTimeout(r, 500));
  console.log('C', page.url(), await page.title());
  await page.getByRole('link', {name: 'Redirecting link'}).click();
  await new Promise(r => setTimeout(r, 500));
  console.log('D', page.url());
  await page.goto(`${fx.url}/todos`);
  console.log('E', page.url(), fx.offHostHits);
  const p2 = await ctx.newPage();
  const r2 = await p2.goto(`${fx.url}/redirect-off`).catch((e) => console.log('ERR2', e.message.split('\n')[0]));
  console.log('F', p2.url());
  await b.close(); await fx.close();
});
