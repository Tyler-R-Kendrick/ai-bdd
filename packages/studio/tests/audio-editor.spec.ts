import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from '../server/app.ts';
import { initialAudioContent } from '../shared/audio.ts';
const run = promisify(execFile),
  origin = 'http://127.0.0.1:8891',
  password = 'audio-browser-fixture-only-123',
  email = 'audio-owner@example.test';
let studio: Awaited<ReturnType<typeof createApp>>, directory: string;
const faults: string[] = [];
test.beforeAll(async () => {
  directory = await mkdtemp('/tmp/studio-audio-browser-');
  studio = await createApp(
    {
      origin,
      production: false,
      demo: false,
      dataDir: directory,
      adminEmail: email,
      adminPassword: password,
    },
    {
      db: ':memory:',
      clientDir: resolve(import.meta.dirname, '../dist/client'),
    },
  );
  await studio.app.listen({ host: '127.0.0.1', port: 8891 });
});
test.afterAll(async () => {
  await studio?.app.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function open(page: Page) {
  page.on('pageerror', (error) => faults.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 500)
      faults.push(`${response.status()} ${response.url()}`);
  });
  await page.addInitScript(() => {
    // Observe a real running graph with an independent analyser; no production test hooks.
    const original = AudioNode.prototype.connect;
    (window as any).__audioAnalysers = [];
    AudioNode.prototype.connect = function (
      this: AudioNode,
      destination: any,
      ...rest: any[]
    ) {
      if (destination === this.context.destination) {
        const analyser = this.context.createAnalyser();
        analyser.fftSize = 2048;
        (window as any).__audioAnalysers.push(analyser);
        (original as any).call(analyser, destination);
        return (original as any).call(this, analyser);
      }
      return (original as any).call(this, destination, ...rest);
    } as any;
  });
  const login = await page.request.post(origin + '/api/auth/login', {
    headers: { origin },
    data: { email, password },
  });
  expect(login.status(), await login.text()).toBe(200);
  const projectResponse = await page.request.post(origin + '/api/projects', {
    headers: { origin },
    data: {
      title: 'Soundtrack acceptance',
      description: 'Actual waveform editing and verified mixdown.',
      repository: '',
    },
  });
  expect(projectResponse.ok(), await projectResponse.text()).toBe(true);
  const project = await projectResponse.json();
  const created = await page.request.post(
    origin + `/api/projects/${project.id}/artifacts`,
    {
      headers: { origin },
      data: {
        kind: 'audio',
        title: 'Field recording mix',
        content: initialAudioContent(),
      },
    },
  );
  expect(created.ok(), await created.text()).toBe(true);
  const artifact = await created.json();
  await page.goto(origin + `/?project=${project.id}&artifact=${artifact.id}`);
  await expect(
    page.getByRole('region', { name: 'Audio composition editor' }),
  ).toBeVisible();
  return { artifact, project };
}
async function number(page: Page, label: string, value: string) {
  const field = page.getByRole('spinbutton', { name: label, exact: true });
  await field.fill(value);
  await field.press('Tab');
}
async function bundle(page: Page, id: string) {
  return (await page.request.get(origin + `/api/artifacts/${id}`)).json();
}
async function capture(page: Page, name: string) {
  await expect(page.locator('.audio-alert,.error-banner')).toHaveCount(0);
  expect(faults).toEqual([]);
  await mkdir(
    resolve(
      import.meta.dirname,
      '../../../docs/studio-evidence/audio-authoring',
    ),
    { recursive: true },
  );
  await page.evaluate(() => document.fonts.ready);
  await expect(
    page.locator('.audio-waveform[data-source-ready=false]'),
  ).toHaveCount(0);
  await page.screenshot({
    path: resolve(
      import.meta.dirname,
      `../../../docs/studio-evidence/audio-authoring/${name}.png`,
    ),
    fullPage: true,
    animations: 'disabled',
  });
}
test('real audio editing, measured WebAudio playback, durable WAV/FLAC mixdown, portable source roundtrip and artifact context survive reload', async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1440, height: 1200 });
  const { artifact, project } = await open(page);
  await page.getByRole('button', { name: 'Tone', exact: true }).click();
  await expect(page.getByLabel('Clip name', { exact: true })).toHaveValue(
    'A440 tone.wav',
  );
  await number(page, 'Clip duration (s)', '1');
  await number(page, 'Source offset (s)', '0.25');
  await number(page, 'Clip start (s)', '0.5');
  await number(page, 'Fade in (s)', '0.1');
  await number(page, 'Fade out (s)', '0.1');
  await number(page, 'Track pan', '-1');
  const stereoFile = join(directory, 'stereo-atmosphere.wav');
  await run('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=330:sample_rate=48000:duration=2',
    '-af',
    'pan=stereo|c0=0*c0|c1=c0',
    stereoFile,
  ]);
  await page
    .getByLabel('Import recorded audio file', { exact: true })
    .setInputFiles(stereoFile);

  await expect(page.locator('.audio-track')).toHaveCount(2);
  await expect(
    page.locator('.audio-track').nth(1).locator('.audio-waveform'),
  ).toHaveAttribute('data-source-ready', 'true');
  const waveformSpan = await page
    .locator('.audio-track')
    .nth(1)
    .locator('canvas')
    .evaluate((canvas: HTMLCanvasElement) => {
      const context = canvas.getContext('2d')!,
        pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let min = canvas.height,
        max = 0;
      for (let y = 0; y < canvas.height; y++)
        for (let x = 0; x < canvas.width; x++)
          if (pixels[(y * canvas.width + x) * 4 + 3] > 100) {
            min = Math.min(min, y);
            max = Math.max(max, y);
          }
      return max - min;
    });
  expect(waveformSpan).toBeGreaterThan(4);
  await page.getByLabel('Track name', { exact: true }).fill('Atmosphere layer');
  await number(page, 'Track gain (dB)', '-12');
  await page
    .getByRole('button', { name: 'Mute Atmosphere layer', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Select clip A440 tone.wav', exact: true })
    .first()
    .click();
  await page.getByLabel('Audio seek', { exact: true }).fill('1');
  await page
    .getByRole('button', { name: 'Split at playhead', exact: true })
    .click();
  await expect(
    page.getByRole('button', {
      name: 'Select clip A440 tone.wav · split',
      exact: true,
    }),
  ).toBeVisible();
  await number(page, 'Project duration (s)', '3');
  await page.getByRole('button', { name: 'Save audio', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Save audio', exact: true }),
  ).toBeDisabled();
  let stored = await bundle(page, artifact.id);
  expect(stored.artifact.content.tracks).toHaveLength(2);
  expect(stored.artifact.content.tracks[0].clips).toHaveLength(2);
  expect(stored.artifact.content.tracks[0].clips[1]).toMatchObject({
    start: 1,
    offset: 0.75,
    duration: 0.5,
    fadeOut: 0.1,
  });
  expect(stored.decisions).toHaveLength(1);
  expect(stored.threads.every((t: any) => t.artifactId === artifact.id)).toBe(
    true,
  );
  await page
    .getByLabel('Message this artifact', { exact: true })
    .fill('Keep this recording discussion attached to the audio artifact.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(
    page
      .getByLabel('Discussion messages', { exact: true })
      .getByText(
        'Keep this recording discussion attached to the audio artifact.',
        { exact: true },
      ),
  ).toBeVisible();
  const main = await bundle(page, project.mainArtifactId);
  expect(
    main.messages.some((m: any) => m.body.includes('recording discussion')),
  ).toBe(false);
  await page.getByLabel('Audio seek', { exact: true }).fill('0.65');
  await page.getByRole('button', { name: 'Play audio', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Pause', exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const analyser = (window as any).__audioAnalysers.at(-1) as
          | AnalyserNode
          | undefined;
        if (!analyser) return 0;
        const values = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(values);
        return Math.sqrt(values.reduce((n, v) => n + v * v, 0) / values.length);
      }),
    )
    .toBeGreaterThan(0.02);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.reload();
  await expect(page.locator('.audio-track')).toHaveCount(2);
  await page
    .getByRole('button', {
      name: 'Select clip A440 tone.wav · split',
      exact: true,
    })
    .click();
  await expect(
    page.getByLabel('Source offset (s)', { exact: true }),
  ).toHaveValue('0.75');
  await page
    .getByRole('region', { name: 'Audio composition editor' })
    .evaluate((el) => el.scrollTo(0, 0));
  await capture(page, 'audio-waveform-desktop');
  const portableEvent = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Audio project', exact: true })
    .click();
  const portable = await portableEvent,
    portablePath = join(directory, 'portable.audio.json');
  await portable.saveAs(portablePath);
  const portableData = JSON.parse(await readFile(portablePath, 'utf8'));
  const before = stored.artifact.content.tracks[0].clips[0].src;
  const original = await (await page.request.get(origin + before)).body();
  expect(
    Buffer.from(portableData.assets[before].data, 'base64').equals(original),
  ).toBe(true);
  await page
    .getByLabel('Import portable audio project', { exact: true })
    .setInputFiles(portablePath);
  await expect(
    page.getByRole('button', { name: 'Save audio', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Save audio', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Save audio', exact: true }),
  ).toBeDisabled();
  stored = await bundle(page, artifact.id);
  const after = stored.artifact.content.tracks[0].clips[0].src;
  expect(after).not.toBe(before);
  expect(
    (await (await page.request.get(origin + after)).body()).equals(original),
  ).toBe(true);
  for (const format of ['wav', 'flac']) {
    await page
      .getByLabel('Audio export format', { exact: true })
      .selectOption(format);
    await page.getByRole('button', { name: 'Render mix', exact: true }).click();
    await expect
      .poll(
        async () => {
          const rows = await (
            await page.request.get(
              origin + `/api/artifacts/${artifact.id}/audio/renders`,
            )
          ).json();
          const job = rows.find((j: any) => j.format === format);
          return job?.status === 'failed' ? job.error : job?.status;
        },
        { timeout: 10000 },
      )
      .toBe('completed');
    const button = page
      .getByRole('button', {
        name: `Download ${format.toUpperCase()}`,
        exact: true,
      })
      .first();
    await expect(button).toBeVisible({ timeout: 45000 });
    const fileEvent = page.waitForEvent('download');
    await button.click();
    const file = join(directory, `actual.${format}`);
    await (await fileEvent).saveAs(file);
    const metadata = JSON.parse(
      (
        await run('ffprobe', [
          '-v',
          'error',
          '-show_entries',
          'stream=codec_name,channels,sample_rate:format=duration',
          '-of',
          'json',
          file,
        ])
      ).stdout,
    );
    expect(metadata.streams[0]).toMatchObject({
      channels: 2,
      sample_rate: '48000',
    });
    expect(Number(metadata.format.duration)).toBeCloseTo(3, 2);
    const pcm = join(directory, `actual-${format}.pcm`);
    await run('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-i',
      file,
      '-c:a',
      'pcm_f32le',
      '-f',
      'f32le',
      pcm,
    ]);
    const raw = await readFile(pcm);
    const rms = (start: number, end: number, ch = 0) => {
      let total = 0,
        count = 0;
      for (
        let i = Math.floor(start * 48000);
        i < Math.floor(end * 48000);
        i++
      ) {
        const v = raw.readFloatLE((i * 2 + ch) * 4);
        total += v * v;
        count++;
      }
      return Math.sqrt(total / count);
    };
    expect(rms(0.01, 0.3)).toBeLessThan(0.001);
    expect(rms(0.7, 0.9)).toBeCloseTo(0.2 / Math.SQRT2, 2);
    expect(rms(0.7, 0.9, 1)).toBeLessThan(0.001);
    expect(rms(1.7, 2.8)).toBeLessThan(0.001);
  }
  await page
    .getByRole('button', {
      name: 'Select clip A440 tone.wav · split',
      exact: true,
    })
    .click();
  await page
    .getByRole('region', { name: 'Audio composition editor' })
    .evaluate((el) => el.scrollTo(0, 0));
  await capture(page, 'audio-verified-mix-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await number(page, 'Clip gain (dB)', '-3');
  await page.getByRole('button', { name: 'Save audio', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Save audio', exact: true }),
  ).toBeDisabled();
  await page.reload();
  await page
    .getByRole('button', {
      name: 'Select clip A440 tone.wav · split',
      exact: true,
    })
    .click();
  await expect(page.getByLabel('Clip gain (dB)', { exact: true })).toHaveValue(
    '-3',
  );
  await page
    .getByRole('region', { name: 'Audio composition editor' })
    .evaluate((el) => el.scrollTo(0, 0));
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await capture(page, 'audio-waveform-mobile');
  await page
    .getByLabel('Audio export format', { exact: true })
    .selectOption('wav');
  await page.getByRole('button', { name: 'Render mix', exact: true }).click();
  await expect
    .poll(
      async () => {
        const rows = await (
          await page.request.get(
            origin + `/api/artifacts/${artifact.id}/audio/renders`,
          )
        ).json();
        return rows.find((j: any) => j.artifactVersion === 4)?.status;
      },
      { timeout: 15000 },
    )
    .toBe('completed');
  const mobileJob = page.locator('.audio-render-job').filter({ hasText: 'v4' }),
    mobileEvent = page.waitForEvent('download');
  await mobileJob
    .getByRole('button', { name: 'Download WAV', exact: true })
    .click();
  const mobileFile = join(directory, 'mobile-v4.wav');
  await (await mobileEvent).saveAs(mobileFile);
  const mobilePcm = join(directory, 'mobile-v4.pcm');
  await run('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-i',
    mobileFile,
    '-c:a',
    'pcm_f32le',
    '-f',
    'f32le',
    mobilePcm,
  ]);
  const mobileBytes = await readFile(mobilePcm);
  let energy = 0;
  for (let i = 52800; i < 62400; i++) {
    const v = mobileBytes.readFloatLE(i * 8);
    energy += v * v;
  }
  expect(Math.sqrt(energy / 9600)).toBeCloseTo(
    (0.2 / Math.SQRT2) * Math.pow(10, -3 / 20),
    2,
  );
  await mobileJob.scrollIntoViewIfNeeded();
  await capture(page, 'audio-mix-mobile');
  expect(faults).toEqual([]);
});
test('remote revision conflicts preserve a downloadable local audio draft and view-only members cannot mutate audio', async ({
  page,
  browser,
}) => {
  const { artifact } = await open(page);
  await page.getByRole('button', { name: 'Tone', exact: true }).click();
  await expect(page.getByLabel('Clip name', { exact: true })).toHaveValue(
    'A440 tone.wav',
  );
  await page.getByRole('button', { name: 'Save audio', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Save audio', exact: true }),
  ).toBeDisabled();
  await number(page, 'Track gain (dB)', '-9');
  const original = await bundle(page, artifact.id),
    response = await page.request.patch(
      origin + `/api/artifacts/${artifact.id}`,
      {
        headers: { origin },
        data: {
          version: original.artifact.version,
          content: { ...original.artifact.content, masterGainDb: -3 },
        },
      },
    );
  expect(response.ok(), await response.text()).toBe(true);
  await expect(
    page.getByRole('alert').filter({ hasText: 'A newer revision arrived' }),
  ).toBeVisible();
  await expect(page.getByLabel('Track gain (dB)', { exact: true })).toHaveValue(
    '-9',
  );
  await expect(
    page.getByRole('button', { name: 'Save audio', exact: true }),
  ).toBeDisabled();
  const draftEvent = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Download local draft', exact: true })
    .click();
  expect((await draftEvent).suggestedFilename()).toMatch(/audio.json$/);
  await page
    .getByRole('button', { name: 'Load saved revision', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Select clip A440 tone.wav', exact: true })
    .click();
  await expect(page.getByLabel('Track gain (dB)', { exact: true })).toHaveValue(
    '0',
  );
  await expect(
    page.getByLabel('Master gain (dB)', { exact: true }),
  ).toHaveValue('-3');
  const owner = await studio.store.userByEmail(email),
    artifactRow = await studio.store.artifact(artifact.id, owner.id);
  const { passwordHash } = await import('../server/auth.ts');
  const viewer = await studio.store.createUser(
    'audio-viewer@example.test',
    'Audio viewer',
    await passwordHash(password),
  );
  await studio.store.exec(
    'INSERT INTO memberships(project_id,user_id,role) VALUES(?,?,?)',
    artifactRow.projectId,
    viewer.id,
    'viewer',
  );
  const viewContext = await browser.newContext(),
    view = await viewContext.newPage();
  try {
    const login = await view.request.post(origin + '/api/auth/login', {
      headers: { origin },
      data: { email: viewer.email, password },
    });
    expect(login.ok()).toBe(true);
    await view.goto(
      origin + `/?project=${artifactRow.projectId}&artifact=${artifact.id}`,
    );
    await expect(
      view.getByRole('region', { name: 'Audio composition editor' }),
    ).toBeVisible();
    await expect(
      view.getByRole('button', { name: 'Tone', exact: true }),
    ).toBeDisabled();
    await expect(
      view.getByRole('button', { name: 'Save audio', exact: true }),
    ).toBeDisabled();
    await expect(
      view.getByRole('button', { name: 'Play audio', exact: true }),
    ).toBeEnabled();
    const denied = await view.request.post(
      origin + `/api/artifacts/${artifact.id}/audio/render`,
      {
        headers: { origin },
        data: { version: artifactRow.version, format: 'wav' },
      },
    );
    expect(denied.status()).toBe(403);
    const saveDenied = await view.request.patch(
      origin + `/api/artifacts/${artifact.id}`,
      {
        headers: { origin },
        data: {
          version: artifactRow.version,
          content: { ...artifactRow.content, masterGainDb: -12 },
        },
      },
    );
    expect(saveDenied.status()).toBe(403);
    const uploadDenied = await view.request.post(
      origin + `/api/artifacts/${artifact.id}/files`,
      {
        headers: { origin },
        multipart: {
          file: {
            name: 'denied.wav',
            mimeType: 'audio/wav',
            buffer: Buffer.alloc(44),
          },
        },
      },
    );
    expect(uploadDenied.status()).toBe(403);
  } finally {
    await viewContext.close();
  }
});
