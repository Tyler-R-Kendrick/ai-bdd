import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getPayloadFromClientToken } from '@vercel/blob/client';
import { Store } from '../server/store.ts';
import { openDatabase } from '../server/persistence/index.ts';
import { DiskObjectStore } from '../server/hosting/disk-objects.ts';
import { UploadAdmission } from '../server/hosting/uploads.ts';
const disposers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});
const token = 'vercel_blob_rw_fixture_test-only-key',
  png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]);
async function fixture(postgres = false) {
  const directory = await mkdtemp(join(tmpdir(), 'hosting-uploads-'));
  disposers.push(() => rm(directory, { recursive: true, force: true }));
  const schema = 'uploads_' + randomUUID().replaceAll('-', '');
  const db = await openDatabase(
    postgres
      ? {
          adapter: 'postgres',
          url: process.env.STUDIO_TEST_POSTGRES_URL!,
          schema,
        }
      : { adapter: 'sqlite', file: join(directory, 'test.db') },
  );
  const store = await Store.open(db);
  disposers.push(() => store.close());
  const user = await store.createUser(
      randomUUID() + '@example.test',
      'Owner',
      null,
    ),
    project = await store.createProject(user, 'Project', 'Uploads');
  const objects = new DiskObjectStore(join(directory, 'objects'));
  let clock = Date.now();
  const uploads = await new UploadAdmission(
    store,
    objects,
    token,
    () => clock,
  ).initialize();
  return {
    store,
    user,
    project,
    objects,
    uploads,
    expire: () => {
      clock += 12 * 60_000;
    },
    schema,
  };
}
describe('durable private upload admission', () => {
  it('signs only an exact immutable bounded path and completes idempotently after restarting admission', async () => {
    const f = await fixture(),
      grant = await f.uploads.grant(f.user, f.project.mainArtifactId, {
        name: 'photo.png',
        byteSize: png.length,
        contentType: 'image/png',
      });
    const payload = getPayloadFromClientToken(grant.token);
    expect(payload).toMatchObject({
      pathname: grant.pathname,
      maximumSizeInBytes: png.length,
      addRandomSuffix: false,
      allowOverwrite: false,
      validUntil: grant.expiresAt,
    });
    expect(JSON.stringify(f.uploads)).not.toContain(token);
    await f.objects.put(grant.pathname, png, { contentType: 'image/png' });
    const fresh = await new UploadAdmission(
      f.store,
      f.objects,
      token,
    ).initialize();
    const first = await fresh.complete(f.user, grant.id),
      again = await fresh.complete(f.user, grant.id);
    expect(again).toEqual(first);
    expect(first.mime).toBe('image/png');
    const file = await f.store.file(grant.id, f.user.id);
    expect(file.bytes).toBeUndefined();
    expect(file.storageKey).toBe(grant.pathname);
  });
  it('rechecks revocation after storage I/O and never registers invalid executable media', async () => {
    const f = await fixture(),
      editor = await f.store.createUser('editor@example.test', 'Editor', null);
    await f.store.exec(
      'INSERT INTO memberships(project_id,user_id,role) VALUES(?,?,?)',
      f.project.id,
      editor.id,
      'editor',
    );
    const grant = await f.uploads.grant(editor, f.project.mainArtifactId, {
      name: 'photo.png',
      byteSize: png.length,
      contentType: 'image/png',
    });
    await f.objects.put(grant.pathname, png, { contentType: 'image/png' });
    const revoking = {
      provider: f.objects.provider,
      put: f.objects.put.bind(f.objects),
      delete: f.objects.delete.bind(f.objects),
      get: async (...args: Parameters<DiskObjectStore['get']>) => {
        const value = await f.objects.get(...args);
        await f.store.exec(
          'DELETE FROM memberships WHERE project_id=? AND user_id=?',
          f.project.id,
          editor.id,
        );
        return value;
      },
    };
    await expect(
      new UploadAdmission(f.store, revoking, token).complete(editor, grant.id),
    ).rejects.toThrow();
    expect(
      await f.store.one('SELECT id FROM files WHERE id=?', grant.id),
    ).toBeUndefined();
    const bad = Buffer.from('<svg onload="alert(1)"/>'),
      b = await f.uploads.grant(f.user, f.project.mainArtifactId, {
        name: 'test.png',
        byteSize: bad.length,
        contentType: 'image/png',
      });
    await f.objects.put(b.pathname, bad, { contentType: 'image/png' });
    await expect(f.uploads.complete(f.user, b.id)).rejects.toThrow(
      'Choose a PNG',
    );
  });
  it('retains expired reservations through deletion failures and excludes complete assets from cleanup', async () => {
    const f = await fixture(),
      grant = await f.uploads.grant(f.user, f.project.mainArtifactId, {
        name: 'photo.png',
        byteSize: png.length,
        contentType: 'image/png',
      });
    await f.objects.put(grant.pathname, png, { contentType: 'image/png' });
    f.expire();
    const failing = {
      provider: f.objects.provider,
      put: f.objects.put.bind(f.objects),
      get: f.objects.get.bind(f.objects),
      delete: async () => {
        throw new Error('offline');
      },
    };
    await new UploadAdmission(
      f.store,
      failing,
      token,
      () => Date.now() + 12 * 60_000,
    ).cleanup();
    expect(
      (
        await f.store.one(
          'SELECT status FROM studio_uploads WHERE id=?',
          grant.id,
        )
      ).status,
    ).toBe('deleting');
    await f.store.exec(
      'UPDATE studio_uploads SET lease_until=0 WHERE id=?',
      grant.id,
    );
    await f.uploads.cleanup();
    expect(
      (
        await f.store.one(
          'SELECT status FROM studio_uploads WHERE id=?',
          grant.id,
        )
      ).status,
    ).toBe('deleted');
    expect(await f.objects.get(grant.pathname, { maxBytes: 100 })).toBeNull();
  });
  it.skipIf(!process.env.STUDIO_TEST_POSTGRES_URL)(
    'serializes quota reservations and finalization across independent PostgreSQL instances',
    async () => {
      const f = await fixture(true),
        db = await openDatabase({
          adapter: 'postgres',
          url: process.env.STUDIO_TEST_POSTGRES_URL!,
          schema: f.schema,
        }),
        second = await Store.open(db);
      disposers.push(() => second.close());
      const other = await new UploadAdmission(
        second,
        f.objects,
        token,
      ).initialize();
      for (let i = 0; i < 5; i++)
        await f.uploads.grant(f.user, f.project.mainArtifactId, {
          name: 'video.mp4',
          byteSize: 100 * 1024 * 1024,
          contentType: 'video/mp4',
        });
      const results = await Promise.allSettled([
        f.uploads.grant(f.user, f.project.mainArtifactId, {
          name: 'video.mp4',
          byteSize: 10 * 1024 * 1024,
          contentType: 'video/mp4',
        }),
        other.grant(f.user, f.project.mainArtifactId, {
          name: 'video.mp4',
          byteSize: 10 * 1024 * 1024,
          contentType: 'video/mp4',
        }),
      ]);
      expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((x) => x.status === 'rejected')).toHaveLength(1);
      await expect(
        second.registerFile(f.user, f.project.mainArtifactId, {
          name: 'render.mp4',
          mime: 'video/mp4',
          sha256: 'f'.repeat(64),
          storageKey: 'renders/unrelated',
          byteSize: 3 * 1024 * 1024,
        }),
      ).rejects.toThrow('512 MB');
      const grant = await other.grant(f.user, f.project.mainArtifactId, {
        name: 'photo.png',
        byteSize: png.length,
        contentType: 'image/png',
      });
      await f.objects.put(grant.pathname, png, { contentType: 'image/png' });
      const files = await Promise.all([
        f.uploads.complete(f.user, grant.id),
        other.complete(f.user, grant.id),
      ]);
      expect(files[0]).toEqual(files[1]);
      expect(
        Number(
          (
            await f.store.one(
              'SELECT count(*) AS n FROM files WHERE id=?',
              grant.id,
            )
          ).n,
        ),
      ).toBe(1);
    },
  );
});

