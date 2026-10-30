import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeAudio } from '../server/audio-renderer.ts';
const run = promisify(execFile);
async function tone(duration = 1, rate = 48000, channels = 2) {
  const directory = await mkdtemp(join(tmpdir(), 'audio-probe-fixture-'));
  try {
    const file = join(directory, 'source.flac');
    await run(
      'ffmpeg',
      [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=440:duration=${duration}:sample_rate=${rate}`,
        '-ac',
        String(channels),
        '-c:a',
        'flac',
        file,
      ],
      { timeout: 20000 },
    );
    return await readFile(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
describe('actual FFprobe pre-decode admission', () => {
  it('probes real encoded audio and reports its decoded resource budget', async () => {
    expect(await probeAudio(await tone())).toMatchObject({
      duration: 1,
      sampleRate: 48000,
      channels: 2,
      decodedBytes: 384000,
      codec: 'flac',
    });
  });
  it('rejects a small compressed source whose decoded PCM exceeds the budget', async () => {
    const bytes = await tone(60, 192000, 2);
    expect(bytes.length).toBeLessThan(10 * 1024 * 1024);
    await expect(probeAudio(bytes)).rejects.toMatchObject({ statusCode: 413 });
  });
  it('rejects malformed media and respects an already cancelled request', async () => {
    await expect(probeAudio(new Uint8Array(100))).rejects.toMatchObject({
      statusCode: 400,
    });
    const signal = AbortSignal.abort(new Error('Admission cancelled'));
    await expect(probeAudio(await tone(), { signal })).rejects.toThrow(
      'Admission cancelled',
    );
  });
});
