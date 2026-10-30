import { Sandbox } from '@vercel/sandbox';
import {
  runWithIdentity,
  type IdentityExecutionContext,
} from '../hosting/identity-context.ts';
import { Writable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import type {
  AudioRenderDriver,
  AudioRenderOptions,
  AudioProbe,
} from '../audio-renderer.ts';
import type { VideoRenderDriver, RenderOptions } from '../video-renderer.ts';
import { HttpError } from '../store.ts';
import {
  mediaRequestSchema,
  mediaResultSchema,
  mediaRoot,
  workerRoot,
  type MediaRequest,
} from './protocol.ts';
const digest = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
export type MediaSandboxConfig = {
  image: string;
  timeoutMs: number;
  credentials?: { token: string; teamId: string; projectId: string };
};
export function mediaSandboxConfigFromEnv(
  env: NodeJS.ProcessEnv,
): MediaSandboxConfig {
  const image = env.STUDIO_MEDIA_SANDBOX_IMAGE ?? '';
  if (
    !/^(?:vcr\.vercel\.com\/)?[a-zA-Z0-9][a-zA-Z0-9._/-]{0,250}@sha256:[a-f0-9]{64}$/.test(
      image,
    )
  )
    throw new Error(
      'Hosted media requires STUDIO_MEDIA_SANDBOX_IMAGE pinned to a prepared linux/amd64 VCR image digest',
    );
  const timeoutMs = Number(env.STUDIO_MEDIA_SANDBOX_TIMEOUT_MS ?? 240000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 30000 || timeoutMs > 240000)
    throw new Error(
      'Media Sandbox timeout must be between 30000 and 240000 milliseconds',
    );
  let credentials: MediaSandboxConfig['credentials'];
  if (env.VERCEL_TOKEN) {
    if (!env.VERCEL_TEAM_ID || !env.VERCEL_PROJECT_ID)
      throw new Error(
        'External Sandbox access requires token/team/project together',
      );
    credentials = {
      token: env.VERCEL_TOKEN,
      teamId: env.VERCEL_TEAM_ID,
      projectId: env.VERCEL_PROJECT_ID,
    };
  }
  return { image, timeoutMs, ...(credentials ? { credentials } : {}) };
}
type MediaSandbox = Pick<
  Sandbox,
  'writeFiles' | 'readFile' | 'runCommand' | 'stop'
>;
export type MediaSandboxFactory = (
  params: Parameters<typeof Sandbox.create>[0],
) => Promise<MediaSandbox>;
async function boundedFile(
  box: MediaSandbox,
  path: string,
  max: number,
  signal: AbortSignal,
) {
  const stream = await box.readFile({ path }, { signal });
  if (!stream) throw new Error('Media worker output is missing');
  let size = 0;
  const chunks: Buffer[] = [];
  try {
    for await (const part of stream as AsyncIterable<Uint8Array>) {
      signal.throwIfAborted();
      const chunk = Buffer.from(part);
      size += chunk.length;
      if (size > max)
        throw new Error('Media worker output exceeded its byte bound');
      chunks.push(chunk);
    }
  } catch (error) {
    (stream as any).destroy?.();
    throw error;
  }
  return Buffer.concat(chunks, size);
}
export class VercelSandboxMediaRuntime {
  readonly audioRenderDriver: AudioRenderDriver = {
    name: 'vercel-sandbox-ffmpeg',
    runtime: 'remote-worker',
    render: (options) => this.audio(options),
  };
  readonly videoRenderDriver: VideoRenderDriver = {
    name: 'vercel-sandbox-chromium-ffmpeg',
    runtime: 'remote-worker',
    render: (options) => this.video(options),
  };
  readonly audioSourceProbe = (
    bytes: Uint8Array,
    options: { signal?: AbortSignal } = {},
  ) => this.probe(bytes, options.signal);
  constructor(
    readonly config: MediaSandboxConfig,
    readonly create: MediaSandboxFactory = (params) => Sandbox.create(params),
    readonly onDiagnostic?: (code: 'media-sandbox-stop-failed') => void,
    readonly identityExecutionContext?: IdentityExecutionContext,
  ) {
    const fingerprint = 'studio-media-v1:' + config.image;
    Object.assign(this.audioRenderDriver, { fingerprint });
    Object.assign(this.videoRenderDriver, { fingerprint });
  }
  diagnostics() {
    return {
      adapter: 'vercel-sandbox',
      state: 'configured',
      image: this.config.image,
      network: 'deny-all',
      persistent: false,
      verified: false,
    };
  }
  private assetManifest(
    assets: Map<string, { bytes: Uint8Array; mime: string }>,
  ) {
    return [...assets].map(([src, a], index) => ({
      src,
      file: 'asset-' + index + '.bin',
      byteSize: a.bytes.byteLength,
      sha256: digest(a.bytes),
      mime: a.mime,
    }));
  }
  private async execute(
    request: MediaRequest,
    assets: Map<string, { bytes: Uint8Array; mime: string }>,
    sourceSignal?: AbortSignal,
    onProgress?: RenderOptions['onProgress'],
  ) {
    mediaRequestSchema.parse(request);
    const progressController = new AbortController();
    const signal = AbortSignal.any([
      ...(sourceSignal ? [sourceSignal] : []),
      progressController.signal,
      AbortSignal.timeout(this.config.timeoutMs),
    ]);
    signal.throwIfAborted();
    const created = await runWithIdentity(this.identityExecutionContext, () =>
      this.create({
        image: this.config.image,
        persistent: false,
        networkPolicy: 'deny-all',
        resources: { vcpus: 2 },
        ports: [],
        timeout: this.config.timeoutMs,
        signal,
        ...this.config.credentials,
      }),
    );
    const box = this.identityExecutionContext
      ? new Proxy(created, {
          get: (target, property) => {
            const value = Reflect.get(target, property, target);
            if (
              ['writeFiles', 'readFile', 'runCommand', 'stop'].includes(
                String(property),
              )
            )
              return (...args: unknown[]) =>
                this.identityExecutionContext!.run(async () =>
                  Reflect.apply(value, target, args),
                );
            return typeof value === 'function' ? value.bind(target) : value;
          },
        })
      : created;
    let stop: Promise<unknown> | undefined;
    const terminate = () =>
      (stop ??= box.stop({ signal: AbortSignal.timeout(10000) }).catch(() => {
        this.onDiagnostic?.('media-sandbox-stop-failed');
      }));
    const cancel = () => {
      void terminate();
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      signal.throwIfAborted();
      const raw = Buffer.from(JSON.stringify(request));
      await box.writeFiles(
        [{ path: mediaRoot + '/request.json', content: raw, mode: 0o600 }],
        { signal },
      );
      for (const asset of request.assets) {
        signal.throwIfAborted();
        await box.writeFiles(
          [
            {
              path: mediaRoot + '/' + asset.file,
              content: assets.get(asset.src)!.bytes,
              mode: 0o600,
            },
          ],
          { signal },
        );
      }
      let pending = '',
        callbacks = Promise.resolve();
      const stdout = new Writable({
        write(chunk, _encoding, done) {
          pending += chunk.toString();
          if (pending.length > 16384) {
            done(new Error('Invalid media progress stream'));
            return;
          }
          let end: number;
          while ((end = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, end);
            pending = pending.slice(end + 1);
            try {
              const event = JSON.parse(line);
              if (
                event.type === 'progress' &&
                Number.isFinite(event.value) &&
                event.value >= 0 &&
                event.value <= 1
              )
                callbacks = callbacks
                  .then(() => onProgress?.(event.value))
                  .catch((error) => {
                    progressController.abort(error);
                  });
            } catch {}
          }
          done();
        },
      });
      const command = await box.runCommand({
        cmd: '/usr/local/bin/node',
        args: [workerRoot + '/worker.mjs'],
        cwd: mediaRoot,
        env: {
          NODE_ENV: 'production',
          STUDIO_FFMPEG_PATH: '/usr/bin/ffmpeg',
          STUDIO_FFPROBE_PATH: '/usr/bin/ffprobe',
          STUDIO_CHROMIUM_PATH: '/usr/bin/chromium',
        },
        stdout,
        signal,
        timeoutMs: Math.min(215000, this.config.timeoutMs - 5000),
      });
      await callbacks;
      signal.throwIfAborted();
      if (command.exitCode !== 0)
        throw new HttpError(
          502,
          'The packaged media worker failed its runtime or request verification',
        );
      const result = mediaResultSchema.parse(
        JSON.parse(
          (
            await boundedFile(box, mediaRoot + '/result.json', 16384, signal)
          ).toString(),
        ),
      );
      if (result.id !== request.id || result.requestSha256 !== digest(raw))
        throw new HttpError(
          502,
          'The media worker result does not match its immutable input',
        );
      if (result.status === 'error')
        throw new HttpError(
          result.error?.statusCode ?? 502,
          'Media worker: ' + (result.error?.code ?? 'render-failed'),
        );
      let output: Buffer | undefined;
      if (result.output) {
        output = await boundedFile(
          box,
          mediaRoot + '/output.bin',
          result.output.byteSize,
          signal,
        );
        if (
          output.length !== result.output.byteSize ||
          digest(output) !== result.output.sha256
        )
          throw new HttpError(
            502,
            'Media worker output failed integrity verification',
          );
      }
      signal.throwIfAborted();
      return { result, output };
    } finally {
      signal.removeEventListener('abort', cancel);
      await terminate();
    }
  }
  private async audio(options: AudioRenderOptions) {
    const assets = options.assets,
      request: MediaRequest = {
        protocolVersion: 1,
        id: randomUUID(),
        kind: 'audio.render',
        content: options.content,
        format: options.format,
        assets: this.assetManifest(assets),
      };
    const result = await this.execute(
      request,
      assets,
      options.signal,
      options.onProgress,
    );
    if (!result.output)
      throw new HttpError(502, 'The audio worker returned no encoded output');
    return result.output;
  }
  private async video(options: RenderOptions) {
    const assets = options.assets,
      request: MediaRequest = {
        protocolVersion: 1,
        id: randomUUID(),
        kind: 'video.render',
        content: options.content,
        title: options.title,
        format: options.format,
        assets: this.assetManifest(assets),
      };
    const result = await this.execute(
      request,
      assets,
      options.signal,
      options.onProgress,
    );
    if (!result.output)
      throw new HttpError(502, 'The video worker returned no encoded output');
    return result.output;
  }
  private async probe(
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<AudioProbe> {
    const assets = new Map([
      [
        '/api/files/' + randomUUID(),
        { bytes, mime: 'application/octet-stream' },
      ],
    ]);
    const response = await this.execute(
      {
        protocolVersion: 1,
        id: randomUUID(),
        kind: 'audio.probe',
        assets: this.assetManifest(assets),
      },
      assets,
      signal,
    );
    if (!response.result.probe)
      throw new HttpError(502, 'The media worker returned no audio metadata');
    return response.result.probe;
  }
  async verify(signal?: AbortSignal) {
    const response = await this.execute(
      { protocolVersion: 1, id: randomUUID(), kind: 'verify', assets: [] },
      new Map(),
      signal,
    );
    return {
      ...this.diagnostics(),
      state: 'verified',
      verified: true,
      worker: response.result.worker,
    };
  }
}
