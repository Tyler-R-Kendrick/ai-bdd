import { describe, it, expect, vi } from 'vitest';
import { Sandbox } from '@vercel/sandbox';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import {
  VercelSandboxMediaRuntime,
  mediaSandboxConfigFromEnv,
  type MediaSandboxFactory,
} from '../server/media/vercel-sandbox.ts';
import { initialAudioContent } from '../shared/audio.ts';
const digest = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
const image = 'private-studio-media@sha256:' + 'a'.repeat(64);
const config = { image, timeoutMs: 240000 };
const worker = {
  workerVersion: 'studio-media-worker-v1',
  files: Object.fromEntries(
    ['worker', 'ffmpeg', 'ffprobe', 'chromium', 'font'].map((k) => [
      k,
      '0'.repeat(64),
    ]),
  ),
  versions: {
    node: 'v24-fixture',
    ffmpeg: 'ffmpeg-protocol-fixture',
    ffprobe: 'ffprobe-protocol-fixture',
    chromium: 'chromium-protocol-fixture',
  },
};
function fixture(
  options: {
    tamper?: (result: any) => void;
    pending?: boolean;
    progress?: boolean;
    bytes?: Buffer;
  } = {},
) {
  const files = new Map<string, Buffer>(),
    output = options.bytes ?? Buffer.from('encoded-output-protocol-fixture');
  let params: any, command: any, ready!: () => void;
  const incoming = new Promise<void>((resolve) => (ready = resolve));
  const stop = vi.fn(async () => {}),
    create = vi.fn(async (p: any) => {
      params = p;
      return {
        async writeFiles(items: any[]) {
          for (const item of items)
            files.set(item.path, Buffer.from(item.content));
        },
        async runCommand(p: any) {
          command = p;
          ready();
          if (options.pending)
            await new Promise((_, reject) =>
              p.signal.addEventListener(
                'abort',
                () => reject(p.signal.reason),
                { once: true },
              ),
            );
          if (options.progress) {
            p.stdout.write(Buffer.from('{"type":"progress","value":0.4}\n'));
            await new Promise((resolve) => setTimeout(resolve, 0));
            p.signal.throwIfAborted();
          }
          const raw = files.get('/vercel/sandbox/request.json')!,
            request = JSON.parse(raw.toString());
          const result: any = {
            protocolVersion: 1,
            id: request.id,
            requestSha256: digest(raw),
            worker,
            status: 'completed',
            output: { byteSize: output.length, sha256: digest(output) },
          };
          options.tamper?.(result);
          files.set(
            '/vercel/sandbox/result.json',
            Buffer.from(JSON.stringify(result)),
          );
          files.set('/vercel/sandbox/output.bin', output);
          return { exitCode: 0 };
        },
        async readFile({ path }: any) {
          const bytes = files.get(path);
          return bytes ? Readable.from([bytes]) : null;
        },
        stop,
      };
    });
  const runtime = new VercelSandboxMediaRuntime(
    config,
    create as unknown as MediaSandboxFactory,
  );
  return {
    runtime,
    create,
    stop,
    files,
    incoming,
    params: () => params,
    command: () => command,
    output,
  };
}
const request = () => ({
  content: initialAudioContent(),
  assets: new Map([
    [
      '/api/files/' + randomUUID(),
      { bytes: Buffer.from('owned-source-bytes'), mime: 'audio/wav' },
    ],
  ]),
  format: 'wav' as const,
  signal: new AbortController().signal,
});
describe('Vercel Sandbox media adapter boundary (explicit SDK protocol fixture)', () => {
  it('requires a pinned private-image reference and bounded timeout without a local binary fallback', () => {
    expect(() => mediaSandboxConfigFromEnv({})).toThrow('pinned');
    expect(() =>
      mediaSandboxConfigFromEnv({
        STUDIO_MEDIA_SANDBOX_IMAGE: 'repo:latest',
      }),
    ).toThrow('pinned');
    expect(() =>
      mediaSandboxConfigFromEnv({
        STUDIO_MEDIA_SANDBOX_IMAGE: image,
        STUDIO_MEDIA_SANDBOX_TIMEOUT_MS: '999999',
      }),
    ).toThrow('timeout');
    expect(() =>
      mediaSandboxConfigFromEnv({
        STUDIO_MEDIA_SANDBOX_IMAGE: image,
        VERCEL_TOKEN: 'fixture-secret',
      }),
    ).toThrow('together');
    expect(
      mediaSandboxConfigFromEnv({ STUDIO_MEDIA_SANDBOX_IMAGE: image }),
    ).toEqual(config);
  });
  it('transfers owned bytes with immutable digests, runs the whole renderer deny-all and always stops its nonpersistent VM', async () => {
    const w = fixture(),
      input = request();
    expect(await w.runtime.audioRenderDriver.render(input)).toEqual(w.output);
    expect(w.params()).toMatchObject({
      image,
      persistent: false,
      networkPolicy: 'deny-all',
      ports: [],
      resources: { vcpus: 2 },
      timeout: 240000,
    });
    expect(w.params().env).toBeUndefined();
    const submitted = JSON.parse(
      w.files.get('/vercel/sandbox/request.json')!.toString(),
    );
    expect(submitted.assets[0]).toMatchObject({
      sha256: digest(input.assets.values().next().value!.bytes),
      file: 'asset-0.bin',
    });
    expect(w.command()).toMatchObject({
      cmd: '/usr/local/bin/node',
      args: ['/opt/studio-media/worker.mjs'],
      cwd: '/vercel/sandbox',
      timeoutMs: 215000,
    });
    expect(
      Object.keys(w.command().env).some((key) =>
        /TOKEN|SECRET|DATABASE|BLOB|GATEWAY|KEY/.test(key),
      ),
    ).toBe(false);
    expect(w.stop).toHaveBeenCalledOnce();
  });
  it.each(['request', 'output'] as const)(
    'rejects a changed %s digest before returning media',
    async (kind) => {
      const w = fixture({
        tamper: (result) => {
          if (kind === 'request') result.requestSha256 = 'f'.repeat(64);
          else result.output.sha256 = 'f'.repeat(64);
        },
      });
      await expect(
        w.runtime.audioRenderDriver.render(request()),
      ).rejects.toMatchObject({ statusCode: 502 });
      expect(w.stop).toHaveBeenCalledOnce();
    },
  );
  it('rejects manifest path injection and excess input before creating a VM', async () => {
    const w = fixture(),
      input = request();
    input.assets = new Map([
      [
        'https://attacker.invalid/private',
        { bytes: Buffer.from('bad'), mime: 'audio/wav' },
      ],
    ]);
    await expect(w.runtime.audioRenderDriver.render(input)).rejects.toThrow();
    expect(w.create).not.toHaveBeenCalled();
  });
  it('stops an in-flight VM on cancellation and never downloads or returns a late output', async () => {
    const w = fixture({ pending: true }),
      controller = new AbortController(),
      running = w.runtime.audioRenderDriver
        .render({ ...request(), signal: controller.signal })
        .catch((error) => error);
    await w.incoming;
    controller.abort(new Error('principal cancelled'));
    expect((await running).message).toBe('principal cancelled');
    expect(w.stop).toHaveBeenCalledOnce();
    expect(w.files.has('/vercel/sandbox/output.bin')).toBe(false);
  });
  it('stops processing when the durable progress guard fails instead of publishing media after revocation', async () => {
    const w = fixture({ progress: true });
    await expect(
      w.runtime.audioRenderDriver.render({
        ...request(),
        onProgress: async () => {
          throw new Error('durable fence lost');
        },
      }),
    ).rejects.toThrow('durable fence lost');
    expect(w.stop).toHaveBeenCalledOnce();
  });
});

