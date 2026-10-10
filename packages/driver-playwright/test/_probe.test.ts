import { it } from 'vitest';
import { launchRaw } from './browser.ts';
import { startFixture } from './fixture.ts';
it('probe', async () => {
  const fx = await startFixture();
  const b = await launchRaw();
  const ctx = await b.newContext({ acceptDownloads: false });
  const page = await ctx.newPage();
  await ctx.route('**/*', async (route) => { await route.continue(); });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] });
  cdp.on('Fetch.requestPaused', async (ev) => {
    console.log('PAUSED', ev.request.url, ev.resourceType, ev.redirectedRequestId, ev.frameId);
    if (ev.request.url.includes('127.0.0.1')) await cdp.send('Fetch.failRequest', { requestId: ev.requestId, errorReason: 'BlockedByClient' });
    else await cdp.send('Fetch.continueRequest', { requestId: ev.requestId });
  });
  await page.goto(`${fx.url}/links`);
  console.log('A', page.url());
  const r = await page.goto(`${fx.url}/redirect-off`).catch((e) => console.log('ERR', e.message.split('\n')[0]));
  console.log('B', page.url(), await page.title(), fx.offHostHits);
  await page.getByRole('link', {name: 'Redirecting link'}).click();
  console.log('C', page.url(), fx.offHostHits);
  await page.goto(`${fx.url}/todos`);
  console.log('E', page.url());
  await b.close(); await fx.close();
});
