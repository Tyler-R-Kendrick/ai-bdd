import { beforeAll, afterAll, afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store, HttpError } from '../server/store.ts';
import { openDatabase } from '../server/persistence/index.ts';
import { registerVideoRoutes } from '../server/video.ts';
import type { Auth } from '../server/auth.ts';
import type { User } from '../shared/domain.ts';
import type { ObjectStore, JobDispatcher } from '../server/hosting/ports.ts';
import { DiskObjectStore } from '../server/hosting/disk-objects.ts';
import { DurableJobCoordinator } from '../server/runtime/jobs.ts';
import type {
  RenderOptions,
  VideoRenderDriver,
} from '../server/video-renderer.ts';
import { newClip } from '../shared/video-timeline.ts';
const execute = promisify(execFile),
  origin = 'http://video.example.test';
const postgresURL =
  process.env.STUDIO_VIDEO_TEST_POSTGRES_URL ??
  process.env.STUDIO_TEST_POSTGRES_URL;
const cleanup: (() => Promise<unknown>)[] = [];
let encoded: Buffer, fixtureDir: string;
beforeAll(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), 'studio-video-worker-output-'));
  const file = join(fixtureDir, 'actual.mp4');
  await execute('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=white:s=320x180:d=1:r=24',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    file,
  ]);
  encoded = await readFile(file);
});
afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
class FixtureRenderer implements VideoRenderDriver {
  readonly name = 'explicit-worker-contract-fixture';
  readonly runtime = 'remote-worker' as const;
  calls: RenderOptions[] = [];
  beforeReturn?: (options: RenderOptions) => Promise<void>;
  async render(options: RenderOptions) {
    this.calls.push(options);
    await this.beforeReturn?.(options);
    await options.onProgress?.(0.5);
    return Buffer.from(encoded);
  }
}
async function context(
  options: {
    store?: Store;
    directory?: string;
    objects?: ObjectStore;
    renderer?: FixtureRenderer;
    instanceId?: string;
    schema?: string;
  } = {},
) {
  const directory =
    options.directory ??
    (await mkdtemp(join(tmpdir(), 'studio-video-durable-')));
  if (!options.directory)
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const schema =
    options.schema ?? 'video_' + crypto.randomUUID().replaceAll('-', '');
  const pgURL = postgresURL;
  const store =
    options.store ??
    (await Store.open(
      pgURL
        ? await openDatabase({ adapter: 'postgres', url: pgURL, schema })
        : join(directory, 'studio.sqlite'),
    ));
  if (!options.store) cleanup.push(() => store.close());
  const user =
    (await store.userByEmail('video-owner@example.test')) ??
    (await store.createUser('video-owner@example.test', 'Video owner', null));
  const actors = new Map<string, User>([[user.id, user]]);
  const dispatcher: JobDispatcher & { published: string[] } = {
    provider: 'explicit-delivery-fixture',
    published: [],
    async publish(id) {
      this.published.push(id);
      return {
        provider: this.provider,
        messageId: 'delivery-' + this.published.length,
      };
    },
  };
  const runtime = new DurableJobCoordinator({
    store,
    dispatcher,
    instanceId: options.instanceId ?? crypto.randomUUID(),
    leaseMs: 300,
  });
  await runtime.ready;
  cleanup.push(() => runtime.close());
  const objects =
    options.objects ?? new DiskObjectStore(join(directory, 'objects'));
  const renderer = options.renderer ?? new FixtureRenderer();
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) =>
    reply
      .code((error as HttpError).statusCode ?? 500)
      .send({ error: (error as Error).message }),
  );
  // Authentication transport is covered separately. This fixture supplies an actor;
  // every project role, source binding, lease, transaction, object and worker check is real.
  const auth = {
    user: async (request: { headers: Record<string, unknown> }) => {
      const actor = actors.get(String(request.headers['x-fixture-actor']));
      if (!actor) throw new HttpError(401, 'Fixture actor missing');
      return actor;
    },
    assertOrigin: async (request: { headers: Record<string, unknown> }) => {
      if (request.headers.origin !== origin)
        throw new HttpError(403, 'Origin is not allowed');
    },
  } as unknown as Auth;
  const service = await registerVideoRoutes(app, {
    store,
    runtime,
    objects,
    renderDriver: renderer,
    auth,
    settings: { production: false, origin, dataDir: directory, demo: false },
  });
  cleanup.push(() => app.close());
  const request = (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    payload?: unknown,
    actor = user,
  ) =>
    app.inject({
      method,
      url,
      headers: { origin, 'x-fixture-actor': actor.id },
      ...(payload === undefined ? {} : { payload: payload as any }),
    });
  return {
    directory,
    schema,
    store,
    runtime,
    dispatcher,
    objects,
    renderer,
    app,
    service,
    user,
    actors,
    request,
  };
}
async function fixture(c: Awaited<ReturnType<typeof context>>) {
  const project = (await c.store.createProject(
    c.user,
    'Durable video',
    'Video worker boundary',
  ))!;
  const artifact = await c.store.createArtifact(
    c.user,
    project.id,
    'video',
    'Queued video',
    {
      width: 320,
      height: 180,
      background: '#ffffff',
      duration: 1,
      fps: 24,
      clips: [
        {
          ...newClip('text', 1, 0),
          fontFamily: 'Georgia',
          x: 20,
          y: 40,
          width: 280,
          height: 80,
          fontSize: 24,
        },
      ],
    },
  );
  return { project, artifact };
}
async function enqueue(
  c: Awaited<ReturnType<typeof context>>,
  artifactId: string,
  key = crypto.randomUUID(),
) {
  const response = await c.request(
    'POST',
    `/api/artifacts/${artifactId}/video/render`,
    { version: 1, format: 'mp4', idempotencyKey: key },
  );
  expect(response.statusCode, response.body).toBe(202);
  return response.json();
}
describe(`durable video worker publication (${postgresURL ? 'PostgreSQL' : 'SQLite'})`, () => {
  it('commits an immutable snapshot before dispatch, enforces role/version, and publishes once across redelivery', async () => {
    const c = await context(),
      { project, artifact } = await fixture(c);
    const viewer = await c.store.createUser(
      'viewer@example.test',
      'Viewer',
      null,
    );
    c.actors.set(viewer.id, viewer);
    await c.store.exec(
      'INSERT INTO memberships VALUES(?,?,?)',
      project.id,
      viewer.id,
      'viewer',
    );
    expect(
      (
        await c.request(
          'POST',
          `/api/artifacts/${artifact.id}/video/render`,
          { version: 1, format: 'mp4' },
          viewer,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await c.request('POST', `/api/artifacts/${artifact.id}/video/render`, {
          version: 99,
          format: 'mp4',
        })
      ).statusCode,
    ).toBe(409);
    const key = crypto.randomUUID(),
      queued = await enqueue(c, artifact.id, key),
      duplicate = await enqueue(c, artifact.id, key);
    expect(duplicate.id).toBe(queued.id);
    expect(c.dispatcher.published).toEqual([queued.id]);
    const input = (await c.runtime.get(queued.id))!.snapshot as any;
    expect(input.content.clips[0].text).toBe('Build with intent.');
    await c.service.executeVideoJob(queued.id, {
      messageId: 'first',
      deliveryCount: 1,
    });
    await c.service.executeVideoJob(queued.id, {
      messageId: 'duplicate',
      deliveryCount: 2,
    });
    const result = await c.service.publicJob(queued.id, artifact.id);
    expect(result).toMatchObject({
      status: 'completed',
      artifactVersion: 1,
      progress: 1,
    });
    expect(c.renderer.calls).toHaveLength(1);
    const file = await c.store.file(result.fileId, c.user.id);
    expect(file.storageKey).toContain(queued.id);
    expect(file.bytes).toBeUndefined();
    const object = await c.objects.get(file.storageKey!, {
      maxBytes: file.byteSize,
      expectedSha256: file.sha256,
    });
    expect(Buffer.from(object!.bytes).equals(encoded)).toBe(true);
    expect(
      (await c.service.exportPage(artifact.id, 0, Number.MAX_SAFE_INTEGER))[0],
    ).toMatchObject({ status: 'completed', sourceSnapshot: input });
  });
  it('resumes a queued job after both the SQL connection and runtime are recreated', async () => {
    const c = await context(),
      { artifact } = await fixture(c),
      queued = await enqueue(c, artifact.id);
    const directory = c.directory,
      objects = c.objects;
    await c.app.close();
    await c.runtime.close();
    await c.store.close();
    const resumed = await context({ directory, objects, schema: c.schema });
    await resumed.service.executeVideoJob(queued.id, {
      messageId: 'after-process-restart',
      deliveryCount: 2,
    });
    expect(
      await resumed.service.publicJob(queued.id, artifact.id),
    ).toMatchObject({ status: 'completed', artifactVersion: 1 });
    expect(resumed.renderer.calls).toHaveLength(1);
  });
  it('fences a late upload after lease takeover and preserves the newer completed output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'studio-video-fence-'));
    cleanup.push(() => rm(directory, { force: true, recursive: true }));
    const disk = new DiskObjectStore(join(directory, 'objects')),
      entered = deferred(),
      release = deferred();
    const objects: ObjectStore = {
      provider: 'gated-real-disk',
      get: (...args) => disk.get(...args),
      delete: (...args) => disk.delete(...args),
      async put(key, bytes, options) {
        if (key.includes('attempt-1.')) {
          entered.resolve();
          await release.promise;
        }
        return disk.put(key, bytes, options);
      },
    };
    const first = await context({
        directory,
        objects,
        instanceId: 'old-worker',
      }),
      { artifact } = await fixture(first),
      queued = await enqueue(first, artifact.id);
    const old = first.service
      .executeVideoJob(queued.id, { messageId: 'old', deliveryCount: 1 })
      .catch(() => {});
    cleanup.push(async () => {
      release.resolve();
      await old;
    });
    await entered.promise;
    await first.store.exec(
      'UPDATE studio_durable_jobs SET lease_expires=0 WHERE id=?',
      queued.id,
    );
    const secondStore = postgresURL
      ? await Store.open(
          await openDatabase({
            adapter: 'postgres',
            url: postgresURL!,
            schema: first.schema,
          }),
        )
      : first.store;
    if (secondStore !== first.store) cleanup.push(() => secondStore.close());
    const second = await context({
      store: secondStore,
      directory,
      objects,
      schema: first.schema,
      instanceId: 'new-worker',
    });
    await second.service.executeVideoJob(queued.id, {
      messageId: 'takeover',
      deliveryCount: 2,
    });
    release.resolve();
    await old;
    const result = await second.service.publicJob(queued.id, artifact.id),
      file = await first.store.file(result.fileId, first.user.id);
    expect(result.status).toBe('completed');
    expect(file.storageKey).toContain('attempt-2.');
    expect(
      (
        await first.store.one(
          'SELECT count(*) AS n FROM files WHERE artifact_id=?',
          artifact.id,
        )
      ).n,
    ).toBe(1);
    const staged = await first.store.all(
      'SELECT object_key AS objectKey,state FROM studio_video_staging WHERE job_id=?',
      queued.id,
    );
    expect(
      staged.find((item) => item.objectKey.includes('attempt-1.'))?.state,
    ).toBe('deleted');
    expect(
      staged.find((item) => item.objectKey.includes('attempt-2.'))?.state,
    ).toBe('retained');
  });
  it('does not publish after cancellation, membership revocation, or a changed source version', async () => {
    for (const action of ['cancel', 'revoke', 'change'] as const) {
      const renderer = new FixtureRenderer(),
        entered = deferred(),
        release = deferred();
      renderer.beforeReturn = async () => {
        entered.resolve();
        await release.promise;
      };
      const c = await context({ renderer }),
        { artifact, project } = await fixture(c),
        queued = await enqueue(c, artifact.id);
      const work = c.service
        .executeVideoJob(queued.id, { messageId: action, deliveryCount: 1 })
        .catch(() => {});
      cleanup.push(async () => {
        release.resolve();
        await work;
      });
      await entered.promise;
      if (action === 'cancel') await c.runtime.cancel(queued.id, c.user);
      else if (action === 'revoke')
        await c.store.exec(
          'DELETE FROM memberships WHERE project_id=? AND user_id=?',
          project.id,
          c.user.id,
        );
      else
        await c.store.updateArtifact(c.user, artifact.id, artifact.version, {
          ...artifact.content,
          background: '#000000',
        });
      release.resolve();
      await work;
      expect((await c.runtime.get(queued.id))!.status).not.toBe('completed');
      expect(
        (
          await c.store.one(
            'SELECT count(*) AS n FROM files WHERE artifact_id=?',
            artifact.id,
          )
        ).n,
      ).toBe(0);
    }
  });
  it('serializes admission across overlapping requests instead of relying on request-local flags', async () => {
    const c = await context(),
      { artifact, project } = await fixture(c);
    const requests = await Promise.all(
      [crypto.randomUUID(), crypto.randomUUID()].map((idempotencyKey) =>
        c.request('POST', `/api/artifacts/${artifact.id}/video/render`, {
          version: 1,
          format: 'mp4',
          idempotencyKey,
        }),
      ),
    );
    expect(requests.map((response) => response.statusCode).sort()).toEqual([
      202, 409,
    ]);
    const actors = [];
    for (let index = 0; index < 4; index++) {
      const actor = await c.store.createUser(
        `admission-${index}@example.test`,
        `Editor ${index}`,
        null,
      );
      c.actors.set(actor.id, actor);
      actors.push(actor);
      await c.store.exec(
        'INSERT INTO memberships VALUES(?,?,?)',
        project.id,
        actor.id,
        'editor',
      );
    }
    const admitted = await Promise.all(
      actors.map((actor) =>
        c.request(
          'POST',
          `/api/artifacts/${artifact.id}/video/render`,
          { version: 1, format: 'mp4', idempotencyKey: crypto.randomUUID() },
          actor,
        ),
      ),
    );
    expect(admitted.map((response) => response.statusCode).sort()).toEqual([
      202, 202, 202, 429,
    ]);
    expect(
      (
        await c.store.one(
          "SELECT count(*) AS n FROM studio_durable_jobs WHERE kind='video.render' AND status IN ('queued','running')",
        )
      ).n,
    ).toBe(4);
  });
  it('checks external input integrity before invoking the renderer', async () => {
    const c = await context(),
      { artifact } = await fixture(c);
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+kH9sAAAAASUVORK5CYII=',
      'base64',
    );
    const key = 'sources/source.png',
      descriptor = await c.objects.put(key, bytes, {
        contentType: 'image/png',
      });
    const file = await c.store.registerFile(c.user, artifact.id, {
      name: 'source.png',
      mime: 'image/png',
      byteSize: bytes.length,
      sha256: descriptor.sha256,
      storageKey: key,
    });
    const content = {
      ...artifact.content,
      clips: [
        ...artifact.content.clips,
        { ...newClip('image', 1, 1), src: `/api/files/${file.id}` },
      ],
    };
    await c.store.updateArtifact(c.user, artifact.id, 1, content);
    const response = await c.request(
      'POST',
      `/api/artifacts/${artifact.id}/video/render`,
      { version: 2, format: 'mp4', idempotencyKey: crypto.randomUUID() },
    );
    expect(response.statusCode).toBe(202);
    const path = join(c.directory, 'objects', key),
      stored = await readFile(path);
    stored[stored.length - 1] ^= 1;
    await writeFile(path, stored);
    await c.service.executeVideoJob(response.json().id, {
      messageId: 'tampered-input',
      deliveryCount: 1,
    });
    expect(c.renderer.calls).toHaveLength(0);
    expect((await c.runtime.get(response.json().id))!.status).not.toBe(
      'completed',
    );
    expect(
      (
        await c.store.one(
          "SELECT count(*) AS n FROM files WHERE artifact_id=? AND mime='video/mp4'",
          artifact.id,
        )
      ).n,
    ).toBe(0);
  });
});