it('sends the actual installed Sandbox SDK create contract over HTTP and exposes account rejection without local fallback', async () => {
  const calls: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    calls.push({
      path: req.url,
      body: JSON.parse(raw),
      authorization: req.headers.authorization,
    });
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        error: {
          code: 'forbidden',
          message: 'Explicit SDK HTTP fixture rejected account access',
        },
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const factory: MediaSandboxFactory = (params) =>
      Sandbox.create({
        ...params,
        token: 'explicit-sdk-account-fixture',
        teamId: 'team_fixture',
        projectId: 'prj_fixture',
        fetch: async (input, init) => {
          const request = new Request(input, init),
            url = new URL(request.url);
          return fetch(
            'http://127.0.0.1:' +
              (server.address() as any).port +
              url.pathname +
              url.search,
            {
              method: request.method,
              headers: request.headers,
              body: await request.arrayBuffer(),
            },
          );
        },
      });
    const runtime = new VercelSandboxMediaRuntime(config, factory);
    await expect(
      runtime.audioRenderDriver.render(request()),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
    expect(calls[0].authorization).toBe(
      'Bearer explicit-sdk-account-fixture',
    );
    expect(calls[0].body).toMatchObject({
      image,
      persistent: false,
      networkPolicy: { mode: 'deny-all' },
      resources: { vcpus: 2 },
    });
    expect(calls[0].body.env ?? {}).toEqual({});
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
