// Read-only capture of a previously verified synthetic hosted audio export.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
const previous = JSON.parse(await readFile(process.env.STUDIO_HOSTED_AUDIO_RESUME_FILE, 'utf8'));
assert.equal(previous.passed, true);
assert.equal(previous.kind, 'model-free hosted audio durable publication');
const origin = new URL(previous.origin);
assert.equal(origin.protocol, 'https:');
assert.match(origin.hostname, /^ai-bdd-studio-[a-z0-9]+-tyler-r-kendricks-projects\.vercel\.app$/);
assert.equal(origin.pathname, '/');
assert.equal(origin.port + origin.username + origin.password + origin.search + origin.hash, '');
const ids = previous.resources;
for (const key of ['projectId', 'artifactId', 'jobId']) assert.match(ids[key], /^[a-f0-9-]{36}$/);
assert(process.env.VERCEL_OIDC_TOKEN && process.env.STUDIO_HOSTED_AUDIO_PASSWORD_FILE && process.env.STUDIO_HOSTED_AUDIO_EMAIL);
const evidence = process.env.STUDIO_HOSTED_AUDIO_UI_EVIDENCE_DIR;
assert(evidence);
await mkdir(evidence, { recursive: true });
const report = {
  schemaVersion: 1,
  kind: 'read-only hosted synthetic audio UI capture',
  origin: origin.origin,
  source: previous.deploymentSourceProvidedByOperator,
  deploymentId: previous.deploymentIdProvidedByOperator,
  resources: ids,
  startedAt: new Date().toISOString(),
  passed: false,
  newRenders: 0,
  modelRequests: 0,
  uploads: 0,
  redirectsFollowedForAuthentication: 0,
  tlsCertificateVerification: true,
  credentialsRecorded: false,
  blockedExternalRequests: 0,
  blockedMutations: 0,
  webSocket: { transport: 'Playwright exact-origin routed relay', observed: 0, framesReceived: 0, errors: 0, httpFailureStatuses: [] },
  captures: [],
};
let browser, context, stage = 'launch', signedIn = false;
try {
  const proxyAddress = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  const proxy = proxyAddress ? new URL(proxyAddress) : undefined;
  browser = await chromium.launch({
    ...(process.env.STUDIO_BROWSER_EXECUTABLE ? { executablePath: process.env.STUDIO_BROWSER_EXECUTABLE } : {}),
    headless: true,
    ...(proxy ? { proxy: { server: proxy.origin, ...(proxy.username ? { username: decodeURIComponent(proxy.username), password: decodeURIComponent(proxy.password) } : {}) } } : {}),
  });
  report.browserVersion = browser.version();
  context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    ignoreHTTPSErrors: false,
    serviceWorkers: 'block',
    extraHTTPHeaders: { 'x-vercel-trusted-oidc-idp-token': process.env.VERCEL_OIDC_TOKEN },
  });
  // All HTTP requests and WebSocket handshakes are constrained before navigation.
  // No identity header can be forwarded to a foreign origin.
  await context.route('**/*', async route => {
    try {
    const request = route.request();
    if (new URL(request.url()).origin !== origin.origin) {
      report.blockedExternalRequests++;
      return route.abort('blockedbyclient');
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      report.blockedMutations++;
      return route.abort('blockedbyclient');
    }
    return await route.continue();
    } catch { report.routeErrors = (report.routeErrors ?? 0) + 1; }
  });
  await context.routeWebSocket('**/*', socket => {
    const target = new URL(socket.url());
    if (target.protocol !== 'wss:' || target.hostname !== origin.hostname || target.port) {
      report.blockedExternalRequests++;
      return socket.close({ code: 1008, reason: 'Only the approved preview is permitted' });
    }
    socket.connectToServer();
  });
  const password = (await readFile(process.env.STUDIO_HOSTED_AUDIO_PASSWORD_FILE, 'utf8')).replace(/\r?\n$/, '');
  stage = 'owner-login';
  // APIRequestContext does not use page routing; both fixed auth URLs are exact-origin.
  const login = await context.request.post(new URL('/api/auth/login', origin).href, {
    headers: { origin: origin.origin },
    data: { email: process.env.STUDIO_HOSTED_AUDIO_EMAIL, password },
    maxRedirects: 0,
    timeout: 60000,
  });
  assert.equal(login.status(), 200);
  signedIn = true;
  const page = await context.newPage();
  let pageErrors = 0, serverFailures = 0;
  page.on('pageerror', () => pageErrors++);
  page.on('response', response => { if (response.status() >= 500) serverFailures++; });
  page.on('websocket', socket => {
    report.webSocket.observed++;
    socket.on('framereceived', () => report.webSocket.framesReceived++);
    socket.on('socketerror', error => {
      report.webSocket.errors++;
      const status = String(error).match(/(?:response code|status)\D*(\d{3})/i)?.[1];
      if (status) report.webSocket.httpFailureStatuses.push(Number(status));
    });
  });
  stage = 'open-verified-artifact';
  await page.goto(new URL(`/?project=${ids.projectId}&artifact=${ids.artifactId}`, origin).href, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.getByRole('region', { name: 'Audio composition editor' }).waitFor({ state: 'visible', timeout: 60000 });
  const job = page.locator('.audio-render-job').filter({ hasText: /WAV.*v1.*completed/ });
  await job.waitFor({ state: 'visible', timeout: 60000 });
  assert.equal(await job.count(), 1);
  stage = 'download-existing-completed-wav';
  const downloadEvent = page.waitForEvent('download', { timeout: 60000 });
  await job.getByRole('button', { name: 'Download WAV', exact: true }).click();
  const download = await downloadEvent;
  assert.equal(await download.failure(), null);
  const bytes = await readFile(await download.path());
  assert.equal(bytes.length, previous.output.byteSize);
  report.browserDownload = { byteSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  assert.equal(report.browserDownload.sha256, previous.output.sha256);
  for (const viewport of [{ width: 1440, height: 1100 }, { width: 390, height: 844 }]) {
    stage = `capture-${viewport.width}`;
    await page.setViewportSize(viewport);
    await page.evaluate(() => document.fonts.ready);
    await job.waitFor({ state: 'visible' });
    await job.scrollIntoViewIfNeeded();
    const box = await job.boundingBox();
    assert(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height);
    const name = viewport.width === 1440 ? 'hosted-audio-completed-desktop.png' : 'hosted-audio-completed-mobile.png';
    await page.screenshot({ path: join(evidence, name), fullPage: true, animations: 'disabled' });
    report.captures.push({ file: name, viewport, completedJobInViewport: true, scrolledToExistingExport: viewport.width === 390 });
  }
  report.pageErrors = pageErrors;
  report.serverFailures = serverFailures;
  report.visibleErrorBanners = await page.locator('.audio-alert,.error-banner').count();
  assert.equal(pageErrors, 0);
  assert.equal(serverFailures, 0);
  assert.equal(report.visibleErrorBanners, 0);
  assert.equal(report.blockedMutations, 0);
  report.passed = true;
} catch (error) {
  report.failure = { stage, code: 'hosted-ui-assertion-or-transport-failure', browserNetworkCode: String(error?.message ?? '').match(/net::(ERR_[A-Z_]+)/)?.[1] ?? null, timeout: error?.name === 'TimeoutError' };
  process.exitCode = 1;
} finally {
  if (context && signedIn) {
    try {
      const logout = await context.request.post(new URL('/api/auth/logout', origin).href, { headers: { origin: origin.origin }, data: {}, maxRedirects: 0, timeout: 60000 });
      report.ownedSessionClosed = logout.status() === 200;
    } catch { report.ownedSessionClosed = false; }
  }
  await context?.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  if (signedIn && !report.ownedSessionClosed) { report.passed = false; process.exitCode = 1; }
}
report.completedAt = new Date().toISOString();
await writeFile(join(evidence, 'hosted-audio-ui.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: report.passed, failure: report.failure ?? null, captures: report.captures, browserDownload: report.browserDownload ?? null, webSocket: report.webSocket, ownedSessionClosed: report.ownedSessionClosed }));
