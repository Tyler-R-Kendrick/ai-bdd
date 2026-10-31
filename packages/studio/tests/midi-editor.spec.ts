import { signInBrowser } from './browser-fixture.ts';
import { signInAcceptanceActor } from './browser-auth.ts';
import { test, expect, type Page } from '@playwright/test';
import { writeMidi, parseMidi, type MidiData } from 'midi-file';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { initialMidiContent } from '../shared/midi.ts';
const execute = promisify(execFile),
  evidence = resolve(import.meta.dirname, '../../../work/review');
async function open(page: Page) {
  const status = await page.request.get('/api/auth/status');
  expect(status.ok(), await status.text()).toBe(true);
  const origin = new URL(status.url()).origin;
  await signInAcceptanceActor(page);
  const project = await (
    await page.request.post('/api/projects', {
      headers: { origin },
      data: {
        title: 'MIDI studio review ' + crypto.randomUUID().slice(0, 6),
        description: '',
        repository: '',
      },
    })
  ).json();
  const response = await page.request.post(
    `/api/projects/${project.id}/artifacts`,
    {
      headers: { origin },
      data: {
        kind: 'midi',
        title: 'Tempo study',
        content: initialMidiContent(),
      },
    },
  );
  expect(response.ok(), await response.text()).toBe(true);
  const artifact = await response.json();
  await page.goto(`/?project=${project.id}&artifact=${artifact.id}`);
  await expect(page.getByLabel('MIDI composition editor')).toBeVisible();
  return { artifact, project, origin };
}
function fixture() {
  const data: MidiData = {
    header: { format: 1, numTracks: 2, ticksPerBeat: 480 },
    tracks: [
      [
        { deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500000 },
        {
          deltaTime: 0,
          type: 'timeSignature',
          numerator: 4,
          denominator: 4,
          metronome: 24,
          thirtyseconds: 8,
        },
        {
          deltaTime: 0,
          type: 'text',
          text: 'Retain this exact imported metadata.',
        },
        { deltaTime: 1920, type: 'setTempo', microsecondsPerBeat: 666667 },
        { deltaTime: 0, type: 'sysEx', data: [0x7e, 0x7f, 9, 1, 0xf7] },
        { deltaTime: 1920, type: 'endOfTrack' },
      ],
      [
        { deltaTime: 0, type: 'trackName', text: 'Aurora keys' },
        { deltaTime: 0, type: 'programChange', channel: 0, programNumber: 4 },
        {
          deltaTime: 0,
          type: 'controller',
          channel: 0,
          controllerType: 11,
          value: 100,
        },
        {
          deltaTime: 0,
          type: 'noteOn',
          channel: 0,
          noteNumber: 60,
          velocity: 96,
        },
        {
          deltaTime: 480,
          type: 'noteOff',
          channel: 0,
          noteNumber: 60,
          velocity: 12,
        },
        {
          deltaTime: 0,
          type: 'noteOn',
          channel: 0,
          noteNumber: 64,
          velocity: 88,
        },
        {
          deltaTime: 480,
          type: 'noteOff',
          channel: 0,
          noteNumber: 64,
          velocity: 0,
        },
        { deltaTime: 2880, type: 'endOfTrack' },
      ],
    ],
  };
  return Uint8Array.from(
    writeMidi(data, { running: true, useByte9ForNoteOff: true }),
  );
}
async function number(page: Page, label: string, value: string) {
  const field = page.getByRole('spinbutton', { name: label, exact: true });
  await field.fill(value);
  await field.press('Tab');
}
async function downloaded(page: Page, button: string, path: string) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: button, exact: true }).click();
  await (await pending).saveAs(path);
  return readFile(path);
}
function noteOns(data: MidiData) {
  return data.tracks.flatMap((track) => {
    let tick = 0;
    return track.flatMap((event) => {
      tick += event.deltaTime;
      return event.type === 'noteOn'
        ? [
            {
              tick,
              pitch: event.noteNumber,
              velocity: event.velocity,
              channel: event.channel,
            },
          ]
        : [];
    });
  });
}
function rms(bytes: Buffer, start: number, end: number, rate = 44100) {
  let sum = 0,
    count = 0;
  for (
    let frame = Math.floor(start * rate);
    frame < Math.floor(end * rate) && frame * 8 + 4 <= bytes.length;
    frame++
  ) {
    const value = bytes.readFloatLE(frame * 8);
    sum += value * value;
    count++;
  }
  return Math.sqrt(sum / Math.max(1, count));
}
function power(
  bytes: Buffer,
  frequency: number,
  start: number,
  end: number,
  rate = 44100,
) {
  let real = 0,
    imag = 0,
    n = 0;
  for (
    let frame = Math.floor(start * rate);
    frame < Math.floor(end * rate) && frame * 8 + 4 <= bytes.length;
    frame++
  ) {
    const sample = bytes.readFloatLE(frame * 8),
      angle = (2 * Math.PI * frequency * n) / rate;
    real += sample * Math.cos(angle);
    imag += sample * Math.sin(angle);
    n++;
  }
  return (real * real + imag * imag) / Math.max(1, n * n);
}

