// Bounded, explicitly opted-in production browser upload/edit/render acceptance.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { chromium } from '@playwright/test';

const origin = 'https://ai-bdd-studio.vercel.app';
assert.equal(process.env.STUDIO_HOSTED_IMPORT_ALLOW_PRODUCTION_WRITE, '1');
assert.equal(process.env.STUDIO_HOSTED_IMPORT_ALLOW_USAGE, '1');
const evidence = process.env.STUDIO_HOSTED_IMPORT_EVIDENCE_DIR;
assert(evidence && process.env.STUDIO_HOSTED_AUDIO_PASSWORD_FILE);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const report = {
  schemaVersion: 1, origin,
  sourceProvidedByOperator: process.env.STUDIO_HOSTED_AUDIO_SOURCE,
  deploymentIdProvidedByOperator: process.env.STUDIO_HOSTED_AUDIO_DEPLOYMENT_ID,
  startedAt: new Date().toISOString(), passed: false,
  kind: 'actual production browser private audio import and gain edit',
  modelsInvoked: 0, previewIdentityHeadersSent: 0,
  tlsCertificateVerification: true, credentialValuesRecorded: false,
  externalSourceAssets: 0, blockedForeignRequests: 0, steps: [], captures: [],
};
assert.match(report.sourceProvidedByOperator ?? '', /^[a-f0-9]{40}$/);
assert.match(report.deploymentIdProvidedByOperator ?? '', /^dpl_[A-Za-z0-9]+$/);
await mkdir(evidence, { recursive: true });
const progress = () => writeFile(join(evidence, 'receipt.json'), JSON.stringify(report, null, 2) + '\n');
let browser, context, fresh, page, stage = 'launch', signedIn = false, freshSignedIn = false;
const password = (await readFile(process.env.STUDIO_HOSTED_AUDIO_PASSWORD_FILE, 'utf8')).replace(/\r?\n$/, '');
assert(password.length >= 16);
async function json(client, path, method = 'GET', body, expected = 200) {
  assert(path.startsWith('/api/'));
  const response = await client.fetch(origin + path, {
    method, headers: { origin }, ...(body === undefined ? {} : { data: body }),
    maxRedirects: 0, timeout: 90000,
  });
  report.steps.push({ stage, method, path, status: response.status() });
  assert.equal(response.status(), expected);
  return response.json();
}
function sineWave() {
  const frames = 12000, bytes = Buffer.alloc(44 + frames * 4);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(192000, 28);
  bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36);
  bytes.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) {
    const value = Math.round(Math.sin(2 * Math.PI * 440 * i / 48000) * 8191);
    bytes.writeInt16LE(value, 44 + i * 4); bytes.writeInt16LE(value, 46 + i * 4);
  }
  return bytes;
}
function waveMetrics(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  let data, channels, sampleRate, bits;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4), end = offset + 8 + size;
    assert(end <= bytes.length);
    if (bytes.toString('ascii', offset, offset + 4) === 'fmt ') {
      channels = bytes.readUInt16LE(offset + 10); sampleRate = bytes.readUInt32LE(offset + 12);
      bits = bytes.readUInt16LE(offset + 22);
    }
    if (bytes.toString('ascii', offset, offset + 4) === 'data') data = bytes.subarray(offset + 8, end);
    offset = end + size % 2;
  }
  assert(data && channels === 2 && sampleRate === 48000 && bits === 16);
  let squares = 0, peak = 0;
  for (let i = 0; i < data.length; i += 2) {
    const v = data.readInt16LE(i) / 32768; squares += v * v; peak = Math.max(peak, Math.abs(v));
  }
  return { channels, sampleRate, bits, duration: data.length / 192000, rms: Math.sqrt(squares / (data.length / 2)), peak };
}
try {
  const proxy = process.env.HTTPS_PROXY ? new URL(process.env.HTTPS_PROXY) : undefined;
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true,
    ...(proxy ? { proxy: { server: proxy.origin } } : {}) });
  context = await browser.newContext({ viewport: { width: 1440, height: 1100 },
    ignoreHTTPSErrors: false, serviceWorkers: 'block' });
  report.browserVersion = browser.version();
  stage = 'owner-login';
  await json(context.request, '/api/auth/login', 'POST', { email: process.env.STUDIO_HOSTED_AUDIO_EMAIL, password });
  signedIn = true;
  stage = 'create-owned-synthetic-project';
  const project = await json(context.request, '/api/projects', 'POST', {
    title: 'Production audio import acceptance ' + randomUUID().slice(0, 8),
    description: 'Synthetic quarter-second stereo440Hz source; browser private upload, -6dB edit and export.', repository: '',
  }, 201);
  report.projectId = project.id;
  stage = 'create-owned-audio-artifact';
  const artifact = await json(context.request, `/api/projects/${project.id}/artifacts`, 'POST', {
    kind: 'audio', title: 'Imported stereo sine with gain edit',
    content: { schemaVersion: 1, sampleRate: 48000, duration: 0.25, masterGainDb: 0, tracks: [] },
  }, 201);
  report.artifactId = artifact.id; await progress();
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin || (url.origin === 'https://vercel.com' && /^\/api\/blob(?:\/|$)/.test(url.pathname)))
      return route.continue();
    report.blockedForeignRequests++; return route.abort('blockedbyclient');
  });
  await context.routeWebSocket('**/*', socket => {
    const url = new URL(socket.url());
    if (url.protocol === 'wss:' && url.hostname === new URL(origin).hostname && !url.port)
      return socket.connectToServer();
    report.blockedForeignRequests++; return socket.close({ code: 1008, reason: 'Exact application origin only' });
  });
  page = await context.newPage(); let pageErrors = 0;
  page.on('pageerror', () => pageErrors++);
  stage = 'open-audio-editor';
  await page.goto(`${origin}/?project=${project.id}&artifact=${artifact.id}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.getByRole('region', { name: 'Audio composition editor' }).waitFor({ timeout: 60000 });
  stage = 'browser-private-blob-upload-and-media-probe';
  const input = sineWave(); report.input = { byteSize: input.length, sha256: sha(input), ...waveMetrics(input) };
  await page.getByLabel('Import recorded audio file').setInputFiles({ name: 'synthetic-440hz.wav', mimeType: 'audio/wav', buffer: input });
  await page.locator('.audio-track').waitFor({ state: 'visible', timeout: 120000 });
  stage = 'edit-track-gain';
  await page.getByRole('spinbutton', { name: 'Track gain (dB)', exact: true }).fill('-6');
  await page.getByRole('spinbutton', { name: 'Track gain (dB)', exact: true }).blur();
  await page.getByRole('button', { name: 'Save audio', exact: true }).click();
  await page.getByRole('button', { name: 'Save audio', exact: true }).waitFor({ timeout: 60000 });
  stage = 'confirm-canonical-import-and-gain';
  const bundle = await json(context.request, `/api/artifacts/${artifact.id}`);
  assert.equal(bundle.artifact.content.tracks.length, 1);
  assert.equal(bundle.artifact.content.tracks[0].gainDb, -6);
  report.savedVersion = bundle.artifact.version;
  report.sourceFileId = bundle.artifact.content.tracks[0].clips[0].src.split('/').at(-1);
  stage = 'render-saved-gain-edit';
  await page.getByRole('button', { name: 'Render mix', exact: true }).click();
  const job = page.locator('.audio-render-job').filter({ hasText: new RegExp(`WAV.*v${report.savedVersion}.*completed`) });
  await job.waitFor({ state: 'visible', timeout: 180000 });
  const downloading = page.waitForEvent('download', { timeout: 60000 });
  await job.getByRole('button', { name: 'Download WAV', exact: true }).click();
  const download = await downloading; assert.equal(await download.failure(), null);
  const output = await readFile(await download.path()), metrics = waveMetrics(output);
  assert(Math.abs(metrics.duration - 0.25) < 0.001);
  const ratio = metrics.rms / report.input.rms;
  assert(ratio > 0.48 && ratio < 0.52, 'Decoded gain must match the actual-6dB edit');
  report.output = { byteSize: output.length, sha256: sha(output), ...metrics, inputRmsRatio: ratio };
  for (const viewport of [{ width: 1440, height: 1100 }, { width: 390, height: 844 }]) {
    stage = `capture-${viewport.width}`; await page.setViewportSize(viewport);
    await page.evaluate(() => document.fonts.ready); await job.scrollIntoViewIfNeeded();
    const box = await job.boundingBox(); assert(box && box.y >= 0 && box.y + box.height <= viewport.height);
    const file = `imported-audio-${viewport.width}.png`;
    await page.screenshot({ path: join(evidence, file), fullPage: true, animations: 'disabled' });
    report.captures.push({ file, viewport, completedExportInViewport: true });
  }
  stage = 'fresh-session-persistence-and-download';
  fresh = await browser.newContext({ ignoreHTTPSErrors: false });
  await json(fresh.request, '/api/auth/login', 'POST', { email: process.env.STUDIO_HOSTED_AUDIO_EMAIL, password });
  freshSignedIn = true;
  const reloaded = await json(fresh.request, `/api/artifacts/${artifact.id}`);
  assert.deepEqual(reloaded.artifact.content, bundle.artifact.content);
  const renders = await json(fresh.request, `/api/artifacts/${artifact.id}/audio/renders`);
  const exported = renders.find(item => item.artifactVersion === report.savedVersion && item.status === 'completed');
  assert(exported?.fileId); report.jobId = exported.id; report.fileId = exported.fileId;
  const file = await fresh.request.get(origin + `/api/files/${exported.fileId}`, { maxRedirects: 0 });
  assert.equal(file.status(), 200); assert.equal(sha(await file.body()), report.output.sha256);
  const anonymous = await browser.newContext({ ignoreHTTPSErrors: false });
  try { const denied = await anonymous.request.get(origin + `/api/files/${exported.fileId}`, { maxRedirects: 0 });
    assert.equal(denied.status(), 401); report.anonymousPrivateFileStatus = denied.status();
  } finally { await anonymous.close(); }
  report.pageErrors = pageErrors; assert.equal(pageErrors, 0);
  assert.equal(report.blockedForeignRequests, 0);
  report.passed = true;
} catch (error) {
  report.failure = { stage, kind: error?.name ?? 'Error', code: 'bounded-ui-acceptance-failed',
    networkCode: String(error?.message ?? '').match(/net::(ERR_[A-Z_]+)/)?.[1] ?? null };
  if (page) await page.screenshot({ path: join(evidence, 'failure.png'), animations: 'disabled' }).catch(() => {});
  process.exitCode = 1;
} finally {
  for (const [client, active, key] of [[fresh, freshSignedIn, 'freshSessionClosed'], [context, signedIn, 'ownedSessionClosed']]) {
    if (active) try { await json(client.request, '/api/auth/logout', 'POST', {}); report[key] = true; }
    catch { report[key] = false; report.passed = false; process.exitCode = 1; }
  }
  await fresh?.close().catch(() => {}); await context?.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
  await context?.close().catch(() => {}); await browser?.close().catch(() => {});
  report.completedAt = new Date().toISOString(); await progress();
}
console.log(JSON.stringify({ passed: report.passed, failure: report.failure ?? null,
  projectId: report.projectId, artifactId: report.artifactId, output: report.output ?? null }));
