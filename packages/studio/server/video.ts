import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store, HttpError, hash } from './store.ts';
import type { Auth, Settings } from './auth.ts';
import { normalizeVideo, type TimelineContent } from '../shared/video.ts';
import { renderVideo, type RenderAsset } from './video-renderer.ts';
type Job = { id: string; artifactId: string; artifactVersion: number; userId: string; format: 'mp4' | 'webm'; content: TimelineContent; title: string };
export function registerVideoRoutes(app: FastifyInstance, dependencies: { store: Store; auth: Auth; settings: Settings }) {
  const { store, auth } = dependencies;
  store.db.exec(`CREATE TABLE IF NOT EXISTS video_render_jobs(id TEXT PRIMARY KEY,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,artifact_version INTEGER NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),format TEXT NOT NULL,status TEXT NOT NULL,progress REAL NOT NULL DEFAULT 0,file_id TEXT REFERENCES files(id),error TEXT,created_at TEXT NOT NULL,finished_at TEXT);
    CREATE INDEX IF NOT EXISTS video_render_artifact ON video_render_jobs(artifact_id,created_at);
    UPDATE video_render_jobs SET status='interrupted',error='Server restarted during rendering',finished_at=datetime('now') WHERE status IN ('queued','rendering');`);
  const queue: Job[] = [];
  const controllers = new Map<string, AbortController>();
  const pending = new Set<Promise<void>>();
  let stopped = false;
  function publicJob(id: string, artifactId: string) {
    const row = store.one('SELECT id,artifact_version AS artifactVersion,format,status,progress,file_id AS fileId,error,created_at AS createdAt,finished_at AS finishedAt FROM video_render_jobs WHERE id=? AND artifact_id=?', id, artifactId);
    if (!row) throw new HttpError(404, 'Video render not found');
    return { ...row, downloadUrl: row.fileId ? `/api/files/${row.fileId}` : null };
  }
  function assets(content: TimelineContent, projectId: string) {
    const result = new Map<string, RenderAsset>();
    for (const clip of content.clips) {
      for (const [url, expected] of [[clip.src, clip.type], [clip.fontUrl, 'font']] as const) {
        if (!url || result.has(url)) continue;
        const file = store.one('SELECT mime,bytes FROM files WHERE id=? AND project_id=?', url.split('/').pop(), projectId);
        if (!file || !(expected === 'font' ? file.mime === 'font/woff2' : file.mime.startsWith(expected + '/')))
          throw new HttpError(400, 'A video asset is missing, has the wrong media type, or belongs to another project');
        result.set(url, { bytes: Buffer.from(file.bytes), mime: file.mime });
      }
    }
    return result;
  }
  async function execute(job: Job, controller: AbortController) {
    const timeout = setTimeout(() => controller.abort(new Error('Video render exceeded its 15 minute limit')), 15 * 60 * 1000);
    try {
      const artifact = store.artifact(job.artifactId, job.userId, 'write');
      if (artifact.version !== job.artifactVersion) throw new HttpError(409, 'Artifact changed before rendering. Save and render the current revision.');
      store.exec("UPDATE video_render_jobs SET status='rendering' WHERE id=?", job.id);
      const bytes = await renderVideo({ content: job.content, title: job.title, assets: assets(job.content, artifact.projectId), format: job.format, signal: controller.signal,
        onProgress: (progress) => store.exec('UPDATE video_render_jobs SET progress=? WHERE id=?', progress, job.id) });
      controller.signal.throwIfAborted();
      const current = store.artifact(job.artifactId, job.userId, 'write');
      if (current.version !== job.artifactVersion) throw new HttpError(409, 'Artifact changed during rendering. Save and render the current revision.');
      const used = store.one('SELECT coalesce(sum(length(bytes)),0) AS n FROM files WHERE project_id=?', current.projectId).n;
      if (used + bytes.length > 512 * 1024 * 1024) throw new HttpError(413, 'The rendered video would exceed this project’s 512 MB asset quota.');
      const fileId = randomUUID(), now = new Date().toISOString();
      store.tx(() => {
        store.exec('INSERT INTO files VALUES(?,?,?,?,?,?,?,?)', fileId, current.projectId, current.id, `${current.title.slice(0, 160)}-v${job.artifactVersion}.${job.format}`, `video/${job.format}`, hash(bytes), bytes, now);
        store.exec("UPDATE video_render_jobs SET status='completed',progress=1,file_id=?,finished_at=? WHERE id=?", fileId, now, job.id);
        store.audit(current.projectId, current.id, store.publicUser(job.userId).name, 'video.rendered', `revision ${job.artifactVersion}; ${job.format}; sha256 ${hash(bytes)}`);
      });
    } catch (error) {
      store.exec('UPDATE video_render_jobs SET status=?,error=?,finished_at=? WHERE id=?', controller.signal.aborted ? 'cancelled' : 'failed', controller.signal.aborted ? 'Render cancelled or exceeded its time limit.' : (error as Error).message.slice(0, 2000), new Date().toISOString(), job.id);
    } finally {
      clearTimeout(timeout); controllers.delete(job.id);
    }
  }
  function drain() {
    if (stopped || controllers.size >= 1) return;
    let job: Job | undefined;
    while ((job = queue.shift())) {
      if (store.one('SELECT status FROM video_render_jobs WHERE id=?', job.id)?.status !== 'queued') continue;
      const controller = new AbortController(); controllers.set(job.id, controller);
      const promise = execute(job, controller).finally(() => { pending.delete(promise); drain(); });
      pending.add(promise); break;
    }
  }
  app.post<{ Params: { id: string } }>('/api/artifacts/:id/video/render', async (request, reply) => {
    auth.assertOrigin(request);
    const user = auth.user(request), artifact = store.artifact(request.params.id, user.id, 'write');
    if (artifact.kind !== 'video') throw new HttpError(400, 'Only video artifacts can be rendered');
    const { version, format } = z.object({ version: z.number().int().positive(), format: z.enum(['mp4', 'webm']) }).strict().parse(request.body);
    if (version !== artifact.version) throw new HttpError(409, 'Save the latest artifact revision before rendering.');
    if (stopped || queue.length + controllers.size >= 4) throw new HttpError(429, 'The video render queue is full. Wait for an existing render or cancel it.');
    if (store.one("SELECT id FROM video_render_jobs WHERE user_id=? AND status IN ('queued','rendering')", user.id)) throw new HttpError(409, 'You already have a video render in progress.');
    const content = normalizeVideo(artifact.content);
    assets(content, artifact.projectId);
    const job: Job = { id: randomUUID(), artifactId: artifact.id, artifactVersion: artifact.version, userId: user.id, title: artifact.title, content, format };
    store.exec("INSERT INTO video_render_jobs(id,artifact_id,artifact_version,user_id,format,status,created_at) VALUES(?,?,?,?,?,'queued',?)", job.id, artifact.id, artifact.version, user.id, format, new Date().toISOString());
    queue.push(job); drain();
    return reply.code(202).send(publicJob(job.id, artifact.id));
  });
  app.get<{ Params: { id: string } }>('/api/artifacts/:id/video/renders', async (request) => {
    const user = auth.user(request); store.artifact(request.params.id, user.id);
    return store.all('SELECT id FROM video_render_jobs WHERE artifact_id=? ORDER BY created_at DESC LIMIT 20', request.params.id).map((job) => publicJob(job.id, request.params.id));
  });
  app.get<{ Params: { id: string; job: string } }>('/api/artifacts/:id/video/renders/:job', async (request) => {
    const user = auth.user(request); store.artifact(request.params.id, user.id);
    return publicJob(request.params.job, request.params.id);
  });
  app.delete<{ Params: { id: string; job: string } }>('/api/artifacts/:id/video/renders/:job', async (request) => {
    auth.assertOrigin(request);
    const user = auth.user(request); store.artifact(request.params.id, user.id, 'write');
    const job = publicJob(request.params.job, request.params.id);
    if (job.status === 'queued' || job.status === 'rendering') {
      controllers.get(job.id)?.abort();
      store.exec("UPDATE video_render_jobs SET status='cancelled',error='Render cancelled.',finished_at=? WHERE id=?", new Date().toISOString(), job.id);
    }
    return { ok: true };
  });
  return { async close() { stopped = true; for (const controller of controllers.values()) controller.abort(); for (const job of queue) store.exec("UPDATE video_render_jobs SET status='interrupted',error='Server stopped before rendering',finished_at=? WHERE id=?", new Date().toISOString(), job.id); queue.length = 0; await Promise.allSettled([...pending]); } };
}
