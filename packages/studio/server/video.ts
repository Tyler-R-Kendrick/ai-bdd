import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store, HttpError, hash } from './store.ts';
import type { Auth, Settings } from './auth.ts';
import { normalizeVideo, type TimelineContent } from '../shared/video.ts';
import {
  cpuVideoRenderDriver,
  type VideoRenderDriver,
  type RenderAsset,
} from './video-renderer.ts';
import type {
  DurableJobContext,
  DurableJobRuntime,
  DurableJob,
  JobDelivery,
} from './runtime/contracts.ts';
import type { ObjectStore } from './hosting/ports.ts';
export type VideoRenderTask = {
  schemaVersion: 1;
  title: string;
  content: TimelineContent;
  format: 'mp4' | 'webm';
};
const snapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    title: z.string().min(1).max(180),
    content: z.unknown(),
    format: z.enum(['mp4', 'webm']),
  })
  .strict();
const outputSchema = z
  .object({
    fileId: z.string().uuid(),
    downloadUrl: z.string(),
    artifactVersion: z.number().int(),
    format: z.enum(['mp4', 'webm']),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byteSize: z.number().int().nonnegative(),
  })
  .strict();
const KIND = 'video.render';
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 100 * 1024 * 1024;
export type VideoServices = {
  store: Store;
  auth: Auth;
  settings: Settings;
  runtime: DurableJobRuntime;
  objects: ObjectStore;
  renderDriver?: VideoRenderDriver;
};
/** SQL owns snapshots, leases, cancellation, receipts, and results; queue messages contain only the durable job ID. */
export async function registerVideoRoutes(
  app: FastifyInstance,
  dependencies: VideoServices,
) {
  const { store, auth, runtime, objects } = dependencies;
  const renderer = dependencies.renderDriver ?? cpuVideoRenderDriver;
  await store.db
    .exec(`CREATE TABLE IF NOT EXISTS video_render_jobs(id TEXT PRIMARY KEY,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,artifact_version INTEGER NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),format TEXT NOT NULL,status TEXT NOT NULL,progress REAL NOT NULL DEFAULT 0,file_id TEXT REFERENCES files(id),error TEXT,created_at TEXT NOT NULL,finished_at TEXT);
    CREATE INDEX IF NOT EXISTS video_render_artifact ON video_render_jobs(artifact_id,created_at);
    CREATE TABLE IF NOT EXISTS studio_video_staging(object_key TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES studio_durable_jobs(id) ON DELETE CASCADE,fence INTEGER NOT NULL,sha256 TEXT NOT NULL,byte_size INTEGER NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,next_cleanup INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS studio_video_staging_due ON studio_video_staging(state,next_cleanup);`);
  function snapshot(job: DurableJob): VideoRenderTask {
    const value = snapshotSchema.parse(job.snapshot);
    return { ...value, content: normalizeVideo(value.content) };
  }
  async function publicJob(id: string, artifactId: string) {
    const row = await store.one(
      'SELECT id,artifact_version AS artifactVersion,format,status,progress,file_id AS fileId,error,created_at AS createdAt,finished_at AS finishedAt FROM video_render_jobs WHERE id=? AND artifact_id=?',
      id,
      artifactId,
    );
    if (!row) throw new HttpError(404, 'Video render not found');
    const job = await runtime.get(id);
    if (!job)
      return {
        ...row,
        status: ['queued', 'rendering'].includes(row.status)
          ? 'interrupted'
          : row.status,
        downloadUrl: row.fileId ? `/api/files/${row.fileId}` : null,
      };
    if (job.kind !== KIND || job.artifactId !== artifactId)
      throw new HttpError(404, 'Video render not found');
    const output =
      job.status === 'completed' ? outputSchema.parse(job.result) : undefined;
    return {
      ...row,
      status: job.status === 'running' ? 'rendering' : job.status,
      progress:
        job.status === 'completed' ? 1 : (job.progress?.percent ?? 0) / 100,
      error: job.error,
      fileId: output?.fileId ?? null,
      downloadUrl: output?.downloadUrl ?? null,
      finishedAt: ['completed', 'cancelled', 'failed'].includes(job.status)
        ? job.updatedAt
        : null,
    };
  }
  async function loadAssets(
    content: TimelineContent,
    projectId: string,
    userId: string,
  ) {
    await store.checkedContent('video', content, projectId);
    const result = new Map<string, RenderAsset>();
    let total = 0;
    for (const clip of content.clips) {
      for (const [url, expected] of [
        [clip.src, clip.type],
        [clip.fontUrl, 'font'],
      ] as const) {
        if (!url || result.has(url)) continue;
        if (result.size >= 64)
          throw new HttpError(413, 'This render exceeds its 64 asset budget.');
        const file = await store.file(url.split('/').pop()!, userId);
        if (
          file.projectId !== projectId ||
          !(expected === 'font'
            ? file.mime === 'font/woff2'
            : file.mime.startsWith(expected + '/'))
        )
          throw new HttpError(
            400,
            'A video asset is missing, has the wrong type, or belongs to another project.',
          );
        total += file.byteSize;
        if (file.byteSize > MAX_SOURCE_BYTES || total > MAX_SOURCE_BYTES)
          throw new HttpError(
            413,
            'This render exceeds its 128 MB source budget.',
          );
        const external = file.storageKey
          ? await objects.get(file.storageKey, {
              maxBytes: file.byteSize,
              expectedSha256: file.sha256,
            })
          : null;
        const bytes = file.storageKey
          ? external
            ? Buffer.from(external.bytes)
            : undefined
          : file.bytes;
        if (
          !bytes ||
          bytes.length !== file.byteSize ||
          hash(bytes) !== file.sha256
        )
          throw new HttpError(
            409,
            'A video source is unavailable or failed its integrity check.',
          );
        result.set(url, { bytes, mime: file.mime });
      }
    }
    return result;
  }
  async function deleteStaging(key: string) {
    const remove = await store.tx(async () => {
      await store.db.lock('video-stage:' + key);
      const row = await store.one(
        'SELECT state FROM studio_video_staging WHERE object_key=?',
        key,
      );
      if (!row || row.state === 'retained') return false;
      await store.exec(
        "UPDATE studio_video_staging SET state='delete-pending',next_cleanup=? WHERE object_key=?",
        Date.now(),
        key,
      );
      return true;
    });
    if (!remove) return;
    await objects.delete(key);
    await store.exec(
      "UPDATE studio_video_staging SET state='deleted',next_cleanup=? WHERE object_key=? AND state<>'retained'",
      Date.now() + 5 * 60 * 1000,
      key,
    );
  }
  async function cleanupStaged(limit = 20) {
    const bounded = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = await store.all(
      "SELECT s.object_key AS objectKey,s.created_at AS createdAt,s.state FROM studio_video_staging s JOIN studio_durable_jobs j ON j.id=s.job_id WHERE s.state<>'retained' AND s.next_cleanup<=? AND (s.fence<j.fence OR j.status IN ('failed','cancelled','completed') OR s.created_at<?) ORDER BY s.next_cleanup LIMIT ?",
      Date.now(),
      Date.now() - 30 * 60 * 1000,
      bounded,
    );
    let removed = 0;
    for (const row of rows) {
      try {
        await deleteStaging(row.objectKey);
        removed++;
        if (row.createdAt < Date.now() - 24 * 60 * 60 * 1000)
          await store.exec(
            "DELETE FROM studio_video_staging WHERE object_key=? AND state='deleted'",
            row.objectKey,
          );
      } catch {
        /* Durable cleanup intent remains for the next maintenance/worker delivery. */
      }
    }
    return { checked: rows.length, removed };
  }
  async function execute(context: DurableJobContext) {
    const task = snapshot(context.job);
    await context.assertCurrent({ requireCurrentVersion: true });
    await store.exec(
      "UPDATE video_render_jobs SET status='rendering',error=NULL WHERE id=?",
      context.job.id,
    );
    const assets = await loadAssets(
      task.content,
      context.job.projectId,
      context.job.principalId,
    );
    await context.assertCurrent({ requireCurrentVersion: true });
    const signal = AbortSignal.any([
      context.signal,
      AbortSignal.timeout(15 * 60 * 1000),
    ]);
    const bytes = await renderer.render({
      content: task.content,
      title: task.title,
      assets,
      format: task.format,
      signal,
      onProgress: async (progress) => {
        await context.assertCurrent({ requireCurrentVersion: true });
        await context.progress({
          percent: Math.max(0, Math.min(99, progress * 100)),
          label: 'Rendering video',
        });
      },
    });
    if (bytes.length < 100 || bytes.length > MAX_OUTPUT_BYTES)
      throw new HttpError(
        413,
        'Rendered output is empty or exceeds its 100 MB file limit.',
      );
    await context.assertCurrent({ requireCurrentVersion: true });
    const key = `projects/${context.job.projectId}/artifacts/${context.job.artifactId}/renders/${context.job.id}/attempt-${context.fence}.${task.format}`;
    const digest = hash(bytes),
      mime = `video/${task.format}`;
    await store.exec(
      "INSERT INTO studio_video_staging(object_key,job_id,fence,sha256,byte_size,state,created_at,next_cleanup) VALUES(?,?,?,?,?,'planned',?,?) ON CONFLICT(object_key) DO NOTHING",
      key,
      context.job.id,
      context.fence,
      digest,
      bytes.length,
      Date.now(),
      Date.now() + 30 * 60 * 1000,
    );
    let published = false;
    try {
      const object = await objects.put(key, bytes, { contentType: mime });
      if (
        object.key !== key ||
        object.sha256 !== digest ||
        object.byteSize !== bytes.length ||
        object.contentType !== mime
      )
        throw new Error(
          'The output object did not match its verified video descriptor.',
        );
      const result = await context.commit(
        'publish-output',
        async () => {
          await store.db.lock('video-stage:' + key);
          const staging = await store.one(
            'SELECT state FROM studio_video_staging WHERE object_key=?',
            key,
          );
          if (staging?.state !== 'planned')
            throw new HttpError(
              409,
              'This output attempt is no longer eligible for publication.',
            );
          const user = await store.publicUser(context.job.principalId);
          const file = await store.registerFile(user, context.job.artifactId, {
            id: context.job.id,
            name: `${task.title.slice(0, 160)}-v${context.job.artifactVersion}.${task.format}`,
            mime,
            sha256: digest,
            storageKey: key,
            byteSize: bytes.length,
          });
          await store.exec(
            "UPDATE studio_video_staging SET state='retained' WHERE object_key=?",
            key,
          );
          await store.exec(
            "UPDATE video_render_jobs SET status='completed',progress=1,file_id=?,finished_at=? WHERE id=?",
            file.id,
            new Date().toISOString(),
            context.job.id,
          );
          await store.audit(
            context.job.projectId,
            context.job.artifactId,
            user.name,
            'video.rendered',
            `revision ${context.job.artifactVersion}; ${task.format}; sha256 ${digest}`,
          );
          return {
            fileId: file.id,
            downloadUrl: `/api/files/${file.id}`,
            artifactVersion: context.job.artifactVersion,
            format: task.format,
            sha256: digest,
            byteSize: bytes.length,
          };
        },
        { requireCurrentVersion: true },
      );
      published = true;
      return result;
    } finally {
      if (!published) await deleteStaging(key).catch(() => {});
    }
  }
  runtime.register(KIND, execute);
  app.post<{ Params: { id: string } }>(
    '/api/artifacts/:id/video/render',
    async (request, reply) => {
      await auth.assertOrigin(request);
      const user = await auth.user(request),
        initial = await store.artifact(request.params.id, user.id, 'write');
      if (initial.kind !== 'video')
        throw new HttpError(400, 'Only video artifacts can be rendered');
      const input = z
        .object({
          version: z.number().int().positive(),
          format: z.enum(['mp4', 'webm']),
          idempotencyKey: z.string().uuid().optional(),
        })
        .strict()
        .parse(request.body);
      const key = `video:${initial.id}:${user.id}:${input.idempotencyKey ?? randomUUID()}`;
      const job = await store.tx(async () => {
        await store.db.lock('admission:video.render');
        await store.db.lock('project:' + initial.projectId);
        const artifact = await store.artifact(initial.id, user.id, 'write');
        if (artifact.version !== input.version)
          throw new HttpError(
            409,
            'Save the current artifact revision before rendering.',
          );
        const duplicate = await store.one(
          'SELECT id FROM studio_durable_jobs WHERE idempotency_key=?',
          key,
        );
        if (!duplicate) {
          const active = (
            await store.one(
              "SELECT count(*) AS n FROM studio_durable_jobs WHERE kind=? AND status IN ('queued','running')",
              KIND,
            )
          ).n;
          if (active >= 4)
            throw new HttpError(
              429,
              'The video render queue is full. Wait for a render or cancel it.',
            );
          if (
            await store.one(
              "SELECT id FROM studio_durable_jobs WHERE kind=? AND principal_id=? AND status IN ('queued','running')",
              KIND,
              user.id,
            )
          )
            throw new HttpError(
              409,
              'You already have a video render in progress.',
            );
        }
        const content = normalizeVideo(
          await store.checkedContent(
            'video',
            artifact.content,
            artifact.projectId,
          ),
        );
        const durable = await runtime.enqueue({
          kind: KIND,
          projectId: artifact.projectId,
          artifactId: artifact.id,
          principalId: user.id,
          artifactVersion: artifact.version,
          snapshot: {
            schemaVersion: 1,
            title: artifact.title,
            content,
            format: input.format,
          },
          idempotencyKey: key,
          maxAttempts: 3,
        });
        if (
          !(await store.one(
            'SELECT id FROM video_render_jobs WHERE id=?',
            durable.id,
          ))
        )
          await store.exec(
            "INSERT INTO video_render_jobs(id,artifact_id,artifact_version,user_id,format,status,created_at) VALUES(?,?,?,?,?,'queued',?)",
            durable.id,
            artifact.id,
            artifact.version,
            user.id,
            input.format,
            durable.createdAt,
          );
        return durable;
      });
      // The SQL snapshot/outbox is committed before external dispatch. Maintenance recovers a failed acknowledgment.
      await runtime.flushOutbox(4).catch(() => {});
      await store.artifact(initial.id, user.id);
      return reply.code(202).send(await publicJob(job.id, initial.id));
    },
  );
  app.get<{ Params: { id: string } }>(
    '/api/artifacts/:id/video/renders',
    async (request) => {
      const user = await auth.user(request);
      await store.artifact(request.params.id, user.id);
      const ids = await store.all(
        'SELECT id FROM video_render_jobs WHERE artifact_id=? ORDER BY created_at DESC LIMIT 20',
        request.params.id,
      );
      const jobs = await Promise.all(
        ids.map((row) => publicJob(row.id, request.params.id)),
      );
      await store.artifact(request.params.id, user.id);
      return jobs;
    },
  );
  app.get<{ Params: { id: string; job: string } }>(
    '/api/artifacts/:id/video/renders/:job',
    async (request) => {
      const user = await auth.user(request);
      await store.artifact(request.params.id, user.id);
      const job = await publicJob(request.params.job, request.params.id);
      await store.artifact(request.params.id, user.id);
      return job;
    },
  );
  app.delete<{ Params: { id: string; job: string } }>(
    '/api/artifacts/:id/video/renders/:job',
    async (request) => {
      await auth.assertOrigin(request);
      const user = await auth.user(request);
      await store.artifact(request.params.id, user.id, 'write');
      await publicJob(request.params.job, request.params.id);
      await runtime.cancel(request.params.job, user);
      return { ok: true };
    },
  );
  async function exportPage(
    artifactId: string,
    after: number,
    cutoff: number,
    limit = 25,
  ) {
    const rows = await store.all(
      'SELECT rowid AS sequence,id FROM video_render_jobs WHERE artifact_id=? AND rowid>? AND rowid<=? ORDER BY rowid LIMIT ?',
      artifactId,
      after,
      cutoff,
      Math.max(1, Math.min(25, limit)),
    );
    return Promise.all(
      rows.map(async (row) => {
        const durable = await runtime.get(row.id);
        return {
          sequence: row.sequence,
          ...(await publicJob(row.id, artifactId)),
          ...(durable ? { sourceSnapshot: durable.snapshot } : {}),
        };
      }),
    );
  }
  return {
    close: async () => {},
    cleanupStaged,
    exportPage,
    executeVideoJob: async (id: string, delivery: JobDelivery) => {
      const job = await runtime.get(id);
      if (!job || job.kind !== KIND)
        throw new HttpError(404, 'Video render not found');
      await runtime.executeJob(id, delivery);
    },
    publicJob,
  };
}
