import { test, expect, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { mkdtemp, readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { newClip } from '../shared/video-timeline.ts';
const execute = promisify(execFile);
// This file proves the real H.264 roundtrip. All other acceptance files retain
// Playwright's pinned Chromium; the final case explicitly uses that decoder too.
const mp4Browser =
  process.env.STUDIO_MP4_CHROMIUM_PATH ??
  process.env.STUDIO_CHROMIUM_PATH ??
  (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
if (process.env.CI && !process.env.STUDIO_MP4_CHROMIUM_PATH)
  throw new Error(
    'Prepare the pinned official Chrome MP4 acceptance browser before this suite.',
  );
test.use({
  launchOptions: {
    ...(mp4Browser ? { executablePath: mp4Browser } : {}),
    args: ['--no-sandbox'],
  },
});

async function h264Fixture(folder: string) {
  const video = join(folder, 'scene.mp4');
  await execute('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=0x6b73d1:s=160x90:d=2:r=24',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    video,
  ]);
  return video;
}
async function open(page: Page) {
  const status = await page.request.get('/api/auth/status'),
    origin = new URL(status.url()).origin;
  const auth = await page.request.post('/api/auth/demo', {
    headers: { origin },
  });
  expect(auth.ok()).toBe(true);
  const project = await (
    await page.request.post('/api/projects', {
      headers: { origin },
      data: {
        title: 'Motion review ' + crypto.randomUUID().slice(0, 6),
        description: '',
        repository: '',
      },
    })
  ).json();
  const title = {
    ...newClip('text', 4, 0),
    name: 'Opening title',
    text: 'Build with intent.',
    x: 44,
    y: 120,
    width: 550,
    height: 90,
    fontSize: 38,
  };
  const response = await page.request.post(
    `/api/projects/${project.id}/artifacts`,
    {
      headers: { origin },
      data: {
        kind: 'video',
        title: 'Product launch film',
        content: {
          width: 640,
          height: 360,
          background: '#f9f9f8',
          duration: 4,
          fps: 24,
          clips: [title],
        },
      },
    },
  );
  expect(response.ok(), await response.text()).toBe(true);
  const artifact = await response.json();
  await page.goto(`/?project=${project.id}&artifact=${artifact.id}`);
  await expect(page.getByLabel('Video composition editor')).toBeVisible();
  return { artifact, project, origin };
}
async function number(page: Page, name: string, value: string) {
  const input = page.getByRole('spinbutton', { name, exact: true });
  await input.fill(value);
  await input.press('Tab');
}

test('multi-track media, nonlinear keyframes, source trims, MP4 audio, and portable projects work end to end', async ({
  page,
}) => {
  const folder = await mkdtemp(join(tmpdir(), 'studio-motion-browser-'));
  try {
    const { artifact, project } = await open(page);
    const audio = join(folder, 'narration.wav'),
      video = await h264Fixture(folder);
    await execute('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=2',
      audio,
    ]);
    await page
      .getByLabel('Import video, audio, or image file')
      .setInputFiles(video);
    await expect(page.getByLabel('Clip name')).toHaveValue('scene.mp4');
    await number(page, 'Clip duration', '1');
    await number(page, 'Source in', '0.5');
    await number(page, 'Clip start', '1');
    await page
      .getByLabel('Import video, audio, or image file')
      .setInputFiles(audio);
    await expect(page.getByLabel('Clip name')).toHaveValue('narration.wav');
    await number(page, 'Clip duration', '1');
    await number(page, 'Source in', '0.5');
    await number(page, 'Volume', '0.4');
    await page.getByRole('button', { name: /^Opening title, track/ }).click();
    await page.getByLabel('Upload video WOFF2 font').setInputFiles({
      name: 'motion-font.woff2',
      mimeType: 'font/woff2',
      buffer: await readFile(
        resolve(
          import.meta.dirname,
          '../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
        ),
      ),
    });
    await expect(
      page.getByRole('combobox', { name: 'Typeface', exact: true }),
    ).toHaveValue('Custom');

    await page
      .getByRole('button', { name: 'Add keyframe at playhead' })
      .click();
    await page.getByLabel('Video playhead').fill('1');
    await page
      .getByRole('button', { name: 'Add keyframe at playhead' })
      .click();
    await number(page, 'opacity at 1s', '0.25');
    await page.getByRole('button', { name: /^scene.mp4, track/ }).click();
    await page.getByLabel('Video playhead').fill('1.5');
    await page.getByRole('button', { name: 'Split', exact: true }).click();
    await expect(
      page.getByRole('button', { name: /^scene.mp4 · split, track/ }),
    ).toBeVisible();
    await page.getByLabel('Import SRT or WebVTT captions').setInputFiles({
      name: 'launch.srt',
      mimeType: 'text/plain',
      buffer: Buffer.from(
        '1\n00:00:02,500 --> 00:00:03,500\nShip with evidence.\n',
      ),
    });
    await expect(
      page.getByRole('button', { name: /^Caption, track/ }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Save', exact: true }),
    ).toBeDisabled();
    const stored = await (
      await page.request.get(`/api/artifacts/${artifact.id}`)
    ).json();
    expect(stored.artifact.content.clips).toHaveLength(5);
    expect(
      stored.artifact.content.clips.find(
        (clip: any) => clip.name === 'Opening title',
      ).keyframes,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: 'opacity', at: 1, value: 0.25 }),
      ]),
    );
    expect(
      stored.artifact.content.clips.find(
        (clip: any) => clip.name === 'scene.mp4 · split',
      ),
    ).toMatchObject({ start: 1.5, mediaStart: 1, animationOffset: 0.5 });
    const zipDownload = page.waitForEvent('download');
    await page
      .getByRole('button', { name: 'HyperFrames ZIP', exact: true })
      .click();
    const zipPath = join(folder, 'portable.zip');
    await (await zipDownload).saveAs(zipPath);
    const zipped = unzipSync(await readFile(zipPath));
    const html = strFromU8(zipped['index.html']!);
    expect(html).toContain('__timelines');
    expect(html).not.toContain('gsap');
    expect(html).toContain('data-media-start="0.5"');
    expect(Object.keys(zipped).some((name) => name.endsWith('.mp4'))).toBe(
      true,
    );
    expect(Object.keys(zipped).some((name) => name.endsWith('.wav'))).toBe(
      true,
    );
    const mp4Download = page.waitForEvent('download', { timeout: 60000 });
    await page.getByRole('button', { name: 'Render MP4', exact: true }).click();
    const mp4Path = join(folder, 'final.mp4');
    await (await mp4Download).saveAs(mp4Path);
    const metadata = JSON.parse(
      (
        await execute('ffprobe', [
          '-v',
          'error',
          '-show_entries',
          'format=duration:stream=codec_name,codec_type,width,height,nb_frames',
          '-of',
          'json',
          mp4Path,
        ])
      ).stdout,
    );
    expect(
      metadata.streams.find((stream: any) => stream.codec_type === 'video'),
    ).toMatchObject({
      codec_name: 'h264',
      width: 640,
      height: 360,
      nb_frames: '96',
    });
    expect(
      metadata.streams.find((stream: any) => stream.codec_type === 'audio')
        .codec_name,
    ).toBe('aac');
    expect(Number(metadata.format.duration)).toBeCloseTo(4, 1);
    await page.reload();
    await expect(
      page.getByRole('button', { name: /^scene.mp4 · split, track/ }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Go to start', exact: true })
      .click();
    await page.getByRole('button', { name: 'Play video', exact: true }).click();
    await expect(page.getByLabel('Playhead time')).not.toHaveText('00:00:00');
    await page
      .getByRole('button', { name: 'Pause video', exact: true })
      .click();
    await page
      .getByLabel('Import HyperFrames Studio project')
      .setInputFiles(zipPath);
    await expect(
      page
        .getByRole('toolbar', { name: 'Video editing tools' })
        .getByText('Unsaved changes', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Save', exact: true }),
    ).toBeDisabled();
    const imported = await (
      await page.request.get(`/api/artifacts/${artifact.id}`)
    ).json();
    const originalSource = stored.artifact.content.clips.find(
      (clip: any) => clip.type === 'audio',
    ).src;
    expect(
      imported.artifact.content.clips.find((clip: any) => clip.type === 'audio')
        .src,
    ).not.toBe(originalSource);
    await page.getByRole('button', { name: /^Opening title, track/ }).click();
    await page.getByLabel('Video playhead').fill('0.5');
    await mkdir(resolve(import.meta.dirname, '../../../work/review'), {
      recursive: true,
    });
    await page.screenshot({
      path: resolve(
        import.meta.dirname,
        '../../../work/review/studio-video-complete.png',
      ),
      fullPage: true,
    });
    await writeFile(
      resolve(
        import.meta.dirname,
        '../../../work/review/studio-video-export-probe.json',
      ),
      JSON.stringify(metadata, null, 2),
    );
    expect(imported.artifact.projectId).toBe(project.id);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('bundled Chromium rejects an unsupported codec in a valid MP4 without adding or saving a clip', async ({
  playwright,
}) => {
  // Launch the installed Playwright browser directly: no system or Chrome path,
  // no codec mocking, and no use of the positive MP4 test's launch override.
  const browser = await playwright.chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({
    baseURL: 'http://127.0.0.1:8877',
  });
  const page = await context.newPage();
  const folder = await mkdtemp(join(tmpdir(), 'studio-unsupported-codec-'));
  try {
    // MP4 is a container. A valid MPEG-4 Part 2 stream is unsupported even on
    // hosts where this Chromium build can decode the positive H.264 fixture.
    expect(
      await page.evaluate(() =>
        document
          .createElement('video')
          .canPlayType('video/mp4; codecs="mp4v.20.9"'),
      ),
    ).toBe('');
    expect(
      await page.evaluate(() =>
        document
          .createElement('video')
          .canPlayType('video/webm; codecs="vp8, vorbis"'),
      ),
    ).not.toBe('');
    const { artifact } = await open(page);
    const before = await (
      await page.request.get(`/api/artifacts/${artifact.id}`)
    ).json();
    const unsupportedVideo = join(folder, 'scene.mp4');
    await execute('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=0x6b73d1:s=160x90:d=2:r=24',
      '-c:v',
      'mpeg4',
      '-pix_fmt',
      'yuv420p',
      unsupportedVideo,
    ]);
    const probe = JSON.parse(
      (
        await execute('ffprobe', [
          '-v',
          'error',
          '-show_entries',
          'stream=codec_name,codec_type,nb_frames',
          '-of',
          'json',
          unsupportedVideo,
        ])
      ).stdout,
    );
    expect(probe.streams).toEqual([
      expect.objectContaining({
        codec_name: 'mpeg4',
        codec_type: 'video',
        nb_frames: '48',
      }),
    ]);
    await page
      .getByLabel('Import video, audio, or image file')
      .setInputFiles(unsupportedVideo);
    const error = page.getByRole('alert').filter({
      hasText: 'This browser cannot decode the selected MP4 file or its codec.',
    });
    await expect(error).toBeVisible();
    await expect(error).toContainText(
      'Try WebM (VP8 or VP9), which this browser reports as supported.',
    );
    await expect(error).not.toContainText('Try MP4');
    await expect(
      page.getByRole('button', { name: /^scene.mp4, track/ }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Save', exact: true }),
    ).toBeDisabled();
    const after = await (
      await page.request.get(`/api/artifacts/${artifact.id}`)
    ).json();
    expect(after.artifact.version).toBe(before.artifact.version);
    expect(after.artifact.content).toEqual(before.artifact.content);
    await mkdir(resolve(import.meta.dirname, '../../../work/review'), {
      recursive: true,
    });
    await page.screenshot({
      path: resolve(
        import.meta.dirname,
        '../../../work/review/studio-video-unsupported-codec.png',
      ),
      fullPage: true,
    });
  } finally {
    await browser.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test('new revisions retain local video drafts and viewer controls prevent edits', async ({
  page,
}) => {
  const { artifact, project, origin } = await open(page);
  await page.getByRole('button', { name: /^Opening title, track/ }).click();
  await page.getByLabel('Layer text').fill('My unsaved motion draft');
  const latest = await (
    await page.request.get(`/api/artifacts/${artifact.id}`)
  ).json();
  const content = latest.artifact.content;
  content.clips[0].x += 20;
  const changed = await page.request.patch(`/api/artifacts/${artifact.id}`, {
    headers: { origin },
    data: { version: latest.artifact.version, content },
  });
  expect(changed.ok()).toBe(true);
  await expect(
    page.getByRole('alert').filter({ hasText: 'Your draft is retained' }),
  ).toBeVisible();
  await expect(page.getByLabel('Layer text')).toHaveValue(
    'My unsaved motion draft',
  );
  await page.getByRole('button', { name: 'Load latest', exact: true }).click();
  await expect(page.getByLabel('Layer text')).toHaveValue('Build with intent.');
  const email = `video-viewer-${crypto.randomUUID()}@example.test`;
  const invitation = await (
    await page.request.post(`/api/projects/${project.id}/members`, {
      headers: { origin },
      data: { email, name: 'Motion reviewer', role: 'viewer' },
    })
  ).json();
  const login = await page.request.post('/api/auth/login', {
    headers: { origin },
    data: { email, password: invitation.temporaryPassword },
  });
  expect(login.ok()).toBe(true);
  await page.goto(`/?project=${project.id}&artifact=${artifact.id}`);
  await expect(
    page.getByRole('button', { name: 'Add text', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Render MP4', exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel('Video playhead')).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel('Video composition editor')).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator('#project-navigation')
        .evaluate((element) => element.getBoundingClientRect().right),
    )
    .toBeLessThanOrEqual(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: resolve(
      import.meta.dirname,
      '../../../work/review/studio-video-mobile.png',
    ),
    fullPage: true,
  });
});