it('runs the application compressed-media guard before registering a staged private upload', async () => {
  const f = await fixture(),
    bytes = Buffer.from('ID3compressed audio fixture');
  const grant = await f.uploads.grant(f.user, f.project.mainArtifactId, {
    name: 'clip.mp3',
    byteSize: bytes.length,
    contentType: 'audio/mpeg',
  });
  await f.objects.put(grant.pathname, bytes, {
    contentType: 'application/octet-stream',
  });
  let calls = 0;
  f.uploads.validateAsset = async (input) => {
    calls++;
    expect(input).toEqual({ bytes, mime: 'audio/mpeg', name: 'clip.mp3' });
    throw new Error('Decoded audio exceeds the admission budget');
  };
  await expect(f.uploads.complete(f.user, grant.id)).rejects.toThrow(
    'Decoded audio exceeds',
  );
  expect(
    await f.store.one('SELECT id FROM files WHERE id=?', grant.id),
  ).toBeUndefined();
  expect(
    (
      await f.store.one(
        'SELECT status FROM studio_uploads WHERE id=?',
        grant.id,
      )
    ).status,
  ).toBe('reserved');
  f.uploads.validateAsset = async () => {
    calls++;
  };
  expect((await f.uploads.complete(f.user, grant.id)).mime).toBe('audio/mpeg');
  expect(calls).toBe(2);
});
