import { describe, expect, it } from 'vitest';
import { chromium } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const fixture = fileURLToPath(
  new URL('./fixtures/video-source-runtime.ts', import.meta.url),
);
const tsx = fileURLToPath(import.meta.resolve('tsx/cli'));

describe('Development-source video runtime', () => {
  it('executes capture and portable timelines from actual tsx output without exposing trusted-code helpers or executing clip text', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'studio-video-source-'));
    const browser = await chromium.launch({
      executablePath:
        process.env.AI_BDD_CHROMIUM_PATH ??
        process.env.STUDIO_CHROMIUM_PATH ??
        '/usr/bin/chromium',
      args: ['--no-sandbox'],
    });
    try {
      await execute(process.execPath, [tsx, fixture, directory]);
      for (const mode of ['capture', 'portable']) {
        const source = await readFile(join(directory, mode + '.html'), 'utf8');
        // Prove this fixture really exercised the source compiler's keepNames
        // transformation instead of silently passing through a production build.
        expect(source).toMatch(/__name\(easing,/);
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.setContent(source);
        await page.evaluate(async (mode) => {
          const w = window as any;
          if (mode === 'capture') await w.__studioSeek(0.5);
          else w.__timelines['studio-composition'].seek(0.5);
        }, mode);
        const clip = page.locator('#clip-00000000-0000-4000-8000-000000000001');
        await expect(
          clip.evaluate((node) => (node as HTMLElement).style.left),
        ).resolves.toBe('20px');
        expect(await clip.textContent()).toBe(
          '</script><script>window.__untrusted=true</script>\u2028\u2029',
        );
        expect(await page.locator('script').count()).toBe(1);
        expect(
          await page.evaluate(() => ({
            injected: '__untrusted' in window,
            leakedHelper: '__name' in window,
          })),
        ).toEqual({ injected: false, leakedHelper: false });
        expect(errors).toEqual([]);
        if (mode === 'portable')
          expect(
            await page.evaluate(() => {
              const timeline = (window as any).__timelines[
                'studio-composition'
              ];
              return [timeline.duration(), timeline.time(), timeline.paused()];
            }),
          ).toEqual([1, 0.5, true]);
        await page.close();
      }
    } finally {
      await browser.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 45000);

  it('encodes odd-sized MP4 and WebM directly through tsx with bounded even-dimension padding', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'studio-video-source-odd-'));
    try {
      await execute(process.execPath, [tsx, fixture, directory, 'render'], {
        timeout: 70000,
      });
      for (const [format, codec] of [
        ['mp4', 'h264'],
        ['webm', 'vp9'],
      ]) {
        const probe = JSON.parse(
          (
            await execute('ffprobe', [
              '-v',
              'error',
              '-show_entries',
              'format=duration:stream=codec_type,codec_name,width,height',
              '-of',
              'json',
              join(directory, 'odd.' + format),
            ])
          ).stdout,
        );
        expect(probe.streams).toEqual([
          {
            codec_name: codec,
            codec_type: 'video',
            width: 130,
            height: 98,
          },
        ]);
        expect(Number(probe.format.duration)).toBeCloseTo(1, 2);
        // Decode every frame too: a successful probe alone is insufficient.
        await execute('ffmpeg', [
          '-v',
          'error',
          '-i',
          join(directory, 'odd.' + format),
          '-f',
          'null',
          '-',
        ]);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 75000);
});
