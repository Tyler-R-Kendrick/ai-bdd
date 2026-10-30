import { describe, expect, it } from 'vitest';
import { chromium } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderVideo, type RenderOptions } from '../server/video-renderer.ts';
import { newClip } from '../shared/video-timeline.ts';
import type { TimelineContent } from '../shared/video.ts';
const execute = promisify(execFile);
describe('Deterministic video encoder', () => {
  it('captures exact timeline frames and mixes a genuinely trimmed audio source into MP4', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'studio-video-test-'));
    try {
      const audio = join(folder, 'audio.wav');
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
      const url = '/api/files/00000000-0000-4000-8000-000000000001';
      const title = {
        ...newClip('text', 1, 0),
        fontFamily: 'Georgia' as const,
        text: 'Motion with intent',
        fontSize: 26,
        x: 20,
        y: 40,
        width: 280,
        height: 60,
        keyframes: [
          {
            property: 'x' as const,
            at: 0,
            value: 10,
            easing: 'linear' as const,
          },
          {
            property: 'x' as const,
            at: 1,
            value: 35,
            easing: 'ease-out' as const,
          },
        ],
      };
      const track = {
        ...newClip('audio', 1, 1),
        src: url,
        mediaStart: 0.5,
        sourceDuration: 2,
        volume: 0.3,
        keyframes: [
          {
            property: 'volume' as const,
            at: 0,
            value: 0,
            easing: 'linear' as const,
          },
          {
            property: 'volume' as const,
            at: 1,
            value: 1,
            easing: 'linear' as const,
          },
        ],
      };
      const content: TimelineContent = {
        width: 320,
        height: 180,
        background: '#ffffff',
        duration: 1,
        fps: 24,
        clips: [title, track],
      };
      const options: RenderOptions = {
        chromium,
        content,
        title: 'Deterministic fixture',
        assets: new Map([
          [url, { bytes: await readFile(audio), mime: 'audio/wav' }],
        ]),
        format: 'mp4',
        signal: AbortSignal.timeout(45000),
      };
      const bytes = await renderVideo(options);
      const repeat = await renderVideo(options);
      expect(repeat.equals(bytes)).toBe(true);
      const output = join(folder, 'render.mp4');
      await writeFile(output, bytes);
      const probe = JSON.parse(
        (
          await execute('ffprobe', [
            '-v',
            'error',
            '-show_entries',
            'format=duration:stream=codec_name,codec_type,width,height,nb_frames',
            '-of',
            'json',
            output,
          ])
        ).stdout,
      );
      expect(
        probe.streams.find((stream: any) => stream.codec_type === 'video'),
      ).toMatchObject({
        codec_name: 'h264',
        width: 320,
        height: 180,
        nb_frames: '24',
      });
      expect(
        probe.streams.find((stream: any) => stream.codec_type === 'audio'),
      ).toMatchObject({ codec_name: 'aac' });
      expect(Number(probe.format.duration)).toBeCloseTo(1, 1);
      expect(bytes.length).toBeGreaterThan(2000);
      const rms = async (start: string) => {
        const decoded = await execute(
          'ffmpeg',
          [
            '-v',
            'error',
            '-ss',
            start,
            '-i',
            output,
            '-t',
            '0.1',
            '-vn',
            '-ac',
            '1',
            '-ar',
            '48000',
            '-f',
            'f32le',
            'pipe:1',
          ],
          { encoding: 'buffer' },
        );
        const samples = decoded.stdout as Buffer;
        let power = 0;
        for (let index = 0; index + 4 <= samples.length; index += 4)
          power += samples.readFloatLE(index) ** 2;
        return Math.sqrt(power / (samples.length / 4));
      };
      const quiet = await rms('0.15'),
        loud = await rms('0.75');
      expect(loud / quiet).toBeGreaterThan(2.5);
      expect(loud / quiet).toBeLessThan(6.5);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }, 60000);
  it('rejects a claimed trim range beyond the actual decoded source duration', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'studio-video-duration-'));
    try {
      const path = join(folder, 'short.wav');
      await execute('ffmpeg', [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=400:duration=0.1',
        path,
      ]);
      const src = '/api/files/00000000-0000-4000-8000-000000000001';
      const content: TimelineContent = {
        width: 320,
        height: 180,
        duration: 1,
        fps: 24,
        background: '#ffffff',
        clips: [{ ...newClip('audio', 1, 0), src, sourceDuration: 20 }],
      };
      await expect(
        renderVideo({
          content,
          title: 'False duration',
          assets: new Map([
            [src, { bytes: await readFile(path), mime: 'audio/wav' }],
          ]),
          format: 'mp4',
          signal: AbortSignal.timeout(10000),
        }),
      ).rejects.toThrow('actual source duration');
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
  it('rejects an invalid uploaded font instead of completing with substituted typography', async () => {
    const fontUrl = '/api/files/00000000-0000-4000-8000-000000000003';
    const content: TimelineContent = {
      width: 320,
      height: 180,
      duration: 1,
      fps: 24,
      background: '#ffffff',
      clips: [{ ...newClip('text', 1, 0), fontFamily: 'Custom', fontUrl }],
    };
    await expect(
      renderVideo({
        content,
        title: 'Font decode failure',
        assets: new Map([
          [
            fontUrl,
            {
              bytes: Buffer.from('wOF2-corrupt-test-fixture'),
              mime: 'font/woff2',
            },
          ],
        ]),
        format: 'mp4',
        signal: AbortSignal.timeout(10000),
      }),
    ).rejects.toThrow('composition font could not be decoded');
  });
});