test('piano-roll edits persist, untouched sources retain exact bytes, and actual synth audio follows MIDI timing and pitch', async ({
  page,
}) => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-midi-browser-'));
  try {
    const failures: string[] = [];
    page.on('response', (response) => {
      if (response.status() >= 500)
        failures.push(
          String(response.status()) + ' ' + new URL(response.url()).pathname,
        );
    });
    page.on('pageerror', (error) => failures.push(error.message));
    const { artifact } = await open(page),
      original = fixture(),
      source = join(dir, 'original.mid');
    await writeFile(source, original);
    await page.getByLabel('Import Standard MIDI File').setInputFiles(source);
    await expect(
      page.getByRole('button', { name: /Aurora keys: C4, beat 0,/ }),
    ).toBeVisible();
    expect(
      await downloaded(page, 'Export MIDI', join(dir, 'untouched.mid')),
    ).toEqual(Buffer.from(original));
    await page.getByRole('button', { name: 'Save MIDI', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Save MIDI', exact: true }),
    ).toBeDisabled();
    await page.reload();
    await expect(
      page.getByRole('button', { name: /Aurora keys: C4, beat 0,/ }),
    ).toBeVisible();
    expect(
      await downloaded(page, 'Export MIDI', join(dir, 'reloaded.mid')),
    ).toEqual(Buffer.from(original));
    await page
      .getByRole('button', { name: /Aurora keys: C4, beat 0,/ })
      .click();
    await number(page, 'Note pitch (MIDI)', '67');
    await number(page, 'Note start (beats)', '2');
    await number(page, 'Note duration (beats)', '1.5');
    await number(page, 'Note velocity', '55');
    await page.getByLabel('MIDI track program').selectOption('19');
    await number(page, 'MIDI track channel', '2');
    const grid = page.getByRole('application', { name: 'MIDI piano roll' }),
      bounds = (await grid.boundingBox())!;
    await page.mouse.dblclick(
      bounds.x + 4 * 60,
      bounds.y + (127 - 72) * 19 + 9,
    );
    await expect(
      page.getByRole('spinbutton', { name: 'Note pitch (MIDI)', exact: true }),
    ).toHaveValue('72');
    await expect(
      page.getByRole('spinbutton', { name: 'Note start (beats)', exact: true }),
    ).toHaveValue('4');
    const drawn = page.getByRole('button', {
        name: /Aurora keys: C5, beat 4, velocity 100/,
      }),
      drawnBox = (await drawn.boundingBox())!;
    await page.mouse.move(drawnBox.x + 12, drawnBox.y + 8);
    await page.mouse.down();
    await page.mouse.move(drawnBox.x + 42, drawnBox.y + 27, { steps: 4 });
    await page.mouse.up();
    await expect(
      page.getByRole('spinbutton', { name: 'Note pitch (MIDI)', exact: true }),
    ).toHaveValue('71');
    await expect(
      page.getByRole('spinbutton', { name: 'Note start (beats)', exact: true }),
    ).toHaveValue('4.5');
    const handle = (await page
      .getByRole('button', { name: /Aurora keys: B4, beat 4.5, velocity 100/ })
      .locator('.midi-note-handle')
      .boundingBox())!;
    await page.mouse.move(handle.x + 3, handle.y + 7);
    await page.mouse.down();
    await page.mouse.move(handle.x + 63, handle.y + 7, { steps: 4 });
    await page.mouse.up();
    await expect(
      page.getByRole('spinbutton', {
        name: 'Note duration (beats)',
        exact: true,
      }),
    ).toHaveValue('2');
    await page
      .getByRole('button', { name: 'Undo MIDI edit', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Undo MIDI edit', exact: true })
      .click();
    await page
      .getByRole('button', { name: /Aurora keys: C5, beat 4, velocity 100/ })
      .click();
    await expect(
      page.getByRole('spinbutton', { name: 'Note pitch (MIDI)', exact: true }),
    ).toHaveValue('72');
    await expect(
      page.getByRole('spinbutton', { name: 'Note start (beats)', exact: true }),
    ).toHaveValue('4');
    await page.getByText('Tempo map', { exact: true }).click();
    await number(page, 'Tempo change 1 BPM', '90');
    await page.getByText('Time signatures', { exact: true }).click();
    await number(page, 'Meter change 1 numerator', '3');
    await page.getByRole('button', { name: 'Save MIDI', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Save MIDI', exact: true }),
    ).toBeDisabled();
    const stored = await (
      await page.request.get(`/api/artifacts/${artifact.id}`)
    ).json();
    expect(stored.artifact.content.tracks[0]).toMatchObject({
      instrument: 19,
      channel: 1,
    });
    expect(stored.artifact.content.tracks[0].notes).toContainEqual(
      expect.objectContaining({
        pitch: 67,
        start: 2,
        duration: 1.5,
        velocity: 55,
      }),
    );
    const editedBytes = await downloaded(
        page,
        'Export MIDI',
        join(dir, 'edited.mid'),
      ),
      decoded = parseMidi(editedBytes);
    expect(editedBytes).not.toEqual(Buffer.from(original));
    expect(decoded.header).toMatchObject({ format: 1, ticksPerBeat: 480 });
    expect(noteOns(decoded)).toEqual(
      expect.arrayContaining([
        { tick: 960, pitch: 67, velocity: 55, channel: 1 },
        { tick: 1920, pitch: 72, velocity: 100, channel: 1 },
      ]),
    );
    expect(
      decoded.tracks
        .flat()
        .some(
          (event) =>
            event.type === 'programChange' && event.programNumber === 19,
        ),
    ).toBe(true);
    expect(decoded.tracks.flat().some((event) => event.type === 'sysEx')).toBe(
      true,
    );
    expect(
      decoded.tracks
        .flat()
        .some(
          (event) =>
            event.type === 'timeSignature' &&
            event.numerator === 3 &&
            event.denominator === 4,
        ),
    ).toBe(true);
    await page.getByLabel('MIDI seek beat').fill('2');
    await expect(page.getByLabel('MIDI playhead')).toContainText('1.33s');
    await page.getByRole('button', { name: 'Play MIDI', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Pause MIDI', exact: true }),
    ).toBeVisible();
    await expect
      .poll(async () =>
        Number(
          (await page.getByLabel('MIDI playhead').innerText()).split('s')[0],
        ),
      )
      .toBeGreaterThan(1.45);
    await page.getByRole('button', { name: 'Pause MIDI', exact: true }).click();
    await page.getByLabel('MIDI seek beat').fill('4');
    await expect(page.getByLabel('MIDI playhead')).toContainText('2.67s');
    const wav = join(dir, 'synth.wav');
    await downloaded(page, 'Bounce synth WAV', wav);
    const metadata = JSON.parse(
      (
        await execute('ffprobe', [
          '-v',
          'error',
          '-show_entries',
          'format=duration:stream=codec_name,sample_rate,channels',
          '-of',
          'json',
          wav,
        ])
      ).stdout,
    );
    expect(metadata.streams[0]).toMatchObject({
      codec_name: 'pcm_s16le',
      sample_rate: '44100',
      channels: 2,
    });
    expect(Number(metadata.format.duration)).toBeCloseTo(
      (8 * 60) / 90 + 0.09,
      2,
    );
    const pcm = join(dir, 'synth.f32');
    await execute('ffmpeg', [
      '-v',
      'error',
      '-i',
      wav,
      '-f',
      'f32le',
      '-acodec',
      'pcm_f32le',
      pcm,
    ]);
    const audio = await readFile(pcm),
      intro = rms(audio, 0.1, 0.4),
      quiet = rms(audio, 1.6, 1.8),
      loud = rms(audio, 2.9, 3.1),
      tail = rms(audio, 4.5, 5),
      c5 = power(audio, 523.25, 2.9, 3.1);
    expect(intro).toBeLessThan(0.0001);
    expect(quiet).toBeGreaterThan(0.001);
    expect(loud / quiet).toBeGreaterThan(1.8);
    expect(tail).toBeLessThan(0.0001);
    expect(c5).toBeGreaterThan(power(audio, 440, 2.9, 3.1) * 10);
    expect(failures).toEqual([]);
    await mkdir(evidence, { recursive: true });
    await page.locator('.midi-inspector').evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({
      path: join(evidence, 'studio-midi-complete.png'),
      fullPage: true,
    });
    await writeFile(
      join(evidence, 'studio-midi-export-probe.json'),
      JSON.stringify(
        {
          metadata,
          originalMidiBytes: original.length,
          editedMidiBytes: editedBytes.length,
          notes: noteOns(decoded),
          rms: { intro, quiet, loud, tail },
          c5Power: c5,
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('draft conflicts retain local notes and viewers can audition/export while editing remains protected on mobile', async ({
  page,
}) => {
  const failures: string[] = [];
  page.on('response', (response) => {
    if (response.status() >= 500)
      failures.push(
        String(response.status()) + ' ' + new URL(response.url()).pathname,
      );
  });
  page.on('pageerror', (error) => failures.push(error.message));
  const { artifact, project, origin } = await open(page);
  await page
    .getByRole('button', { name: 'Add instrument', exact: true })
    .click();
  await page.getByRole('button', { name: 'Add note', exact: true }).click();
  await page.getByRole('button', { name: 'Save MIDI', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Save MIDI', exact: true }),
  ).toBeDisabled();
  await number(page, 'Note pitch (MIDI)', '61');
  const latest = await (
      await page.request.get(`/api/artifacts/${artifact.id}`)
    ).json(),
    content = latest.artifact.content;
  content.tracks[0].notes[0].velocity = 83;
  const changed = await page.request.patch(`/api/artifacts/${artifact.id}`, {
    headers: { origin },
    data: { version: latest.artifact.version, content },
  });
  expect(changed.ok()).toBe(true);
  await expect(
    page.getByRole('alert').filter({ hasText: 'Your local notes' }),
  ).toBeVisible();
  await expect(
    page.getByRole('spinbutton', { name: 'Note pitch (MIDI)', exact: true }),
  ).toHaveValue('61');
  await expect(
    page.getByRole('button', { name: 'Save MIDI', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Load latest MIDI', exact: true })
    .click();
  await page
    .getByRole('button', { name: /Instrument 1: C4, beat 0, velocity 83/ })
    .click();
  await expect(
    page.getByRole('spinbutton', { name: 'Note velocity', exact: true }),
  ).toHaveValue('83');
  const email = `midi-viewer-${crypto.randomUUID()}@example.test`;
  const ownerCookie=(await page.context().cookies(origin)).find(cookie=>cookie.name==='studio_session')!.value;
  const actor=await signInBrowser(page,origin,email);
  const invitation = await (
      await page.request.post(`/api/projects/${project.id}/members`, {
        headers: { origin,cookie:'studio_session='+ownerCookie },
        data: { userId:actor.id, role: 'viewer' },
      })
    ).json();
  expect(invitation).not.toHaveProperty('temporaryPassword');
  await page.goto(`/?project=${project.id}&artifact=${artifact.id}`);
  await expect(page.getByLabel('MIDI composition editor')).toBeVisible();
  await page
    .getByRole('button', { name: /Instrument 1: C4, beat 0, velocity 83/ })
    .click();
  await expect(
    page.getByRole('spinbutton', { name: 'Note pitch (MIDI)', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Add note', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Import MIDI', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Export MIDI', exact: true }),
  ).toBeEnabled();
  expect(
    (
      await page.request.patch(`/api/artifacts/${artifact.id}`, {
        headers: { origin },
        data: { version: latest.artifact.version + 1, content },
      })
    ).status(),
  ).toBe(403);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page
        .locator('#project-navigation')
        .evaluate((element) => element.getBoundingClientRect().right),
    )
    .toBeLessThanOrEqual(1);
  await expect(page.getByLabel('MIDI composition editor')).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.locator('.midi-editor').evaluate((element) => {
    element.scrollTop = 190;
  });
  expect(failures).toEqual([]);
  await mkdir(evidence, { recursive: true });
  await page.screenshot({
    path: join(evidence, 'studio-midi-mobile-viewer.png'),
    fullPage: true,
  });
});
