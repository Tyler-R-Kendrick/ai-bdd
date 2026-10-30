import { test, expect } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { signInAcceptanceActor } from './browser-auth.ts';

test('authors and reloads a keyframed timeline, exports a portable project and decodes the rendered MP4', async ({
  page,
}) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await signInAcceptanceActor(page);
  const headers = { origin: 'http://127.0.0.1:8877' };
  const p = await page.request.post('/api/projects', {
    headers,
    data: {
      title: 'Motion design acceptance',
      description: 'Synthetic review fixture',
      repository: '',
    },
  });
  expect(p.ok(), await p.text()).toBe(true);
  const project = await p.json();
  const a = await page.request.post(`/api/projects/${project.id}/artifacts`, {
    headers,
    data: {
      kind: 'video',
      title: 'Product motion',
      content: {
        width: 320,
        height: 180,
        duration: 1.5,
        fps: 24,
        background: '#f2f0e8',
        clips: [],
      },
    },
  });
  expect(a.ok(), await a.text()).toBe(true);
  const artifact = await a.json();
  await page.goto(`/?project=${project.id}&artifact=${artifact.id}`);
  await page.getByRole('button', { name: 'Add text', exact: true }).click();
  await page.getByLabel('Clip name', { exact: true }).fill('Launch title');
  await page
    .getByLabel('Layer text', { exact: true })
    .fill('Build with intent.');
  for (const [label, value] of [
    ['X', '20'],
    ['Y', '65'],
    ['Clip width', '280'],
    ['Clip height', '70'],
    ['Font size', '27'],
  ]) {
    const field = page.getByRole('spinbutton', { name: label!, exact: true });
    await field.fill(value!);
    await field.press('Tab');
  }
  await page
    .getByRole('button', { name: 'Add keyframe at playhead', exact: true })
    .click();
  await page
    .getByRole('slider', { name: 'Video playhead', exact: true })
    .fill('0.5');
  await page
    .getByRole('button', { name: 'Add keyframe at playhead', exact: true })
    .click();
  const opacity = page.getByRole('spinbutton', {
    name: 'opacity at 0.5s',
    exact: true,
  });
  await opacity.fill('0.8');
  await opacity.press('Tab');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Save', exact: true }),
  ).toBeDisabled();
  await page.reload();
  await expect(page.locator('.video-preview-clip').first()).toHaveCSS(
    'font-family',
    /Inter Variable/,
  );
  expect(
    await page.evaluate(async () => {
      await document.fonts.ready;
      return document.fonts.check('27px "Inter Variable"');
    }),
  ).toBe(true);
  await page.getByRole('button', { name: /Launch title, track 1,/ }).click();
  await expect(
    page.getByRole('spinbutton', { name: 'opacity at 0.5s', exact: true }),
  ).toHaveValue('0.8');
  const zipDownload = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'HyperFrames ZIP', exact: true })
    .click();
  const zip = await zipDownload,
    files = unzipSync(new Uint8Array(await readFile((await zip.path())!)));
  const manifest = JSON.parse(strFromU8(files['studio.json']!));
  expect(manifest.content.clips[0]).toMatchObject({
    name: 'Launch title',
    text: 'Build with intent.',
    keyframes: [
      { property: 'opacity', at: 0, value: 1 },
      { property: 'opacity', at: 0.5, value: 0.8 },
    ],
  });
  expect(strFromU8(files['index.html']!)).toContain('data-composition-id');
  const movieDownload = page.waitForEvent('download', { timeout: 60000 });
  await page.getByRole('button', { name: 'Render MP4', exact: true }).click();
  const movie = await movieDownload;
  expect(movie.suggestedFilename()).toMatch(/\.mp4$/);
  const probe = JSON.parse(
    (
      await promisify(execFile)('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'format=duration:stream=codec_name,width,height,r_frame_rate',
        '-of',
        'json',
        (await movie.path())!,
      ])
    ).stdout,
  );
  expect(probe.streams[0]).toMatchObject({
    codec_name: 'h264',
    width: 320,
    height: 180,
    r_frame_rate: '24/1',
  });
  expect(Number(probe.format.duration)).toBeCloseTo(1.5, 1);
  const jobs = await (
    await page.request.get(`/api/artifacts/${artifact.id}/video/renders`)
  ).json();
  expect(jobs[0]).toMatchObject({
    status: 'completed',
    format: 'mp4',
    artifactVersion: 2,
  });
  await page
    .getByRole('button', { name: 'Go to start', exact: true })
    .click();
  await page
    .getByRole('spinbutton', { name: 'Width', exact: true })
    .scrollIntoViewIfNeeded();
  const folder = resolve(import.meta.dirname, '../../../work/review');
  await mkdir(folder, { recursive: true });
  await page
    .getByRole('spinbutton', { name: 'opacity at 0.5s', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: resolve(folder, 'video-keyframes-desktop.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page
    .getByRole('spinbutton', { name: 'Width', exact: true })
    .scrollIntoViewIfNeeded();
  await expect(page.locator('.error-banner')).toHaveCount(0);
  await page.screenshot({
    path: resolve(folder, 'video-timeline-desktop.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.sidebar')).toHaveAttribute(
    'aria-hidden',
    'true',
  );
  await expect
    .poll(async () => {
      const box = await page.locator('.sidebar').boundingBox();
      return box ? box.x + box.width : 0;
    })
    .toBeLessThanOrEqual(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({
    path: resolve(folder, 'video-timeline-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
  expect(errors).toEqual([]);
});
