import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { probeAudio, renderAudio } from '../audio-renderer.ts';
import { renderVideo } from '../video-renderer.ts';
import { normalizeVideo } from '../../shared/video.ts';
import { HttpError } from '../http-error.ts';
import {
  mediaRequestSchema,
  binaryManifestSchema,
  mediaRoot,
  workerRoot,
} from './protocol.ts';
const digest = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
export const mediaBinaryPaths = {
  worker: workerRoot + '/worker.mjs',
  ffmpeg: '/usr/bin/ffmpeg',
  ffprobe: '/usr/bin/ffprobe',
  chromium: '/usr/lib/chromium/chromium',
  font: workerRoot + '/inter.woff2',
};
export async function fileDigest(path: string) {
  const hash = createHash('sha256');
  for await (const part of createReadStream(path)) hash.update(part);
  return hash.digest('hex');
}
export async function verifyMediaWorker() {
  const manifest = binaryManifestSchema.parse(
    JSON.parse(await readFile(workerRoot + '/manifest.json', 'utf8')),
  );
  for (const [key, path] of Object.entries(mediaBinaryPaths))
    if (
      (await fileDigest(path)) !==
      manifest.files[key as keyof typeof mediaBinaryPaths]
    )
      throw new Error(
        'The packaged media worker failed integrity verification',
      );
  return manifest;
}
/** One immutable request, no network/API/SQL credentials, no publication privileges. */
export async function runMediaWorker() {
  const raw = await readFile(mediaRoot + '/request.json');
  if (raw.length > 1024 * 1024)
    throw new Error('Media request exceeds worker bound');
  const request = mediaRequestSchema.parse(JSON.parse(raw.toString())),
    manifest = await verifyMediaWorker();
  const signal = AbortSignal.timeout(210000),
    assets = new Map<string, { bytes: Buffer; mime: string }>();
  for (const asset of request.assets) {
    const file = mediaRoot + '/' + asset.file,
      stat = await lstat(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size !== asset.byteSize
    )
      throw new Error('Media asset does not match immutable manifest');
    const bytes = await readFile(file);
    if (digest(bytes) !== asset.sha256)
      throw new Error('Media asset digest mismatch');
    assets.set(asset.src, { bytes, mime: asset.mime });
  }
  const base = {
    protocolVersion: 1,
    id: request.id,
    requestSha256: digest(raw),
    worker: manifest,
  };
  const onProgress = (value: number) => {
    if (Number.isFinite(value) && value >= 0 && value <= 1)
      process.stdout.write(
        JSON.stringify({ type: 'progress', value }) + '\n',
      );
  };
  let result: any;
  try {
    let output: Buffer | undefined;
    if (request.kind === 'audio.probe')
      result = {
        ...base,
        status: 'completed',
        probe: await probeAudio(assets.values().next().value!.bytes, {
          signal,
        }),
      };
    else if (request.kind === 'verify')
      result = { ...base, status: 'completed' };
    else {
      if (request.kind === 'audio.render')
        output = await renderAudio({
          content: request.content,
          assets,
          format: request.format,
          signal,
          onProgress,
        });
      else
        output = await renderVideo({
          content: normalizeVideo(request.content),
          assets,
          title: request.title,
          format: request.format,
          signal,
          onProgress,
          chromiumPath: '/usr/bin/chromium',
          ffmpegPath: '/usr/bin/ffmpeg',
          chromium: createRequire(import.meta.url)('playwright-core')
            .chromium,
          interFont: await readFile(mediaBinaryPaths.font),
        });
      if (output.length >= 100 * 1024 * 1024)
        throw new HttpError(413, 'Media output exceeds worker bound');
      await writeFile(mediaRoot + '/output.bin', output, { mode: 0o600 });
      result = {
        ...base,
        status: 'completed',
        output: { byteSize: output.length, sha256: digest(output) },
      };
    }
  } catch (error) {
    const statusCode =
      error instanceof HttpError && [400, 413].includes(error.statusCode)
        ? error.statusCode
        : 500;
    result = {
      ...base,
      status: 'error',
      error: {
        code:
          statusCode === 413
            ? 'resource-limit'
            : statusCode === 400
              ? 'invalid-media'
              : 'render-failed',
        statusCode,
      },
    };
  }
  await writeFile(mediaRoot + '/result.json', JSON.stringify(result), {
    mode: 0o600,
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  void runMediaWorker().catch(() => {
    process.stderr.write(
      'The media worker request or packaged runtime failed verification.\n',
    );
    process.exitCode = 1;
  });
