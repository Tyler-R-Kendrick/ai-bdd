import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { videoHTML, type VideoAssetMap } from '../shared/video-html.ts';
import type { TimelineContent, VideoClip } from '../shared/video.ts';
export type RenderAsset = { bytes: Buffer; mime: string };
export type RenderOptions = {
  content: TimelineContent;
  title: string;
  assets: Map<string, RenderAsset>;
  format: 'mp4' | 'webm';
  signal: AbortSignal;
  onProgress?: (progress: number) => void;
  chromiumPath?: string;
  ffmpegPath?: string;
  interFont?: Buffer;
};
/** A renderer runs on a durable background worker, never implicitly inside a Vercel response lifecycle. */
export interface VideoRenderDriver {
  readonly name: string;
  readonly runtime: 'long-lived-worker' | 'remote-worker';
  render(options: RenderOptions): Promise<Buffer>;
}
export const cpuVideoRenderDriver: VideoRenderDriver = {
  name: 'chromium-ffmpeg',
  runtime: 'long-lived-worker',
  render: renderVideo,
};
async function processOutput(
  program: string,
  args: string[],
  signal: AbortSignal,
) {
  const process = spawn(program, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    signal,
  });
  let stdout = '',
    stderr = '';
  process.stdout.on('data', (data: Buffer) => {
    stdout = (stdout + data.toString()).slice(-65536);
  });
  process.stderr.on('data', (data: Buffer) => {
    stderr = (stderr + data.toString()).slice(-65536);
  });
  const [code] = await once(process, 'close');
  if (code !== 0)
    throw new Error(`Media decoder failed: ${stderr.slice(-1000)}`);
  return stdout;
}
export async function rendererFont() {
  try {
    return await readFile(
      createRequire(import.meta.url).resolve(
        '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
      ),
    );
  } catch {}
  try {
    const dir = resolve(import.meta.dirname, '../client/assets');
    const name = (await readdir(dir)).find((entry) =>
      /^inter-latin-wght-normal-.*\.woff2$/.test(entry),
    );
    if (name) return await readFile(join(dir, name));
  } catch {}
  return undefined;
}
function volumeExpression(clip: VideoClip) {
  const keys = clip.keyframes
    .filter((key) => key.property === 'volume')
    .sort((a, b) => a.at - b.at);
  if (!keys.length) return String(clip.volume);
  const t = `(t+${clip.animationOffset})`;
  let expression = String(keys[keys.length - 1]!.value);
  for (let index = keys.length - 1; index > 0; index--) {
    const a = keys[index - 1]!,
      b = keys[index]!;
    const f = `((${t}-${a.at})/${b.at - a.at})`;
    const ease =
      b.easing === 'hold'
        ? `gte(${f},1)`
        : b.easing === 'ease-in'
          ? `pow(${f},2)`
          : b.easing === 'ease-out'
            ? `(1-pow(1-${f},2))`
            : b.easing === 'ease-in-out'
              ? `if(lt(${f},0.5),2*pow(${f},2),1-pow(-2*${f}+2,2)/2)`
              : f;
    expression = `if(lte(${t},${b.at}),${a.value}+(${b.value - a.value})*${ease},${expression})`;
  }
  return `if(lte(${t},${keys[0]!.at}),${keys[0]!.value},${expression})`;
}
export async function renderVideo(options: RenderOptions): Promise<Buffer> {
  const { content, signal } = options;
  const frames = Math.ceil(content.duration * content.fps);
  if (frames * content.width * content.height > 18_000_000_000)
    throw new Error(
      'This render exceeds the frame-pixel budget. Reduce resolution, frame rate, or duration.',
    );
  if (
    options.assets.size > 64 ||
    [...options.assets.values()].reduce(
      (total, asset) => total + asset.bytes.length,
      0,
    ) >
      128 * 1024 * 1024
  )
    throw new Error('This render exceeds the 128 MB / 64 asset budget.');
  const folder = await mkdtemp(join(tmpdir(), 'studio-video-'));
  let browser:
    | Awaited<
        ReturnType<(typeof import('@playwright/test'))['chromium']['launch']>
      >
    | undefined;
  let encoder: ReturnType<typeof spawn> | undefined;
  try {
    const files = new Map<string, string>(),
      assets: VideoAssetMap = {};
    for (const [url, asset] of options.assets) {
      const file = join(folder, 'asset-' + files.size);
      await writeFile(file, asset.bytes, { mode: 0o600 });
      files.set(url, file);
      assets[url] = {
        mime: asset.mime,
        url: `data:${asset.mime};base64,${asset.bytes.toString('base64')}`,
      };
    }
    const audio: { clip: VideoClip; path: string }[] = [];
    const ffmpeg =
      options.ffmpegPath ?? process.env.STUDIO_FFMPEG_PATH ?? 'ffmpeg';
    const ffprobe = process.env.STUDIO_FFPROBE_PATH ?? 'ffprobe';
    const inputMetadata = new Map<
      string,
      {
        streams: { codec_type: string; width?: number; height?: number }[];
        format?: { duration?: string };
      }
    >();
    for (const clip of content.clips.filter((clip) => clip.src)) {
      const path = files.get(clip.src!)!;
      if (!inputMetadata.has(clip.src!)) {
        inputMetadata.set(
          clip.src!,
          JSON.parse(
            await processOutput(
              ffprobe,
              [
                '-v',
                'error',
                '-protocol_whitelist',
                'file,pipe',
                '-show_entries',
                'stream=codec_type,width,height:format=duration',
                '-of',
                'json',
                path,
              ],
              signal,
            ),
          ),
        );
      }
      const source = inputMetadata.get(clip.src!)!;
      const visual = source.streams?.find(
        (stream) => stream.codec_type === 'video',
      );
      if (
        ['image', 'video'].includes(clip.type) &&
        (!visual ||
          !visual.width ||
          !visual.height ||
          visual.width > 16384 ||
          visual.height > 16384 ||
          visual.width * visual.height > 64_000_000)
      )
        throw new Error(
          `“${clip.name}” has invalid or oversized decoded dimensions.`,
        );
      if (clip.type === 'video' || clip.type === 'audio') {
        const actualDuration = Number(source.format?.duration);
        if (
          !Number.isFinite(actualDuration) ||
          actualDuration <= 0 ||
          clip.mediaStart + clip.duration > actualDuration + 0.05
        )
          throw new Error(
            `“${clip.name}” exceeds its actual source duration. Reimport the media and adjust its trim.`,
          );
        const hasAudio = source.streams?.some(
          (stream) => stream.codec_type === 'audio',
        );
        if (clip.type === 'audio' && !hasAudio)
          throw new Error(`“${clip.name}” has no decodable audio stream.`);
        if (!clip.muted && hasAudio) audio.push({ clip, path });
      }
    }
    const decodedPixels = [...inputMetadata.values()].reduce(
      (total, source) =>
        total +
        (source.streams ?? [])
          .filter((stream) => stream.codec_type === 'video')
          .reduce(
            (sum, stream) => sum + (stream.width ?? 0) * (stream.height ?? 0),
            0,
          ),
      0,
    );
    if (decodedPixels > 64_000_000)
      throw new Error(
        'This composition exceeds its 64 megapixel decoded-media budget. Resize or remove source assets.',
      );
    const output = join(folder, 'render.' + options.format);
    const args = [
      '-v',
      'error',
      '-nostdin',
      '-y',
      '-threads',
      '1',
      '-f',
      'image2pipe',
      '-framerate',
      String(content.fps),
      '-vcodec',
      'png',
      '-i',
      'pipe:0',
    ];
    for (const item of audio)
      args.push('-protocol_whitelist', 'file,pipe', '-i', item.path);
    args.push('-map', '0:v:0');
    if (audio.length) {
      const filters = audio.map(
        ({ clip }, index) =>
          `[${index + 1}:a]atrim=start=${clip.mediaStart}:duration=${clip.duration},asetpts=PTS-STARTPTS,volume='${volumeExpression(clip)}':eval=frame,adelay=${Math.round(clip.start * 1000)}:all=1[a${index}]`,
      );
      filters.push(
        audio.map((_, index) => `[a${index}]`).join('') +
          `amix=inputs=${audio.length}:duration=longest:normalize=0,apad[mix]`,
      );
      args.push(
        '-filter_complex',
        filters.join(';'),
        '-map',
        '[mix]',
        '-c:a',
        options.format === 'mp4' ? 'aac' : 'libopus',
        '-b:a',
        '192k',
      );
    } else args.push('-an');
    args.push(
      '-c:v',
      options.format === 'mp4' ? 'libx264' : 'libvpx-vp9',
      '-threads',
      '1',
      '-pix_fmt',
      'yuv420p',
      '-vf',
      'pad=ceil(iw/2)*2:ceil(ih/2)*2',
      '-t',
      String(content.duration),
      '-map_metadata',
      '-1',
    );
    if (options.format === 'mp4')
      args.push('-preset', 'veryfast', '-crf', '18', '-movflags', '+faststart');
    else
      args.push(
        '-deadline',
        'good',
        '-cpu-used',
        '4',
        '-crf',
        '24',
        '-b:v',
        '0',
      );
    args.push('-fs', String(256 * 1024 * 1024), output);
    encoder = spawn(ffmpeg, args, {
      stdio: ['pipe', 'ignore', 'pipe'],
      signal,
    });
    encoder.stdin!.on('error', () => {});
    let errorText = '';
    encoder.stderr!.on('data', (chunk: Buffer) => {
      errorText = (errorText + chunk.toString()).slice(-8192);
    });
    const finished = new Promise<void>((resolve, reject) => {
      encoder!.once('error', reject);
      encoder!.once('close', (code) =>
        code === 0
          ? resolve()
          : reject(
              new Error(`Video encoding failed: ${errorText.slice(-2000)}`),
            ),
      );
    });
    // Observe rejection during browser initialization and frame capture as well.
    void finished.catch(() => {});
    const require = createRequire(
      import.meta.resolve('@ai-bdd/driver-playwright'),
    );
    const { chromium } =
      require('playwright-core') as typeof import('@playwright/test');
    browser = await chromium.launch({
      executablePath:
        options.chromiumPath ??
        process.env.AI_BDD_CHROMIUM_PATH ??
        process.env.STUDIO_CHROMIUM_PATH ??
        '/usr/bin/chromium',
      headless: true,
      args: ['--no-sandbox'],
    });
    const page = await browser.newPage({
      viewport: { width: content.width, height: content.height },
      deviceScaleFactor: 1,
    });
    await page.route('**/*', (route) => route.abort('blockedbyclient'));
    const font = options.interFont ?? (await rendererFont());
    if (!font && content.clips.some((clip) => clip.fontFamily === 'Inter'))
      throw new Error(
        'The built-in Inter renderer font is missing. Rebuild Studio before rendering.',
      );
    await page.setContent(
      videoHTML(content, options.title, {
        assets,
        renderer: true,
        interFont: font
          ? `data:font/woff2;base64,${font.toString('base64')}`
          : undefined,
      }),
      { waitUntil: 'load', timeout: 30000 },
    );
    for (let frame = 0; frame < frames; frame++) {
      signal.throwIfAborted();
      await page.evaluate(async (time) => {
        await (window as any).__studioSeek(time);
      }, frame / content.fps);
      const png = await page.screenshot({
        type: 'png',
        animations: 'disabled',
        timeout: 15000,
      });
      if (!encoder.stdin!.write(png))
        await once(encoder.stdin!, 'drain', { signal });
      if (frame % 10 === 0) options.onProgress?.(frame / frames);
    }
    encoder.stdin!.end();
    await finished;
    const bytes = await readFile(output);
    if (bytes.length < 100 || bytes.length >= 256 * 1024 * 1024)
      throw new Error('Video output is empty or exceeded its 256 MB limit.');
    const metadata = JSON.parse(
      await processOutput(
        ffprobe,
        [
          '-v',
          'error',
          '-protocol_whitelist',
          'file,pipe',
          '-show_entries',
          'format=duration:stream=codec_type,width,height',
          '-of',
          'json',
          output,
        ],
        signal,
      ),
    );
    if (
      Math.abs(Number(metadata.format?.duration) - content.duration) > 0.15 ||
      !metadata.streams?.some(
        (stream: { codec_type: string }) => stream.codec_type === 'video',
      )
    )
      throw new Error(
        'The encoder did not produce the requested complete duration.',
      );
    options.onProgress?.(1);
    return bytes;
  } finally {
    encoder?.kill('SIGKILL');
    await browser?.close().catch(() => {});
    await rm(folder, { force: true, recursive: true });
  }
}
