import { z } from 'zod';
import { audioContentSchema } from '../../shared/audio.ts';
import { videoContentSchema } from '../../shared/video.ts';
export const mediaProtocolVersion = 1;
export const mediaWorkerVersion = 'studio-media-worker-v1';
export const mediaRoot = '/vercel/sandbox';
export const workerRoot = '/opt/studio-media';
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const assetSchema = z
  .object({
    src: z.string().regex(/^\/api\/files\/[0-9a-f-]{36}$/i),
    file: z.string().regex(/^asset-[0-9]{1,3}\.bin$/),
    byteSize: z
      .number()
      .int()
      .positive()
      .max(128 * 1024 * 1024),
    sha256: sha256Schema,
    mime: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i),
  })
  .strict();
const common = {
  protocolVersion: z.literal(1),
  id: z.string().uuid(),
  assets: z.array(assetSchema).max(64),
};
export const mediaRequestSchema = z
  .discriminatedUnion('kind', [
    z.object({ ...common, kind: z.literal('audio.probe') }).strict(),
    z
      .object({
        ...common,
        kind: z.literal('audio.render'),
        content: audioContentSchema,
        format: z.enum(['wav', 'flac', 'mp3', 'm4a', 'ogg']),
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal('video.render'),
        content: videoContentSchema,
        title: z.string().max(500),
        format: z.enum(['mp4', 'webm']),
      })
      .strict(),
    z.object({ ...common, kind: z.literal('verify') }).strict(),
  ])
  .superRefine((request, ctx) => {
    const max =
      request.kind === 'audio.probe'
        ? 10 * 1024 * 1024
        : request.kind === 'audio.render'
          ? 64 * 1024 * 1024
          : 128 * 1024 * 1024;
    if (
      new Set(request.assets.map((a) => a.src)).size !==
        request.assets.length ||
      new Set(request.assets.map((a) => a.file)).size !==
        request.assets.length ||
      request.assets.reduce((n, a) => n + a.byteSize, 0) > max ||
      (request.kind === 'audio.probe' && request.assets.length !== 1) ||
      (request.kind === 'verify' && request.assets.length !== 0)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'The bounded media asset manifest is invalid',
      });
  });
export type MediaRequest = z.infer<typeof mediaRequestSchema>;
export const audioProbeSchema = z
  .object({
    duration: z.number().finite().min(0.01).max(300),
    sampleRate: z.number().int().min(8000).max(192000),
    channels: z.union([z.literal(1), z.literal(2)]),
    decodedBytes: z
      .number()
      .int()
      .positive()
      .max(64 * 1024 * 1024),
    codec: z.string().max(100),
    format: z.string().max(300),
  })
  .strict();
export const binaryManifestSchema = z
  .object({
    workerVersion: z.literal(mediaWorkerVersion),
    files: z
      .object({
        worker: sha256Schema,
        ffmpeg: sha256Schema,
        ffprobe: sha256Schema,
        chromium: sha256Schema,
        font: sha256Schema,
      })
      .strict(),
    versions: z
      .object({
        node: z.string().max(100),
        ffmpeg: z.string().max(300),
        ffprobe: z.string().max(300),
        chromium: z.string().max(300),
      })
      .strict(),
  })
  .strict();
export const mediaResultSchema = z
  .object({
    protocolVersion: z.literal(1),
    id: z.string().uuid(),
    requestSha256: sha256Schema,
    worker: binaryManifestSchema,
    status: z.enum(['completed', 'error']),
    probe: audioProbeSchema.optional(),
    output: z
      .object({
        byteSize: z
          .number()
          .int()
          .positive()
          .max(100 * 1024 * 1024),
        sha256: sha256Schema,
      })
      .strict()
      .optional(),
    error: z
      .object({
        code: z.enum([
          'invalid-media',
          'resource-limit',
          'render-failed',
          'worker-integrity',
        ]),
        statusCode: z.union([z.literal(400), z.literal(413), z.literal(500)]),
      })
      .strict()
      .optional(),
  })
  .strict();
