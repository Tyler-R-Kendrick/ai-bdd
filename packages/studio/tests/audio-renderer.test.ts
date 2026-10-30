import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  renderAudio,
  type AudioExportFormat,
} from '../server/audio-renderer.ts';
import { audioContentSchema } from '../shared/audio.ts';
const run = promisify(execFile),
  src = '/api/files/00000000-0000-4000-8000-000000000001';
function tone() {
  const rate = 48000,
    frames = rate * 2,
    bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++)
    bytes.writeInt16LE(
      Math.round(Math.sin((i * 2 * Math.PI * 440) / rate) * 0.2 * 32767),
      44 + i * 2,
    );
  return bytes;
}
const assets = new Map([[src, { bytes: tone(), mime: 'audio/wav' }]]);
function project() {
  return audioContentSchema.parse({
    schemaVersion: 1,
    duration: 2,
    sampleRate: 48000,
    tracks: [
      {
        id: 'track',
        title: 'Tone',
        clips: [
          {
            id: 'clip',
            title: 'A440',
            src,
            start: 0.5,
            offset: 0.25,
            duration: 1,
            fadeIn: 0.1,
            fadeOut: 0.1,
          },
        ],
      },
    ],
  });
}
async function decode(bytes: Uint8Array, format: AudioExportFormat) {
  const dir = await mkdtemp(join(tmpdir(), 'audio-output-test-'));
  try {
    const file = join(dir, 'output.' + format),
      pcm = join(dir, 'output.pcm');
    await writeFile(file, bytes);
    const probe = JSON.parse(
      (
        await run('ffprobe', [
          '-v',
          'error',
          '-show_entries',
          'stream=codec_name,sample_rate,channels:format=duration',
          '-of',
          'json',
          file,
        ])
      ).stdout,
    );
    await run('ffmpeg', [
      '-v',
      'error',
      '-i',
      file,
      '-f',
      'f32le',
      '-c:a',
      'pcm_f32le',
      pcm,
    ]);
    const raw = await readFile(pcm);
    return {
      probe,
      sample: (time: number, channel = 0) =>
        raw.readFloatLE((Math.floor(time * 48000) * 2 + channel) * 4),
      rms: (from: number, to: number, channel = 0) => {
        let squares = 0,
          count = 0;
        for (
          let i = Math.floor(from * 48000);
          i < Math.floor(to * 48000);
          i++
        ) {
          const value = raw.readFloatLE((i * 2 + channel) * 4);
          squares += value * value;
          count++;
        }
        return Math.sqrt(squares / count);
      },
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
describe('actual FFmpeg multitrack mixdown independently probed and decoded', () => {
  for (const format of ['wav', 'flac', 'mp3', 'm4a', 'ogg'] as const)
    it(`encodes a complete real ${format} mix with offset, gain/pan and fades`, async () => {
      const content = project();
      content.tracks[0].pan = -1;
      const result = await decode(
        await renderAudio({
          content,
          assets,
          format,
          signal: AbortSignal.timeout(20000),
        }),
        format,
      );
      expect(result.probe.streams[0]).toMatchObject({
        channels: 2,
        sample_rate: '48000',
      });
      expect(Number(result.probe.format.duration)).toBeCloseTo(2, 1);
      expect(result.rms(0.01, 0.2)).toBeLessThan(0.002);
      expect(result.rms(0.7, 1.2)).toBeCloseTo(0.2 / Math.SQRT2, 2);
      expect(result.rms(0.7, 1.2, 1)).toBeLessThan(0.002);
      expect(result.rms(0.5, 0.52)).toBeLessThan(result.rms(0.7, 0.8) / 3);
      expect(result.rms(1.55, 1.8)).toBeLessThan(0.002);
    });
  it('applies mute/solo, master attenuation and track effects to actual output', async () => {
    const content = project();
    content.tracks[0].pan = 0;
    content.tracks[0].gainDb = -6;
    content.tracks.push({
      ...structuredClone(content.tracks[0]),
      id: 'muted',
      mute: true,
      clips: content.tracks[0].clips.map((clip) => ({
        ...clip,
        id: 'muted-clip',
      })),
    });
    const output = await decode(
      await renderAudio({
        content,
        assets,
        format: 'wav',
        signal: AbortSignal.timeout(20000),
      }),
      'wav',
    );
    expect(output.rms(0.7, 1.2)).toBeCloseTo(0.1 * Math.pow(10, -6 / 20), 3);
    content.tracks[0].mute = true;
    const silence = await decode(
      await renderAudio({
        content,
        assets,
        format: 'wav',
        signal: AbortSignal.timeout(20000),
      }),
      'wav',
    );
    expect(silence.rms(0.1, 1.9)).toBe(0);
  });
  it('preserves exact split-clip timeline positions when mixing one immutable source twice', async () => {
    const content = project();
    content.duration = 3;
    content.tracks[0].pan = -1;
    content.tracks.push({
      ...structuredClone(content.tracks[0]),
      id: 'muted',
      mute: true,
      clips: [],
    });
    const left = content.tracks[0].clips[0];
    left.duration = 0.5;
    left.fadeOut = 0;
    content.tracks[0].clips.push({
      ...left,
      id: 'right',
      start: 1,
      offset: 0.75,
      fadeIn: 0,
      fadeOut: 0.1,
    });
    const output = await decode(
      await renderAudio({
        content,
        assets,
        format: 'wav',
        signal: AbortSignal.timeout(20000),
      }),
      'wav',
    );
    expect(output.probe.format.duration).toBe('3.000000');
    expect(output.rms(0.01, 0.3)).toBeLessThan(0.001);
    expect(output.rms(0.7, 0.9)).toBeCloseTo(0.2 / Math.SQRT2, 2);
    expect(output.rms(1.7, 2.8)).toBeLessThan(0.001);
  });
  it('rejects source overruns and cancelled jobs before publication', async () => {
    const content = project();
    content.tracks[0].clips[0].offset = 1.5;
    await expect(
      renderAudio({
        content,
        assets,
        format: 'wav',
        signal: AbortSignal.timeout(20000),
      }),
    ).rejects.toThrow('beyond');
    await expect(
      renderAudio({
        content: project(),
        assets,
        format: 'wav',
        signal: AbortSignal.abort(new Error('Cancelled render')),
      }),
    ).rejects.toThrow('Cancelled render');
  });
});
