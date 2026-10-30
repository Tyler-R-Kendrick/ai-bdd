import { afterEach, describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.ts';
import {
  openDatabase,
  postgresPoolConfig,
} from '../server/persistence/index.ts';
import { Pool } from 'pg';
import { hash } from '../server/store.ts';
import { implementationPointer } from '../shared/implementation.ts';
import {
  registerArtifactLifecycle,
  ArtifactLifecycle,
} from '../server/artifact-lifecycle.ts';
import { DiskObjectStore } from '../server/hosting/disk-objects.ts';
const pending: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of pending.splice(0).reverse()) await close();
});
const url = process.env.STUDIO_TEST_POSTGRES_URL,
  password = 'synthetic-archive-fixture-password';
async function fixture(postgres: boolean) {
  const directory = await mkdtemp(join(tmpdir(), 'studio-artifact-lifecycle-')),
    schema = 'lifecycle_' + randomUUID().replaceAll('-', ''),
    file = join(directory, 'store.sqlite');
  pending.push(() => rm(directory, { recursive: true, force: true }));
  const database = postgres
    ? await openDatabase({ adapter: 'postgres', url: url!, schema, max: 3 })
    : undefined;
  const studio = await createApp(
    {
      origin: 'http://127.0.0.1:8902',
      production: false,
      demo: false,
      dataDir: directory,
      adminEmail: 'archive-owner@example.test',
      adminPassword: password,
      integrations: {},
    },
    database ? { database } : { db: file },
  );
  pending.push(async () => {
    await studio.app.close();
    if (postgres) {
      const pool = new Pool(postgresPoolConfig({ url: url!, max: 1 }));
      try {
        await pool.query('DROP SCHEMA "' + schema + '" CASCADE');
      } finally {
        await pool.end();
      }
    }
  });
  const owner = await studio.store.userByEmail('archive-owner@example.test'),
    project = (await studio.store.createProject(
      owner,
      'Archive project',
      '',
      '',
    ))!,
    artifact = await studio.store.createArtifact(
      owner,
      project.id,
      'document',
      'Disposable draft',
    );
  const editor = await studio.store.createUser(
      'archive-editor@example.test',
      'Editor',
      null,
    ),
    viewer = await studio.store.createUser(
      'archive-viewer@example.test',
      'Viewer',
      null,
    );
  for (const [user, role] of [
    [editor, 'editor'],
    [viewer, 'viewer'],
  ] as const)
    await studio.store.exec(
      'INSERT INTO memberships(project_id,user_id,role) VALUES(?,?,?)',
      project.id,
      user.id,
      role,
    );
  const objects = new DiskObjectStore(join(directory, 'objects')),
    service = await registerArtifactLifecycle(studio.app, {
      store: studio.store,
      auth: studio.auth,
      objects,
      assertEditable: (a) => studio.graphs.assertPlanEditable(a.id),
    });
  const input = async () => {
    const state = (await service.inspect(owner, artifact.id)).artifact;
    return {
      version: state.version,
      archiveRevision: state.archiveRevision,
      confirmTitle: state.title,
    };
  };
  return {
    ...studio,
    service,
    objects,
    owner,
    project,
    artifact,
    editor,
    viewer,
    directory,
    schema,
    file,
    input,
  };
}
for (const postgres of [false, true])
  describe.skipIf(postgres && !url)(
    `artifact archive lifecycle (${postgres ? 'PostgreSQL' : 'SQLite'})`,
    () => {
      it('keeps a claimed implementation running through archive while refusing fresh claims and deletion', async () => {
        const c = await fixture(postgres),
          repo = 'https://github.com/example/archive-proof';
        await c.store.exec(
          'UPDATE projects SET repository=? WHERE id=?',
          repo,
          c.project.id,
        );
        const human = { user: c.owner, kind: 'human' as const },
          builder = {
            user: c.owner,
            kind: 'agent' as const,
            agentId: 'fixture/archive-builder',
          };
        const draft = await c.graphs.edit(human, c.artifact.id, {
            expected: null,
            planRevision: c.artifact.version,
            definition: {
              tasks: [
                {
                  id: 'page',
                  title: 'Page',
                  description: 'Implement page',
                  acceptanceCriteria: ['Page preserves accepted design'],
                },
              ],
              edges: [],
            },
          }),
          approved = await c.graphs.approve(
            human,
            c.artifact.id,
            implementationPointer(draft),
          ),
          request = {
            expected: implementationPointer(approved),
            repository: repo,
            branch: 'feature/archive',
            commit: 'a'.repeat(40),
          },
          run = await c.graphs.claim(builder, c.artifact.id, request);
        await c.service.archive(c.owner, c.artifact.id);
        await expect(
          c.graphs.report(builder, c.artifact.id, {
            runId: run.id,
            idempotencyKey: 'progress-after-archive',
            command: {
              kind: 'block_task',
              taskId: 'page',
              reason: 'Retained execution continues while archived',
            },
          }),
        ).resolves.toMatchObject({ status: 'running' });
        await expect(
          c.graphs.claim(builder, c.artifact.id, request),
        ).rejects.toThrow('archived');
        await expect(
          c.service.purge(c.owner, c.artifact.id, await c.input()),
        ).rejects.toMatchObject({
          statusCode: 409,
          blockers: expect.arrayContaining([
            expect.objectContaining({ kind: 'active-work' }),
          ]),
        });
        expect(
          (await c.service.inspect(c.owner, c.artifact.id)).restoreBlockers,
        ).toEqual([]);
        await c.service.restore(c.owner, c.artifact.id, await c.input());
        await expect(
          c.store.updateArtifact(
            c.owner,
            c.artifact.id,
            c.artifact.version,
            c.artifact.content,
          ),
        ).rejects.toMatchObject({ statusCode: 409 });
      });
      it('enforces authenticated origin and person-only deletion over the real HTTP routes', async () => {
        const c = await fixture(postgres),
          login = await c.app.inject({
            method: 'POST',
            url: '/api/auth/login',
            headers: { origin: 'http://127.0.0.1:8902' },
            payload: { email: c.owner.email, password },
          }),
          cookie = login.cookies[0]!.name + '=' + login.cookies[0]!.value;
        expect(login.statusCode).toBe(200);
        await c.service.archive(c.owner, c.artifact.id);
        const listing = await c.app.inject({
          url: `/api/projects/${c.project.id}/archive`,
          headers: { cookie },
        });
        expect(listing.statusCode).toBe(200);
        expect(listing.json().items[0].id).toBe(c.artifact.id);
        const endpoint = `/api/artifacts/${c.artifact.id}`,
          payload = await c.input();
        expect(
          (
            await c.app.inject({
              method: 'DELETE',
              url: endpoint,
              headers: { cookie, origin: 'https://untrusted.example' },
              payload,
            })
          ).statusCode,
        ).toBe(403);
        expect(
          (
            await c.app.inject({
              method: 'DELETE',
              url: endpoint,
              headers: {
                cookie,
                origin: 'http://127.0.0.1:8902',
                authorization: 'Bearer not-a-person',
              },
              payload,
            })
          ).statusCode,
        ).toBe(403);
        const result = await c.app.inject({
          method: 'DELETE',
          url: endpoint,
          headers: { cookie, origin: 'http://127.0.0.1:8902' },
          payload,
        });
        expect(result.statusCode, result.body).toBe(200);
        expect(result.json()).toMatchObject({ deleted: true });
      });
      it('retains future cross-artifact workflow JSON references and live assistant questions', async () => {
        const c = await fixture(postgres),
          other = await c.store.createArtifact(
            c.owner,
            c.project.id,
            'document',
            'Future owner',
          );
        await c.store.db.exec(
          'CREATE TABLE studio_future_receipts(id TEXT PRIMARY KEY,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,evidence_json TEXT NOT NULL)',
        );
        await c.store.exec(
          'INSERT INTO studio_future_receipts(id,artifact_id,evidence_json) VALUES(?,?,?)',
          randomUUID(),
          other.id,
          JSON.stringify({ sourceArtifact: c.artifact.id }),
        );
        c.service.options.hasActivity = async () => true;
        await expect(
          c.service.archive(c.owner, c.artifact.id),
        ).rejects.toMatchObject({ statusCode: 409 });
        c.service.options.hasActivity = async () => false;
        await c.service.archive(c.owner, c.artifact.id);
        await expect(
          c.service.purge(c.owner, c.artifact.id, await c.input()),
        ).rejects.toMatchObject({
          statusCode: 409,
          blockers: expect.arrayContaining([
            expect.objectContaining({
              kind: 'source-reference',
              artifactId: other.id,
            }),
          ]),
        });
      });
      it('archives without losing context, restores with CAS, and enforces owner/main constraints', async () => {
        const c = await fixture(postgres),
          thread = (await c.store.threads(c.artifact.id))[0]!;
        await c.store.message(
          c.owner,
          c.artifact.id,
          thread.id,
          'Retained artifact discussion',
        );
        await expect(
          c.service.archive(c.editor, c.artifact.id),
        ).rejects.toMatchObject({ statusCode: 403 });
        await expect(
          c.service.archive(c.owner, c.project.mainArtifactId),
        ).rejects.toMatchObject({ statusCode: 409 });
        await c.service.archive(c.owner, c.artifact.id, c.artifact.version);
        expect(
          (await c.store.artifacts(c.project.id, c.owner.id)).some(
            (a) => a.id === c.artifact.id,
          ),
        ).toBe(false);
        expect(
          (await c.service.list(c.viewer, c.project.id)).items,
        ).toMatchObject([{ id: c.artifact.id, archived: true }]);
        expect((await c.store.messages(c.artifact.id))[0].body).toBe(
          'Retained artifact discussion',
        );
        expect(await c.store.decisions(c.artifact.id)).toHaveLength(1);
        const state = await c.input();
        await expect(
          c.store.updateArtifact(
            c.owner,
            c.artifact.id,
            state.version,
            c.artifact.content,
          ),
        ).rejects.toMatchObject({ statusCode: 409 });
        await expect(
          c.service.restore(c.viewer, c.artifact.id, state),
        ).rejects.toMatchObject({ statusCode: 403 });
        await c.service.restore(c.owner, c.artifact.id, state);
        expect(
          (await c.store.artifact(c.artifact.id, c.owner.id)).archived,
        ).toBe(false);
        await c.service.archive(c.owner, c.artifact.id);
        await expect(
          c.service.restore(c.owner, c.artifact.id, state),
        ).rejects.toMatchObject({ statusCode: 409 });
      });
      it('permanently removes only a confirmed archived draft and cascades own chats ADRs revisions and inline files', async () => {
        const c = await fixture(postgres),
          thread = (await c.store.threads(c.artifact.id))[0]!;
        await c.store.message(
          c.owner,
          c.artifact.id,
          thread.id,
          'Delete this owned chat only',
        );
        const bytes = Buffer.from('owned inline bytes');
        await c.store.registerFile(c.owner, c.artifact.id, {
          name: 'owned.txt',
          mime: 'text/plain',
          sha256: hash(bytes),
          bytes,
          byteSize: bytes.length,
        });
        await expect(
          c.service.purge(c.owner, c.artifact.id, {
            version: c.artifact.version,
            archiveRevision: 0,
            confirmTitle: c.artifact.title,
          }),
        ).rejects.toMatchObject({ statusCode: 409 });
        await c.service.archive(c.owner, c.artifact.id);
        const input = await c.input();
        await expect(
          c.service.purge(c.owner, c.artifact.id, {
            ...input,
            confirmTitle: 'wrong',
          }),
        ).rejects.toMatchObject({ statusCode: 409 });
        await expect(
          c.service.purge(c.editor, c.artifact.id, input),
        ).rejects.toMatchObject({ statusCode: 403 });
        const deleted = await c.service.purge(c.owner, c.artifact.id, input);
        expect(deleted).toMatchObject({
          deleted: true,
          alreadyDeleted: false,
          cleanupPending: false,
        });
        await expect(
          c.store.artifact(c.artifact.id, c.owner.id),
        ).rejects.toMatchObject({ statusCode: 404 });
        for (const table of [
          'messages',
          'threads',
          'decisions',
          'revisions',
          'files',
        ])
          expect(
            Number(
              (
                await c.store.one(
                  `SELECT COUNT(*) AS n FROM ${table} WHERE artifact_id=?`,
                  c.artifact.id,
                )
              ).n,
            ),
          ).toBe(0);
        expect(
          await c.store.one(
            "SELECT id FROM audit WHERE project_id=? AND artifact_id IS NULL AND action='artifact.permanently-deleted'",
            c.project.id,
          ),
        ).toBeTruthy();
        expect(
          await c.service.purge(c.owner, c.artifact.id, input),
        ).toMatchObject({
          deleted: true,
          alreadyDeleted: true,
          receiptId: deleted.receiptId,
        });
        expect(
          (await c.store.artifact(c.project.mainArtifactId, c.owner.id))
            .archived,
        ).toBe(false);
      });
      it('preserves references, unknown future foreign-key records, and retained acceptance evidence', async () => {
        const c = await fixture(postgres);
        await c.store.createArtifact(
          c.owner,
          c.project.id,
          'document',
          'Reference holder',
          {
            doc: {
              type: 'doc',
              content: [
                {
                  type: 'artifactReferenceBlock',
                  attrs: {
                    data: {
                      title: 'Retained reference',
                      artifactId: c.artifact.id,
                      description: 'Keep this source linked',
                    },
                  },
                },
              ],
            },
          },
        );
        await c.service.archive(c.owner, c.artifact.id);
        await expect(
          c.service.purge(c.owner, c.artifact.id, await c.input()),
        ).rejects.toMatchObject({
          statusCode: 409,
          blockers: expect.arrayContaining([
            expect.objectContaining({ kind: 'source-reference' }),
          ]),
        });
        const future = await c.store.createArtifact(
          c.owner,
          c.project.id,
          'document',
          'Future workflow',
        );
        await c.store.db.exec(
          'CREATE TABLE studio_fixture_dependencies(id TEXT PRIMARY KEY,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE)',
        );
        await c.store.exec(
          'INSERT INTO studio_fixture_dependencies(id,artifact_id) VALUES(?,?)',
          randomUUID(),
          future.id,
        );
        await c.service.archive(c.owner, future.id);
        let state = (await c.service.inspect(c.owner, future.id)).artifact;
        await expect(
          c.service.purge(c.owner, future.id, {
            version: state.version,
            archiveRevision: state.archiveRevision,
            confirmTitle: state.title,
          }),
        ).rejects.toMatchObject({
          statusCode: 409,
          blockers: expect.arrayContaining([
            expect.objectContaining({ kind: 'retained-records' }),
          ]),
        });
        const tested = await c.store.createArtifact(
          c.owner,
          c.project.id,
          'code',
          'Retained test target',
        );
        await c.store.exec(
          'INSERT INTO runs(id,artifact_id,artifact_version,status,created_at) VALUES(?,?,?,?,?)',
          randomUUID(),
          tested.id,
          tested.version,
          'failed',
          new Date().toISOString(),
        );
        await c.service.archive(c.owner, tested.id);
        state = (await c.service.inspect(c.owner, tested.id)).artifact;
        await expect(
          c.service.purge(c.owner, tested.id, {
            version: state.version,
            archiveRevision: state.archiveRevision,
            confirmTitle: state.title,
          }),
        ).rejects.toMatchObject({
          statusCode: 409,
          blockers: expect.arrayContaining([
            expect.objectContaining({ kind: 'published-evidence' }),
          ]),
        });
      });
      it('blocks active work, then safely cancels and rejects stale durable deliveries after permanent deletion', async () => {
        const c = await fixture(postgres);
        let executed = 0;
        c.runtime.register('fixture.archive', async () => {
          executed++;
          return {};
        });
        const job = await c.runtime.enqueue({
          kind: 'fixture.archive',
          projectId: c.project.id,
          artifactId: c.artifact.id,
          principalId: c.owner.id,
          artifactVersion: c.artifact.version,
          snapshot: {},
          idempotencyKey: 'archive-active',
          maxAttempts: 1,
        });
        await expect(
          c.service.archive(c.owner, c.artifact.id),
        ).rejects.toMatchObject({
          statusCode: 409,
          blockers: expect.arrayContaining([
            expect.objectContaining({ kind: 'active-work' }),
          ]),
        });
        await c.runtime.cancel(job.id, c.owner);
        await c.service.archive(c.owner, c.artifact.id);
        await c.service.purge(c.owner, c.artifact.id, await c.input());
        await c.runtime.executeJob(job.id, {
          messageId: 'stale-delivery',
          deliveryCount: 2,
        });
        expect(executed).toBe(0);
      });
      it('queues retryable private-object deletion and prevents key resurrection across service instances', async () => {
        const c = await fixture(postgres),
          bytes = Buffer.from('private asset bytes'),
          key = 'files/' + randomUUID();
        await c.objects.put(key, bytes, { contentType: 'text/plain' });
        await c.store.registerFile(c.owner, c.artifact.id, {
          name: 'private.txt',
          mime: 'text/plain',
          sha256: hash(bytes),
          storageKey: key,
          byteSize: bytes.length,
        });
        await c.service.archive(c.owner, c.artifact.id);
        const purged = await c.service.purge(
          c.owner,
          c.artifact.id,
          await c.input(),
        );
        expect(purged).toMatchObject({ cleanupPending: true });
        const other = await c.store.createArtifact(
          c.owner,
          c.project.id,
          'document',
          'Other draft',
        );
        const deny = () =>
          c.store.registerFile(c.owner, other.id, {
            name: 'resurrection.txt',
            mime: 'text/plain',
            sha256: hash(bytes),
            storageKey: key,
            byteSize: bytes.length,
          });
        await expect(deny()).rejects.toMatchObject({ statusCode: 409 });
        let failed = false;
        const original = c.service.options.objects.delete.bind(
          c.service.options.objects,
        );
        c.service.options.objects.delete = async (objectKey) => {
          if (!failed) {
            failed = true;
            throw new Error('Synthetic provider outage');
          }
          return original(objectKey);
        };
        await c.service.cleanup();
        expect(await c.objects.get(key, { maxBytes: 100 })).toBeTruthy();
        await c.store.exec(
          'UPDATE studio_artifact_object_cleanup SET next_attempt=0',
        );
        const resumed = new ArtifactLifecycle({
          store: c.store,
          auth: c.auth,
          objects: c.objects,
        });
        await resumed.ready;
        await resumed.cleanup();
        expect(await c.objects.get(key, { maxBytes: 100 })).toBeNull();
        await expect(deny()).rejects.toMatchObject({ statusCode: 409 });
        expect(
          await c.store.one(
            "SELECT storage_key FROM studio_artifact_object_cleanup WHERE state='deleted'",
          ),
        ).toMatchObject({ storage_key: null });
      });
      it('retains physically shared objects and waits out unexpired private upload capabilities', async () => {
        const c = await fixture(postgres),
          bytes = Buffer.from('shared bytes'),
          key = 'files/' + randomUUID(),
          other = await c.store.createArtifact(
            c.owner,
            c.project.id,
            'document',
            'Shared owner',
          );
        await c.objects.put(key, bytes, { contentType: 'text/plain' });
        for (const artifact of [c.artifact, other])
          await c.store.registerFile(c.owner, artifact.id, {
            name: 'shared.txt',
            mime: 'text/plain',
            sha256: hash(bytes),
            storageKey: key,
            byteSize: bytes.length,
          });
        await c.service.archive(c.owner, c.artifact.id);
        await c.service.purge(c.owner, c.artifact.id, await c.input());
        await c.service.cleanup();
        expect(await c.objects.get(key, { maxBytes: 100 })).toBeTruthy();
        const upload = await c.store.createArtifact(
          c.owner,
          c.project.id,
          'document',
          'Pending upload',
        );
        await c.store.db.exec(
          'CREATE TABLE IF NOT EXISTS studio_uploads(id TEXT PRIMARY KEY,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,storage_key TEXT NOT NULL,expires_at BIGINT NOT NULL)',
        );
        await c.store.exec(
          'INSERT INTO studio_uploads(id,artifact_id,storage_key,expires_at) VALUES(?,?,?,?)',
          randomUUID(),
          upload.id,
          'incoming/' + randomUUID(),
          Date.now() + 60000,
        );
        await c.service.archive(c.owner, upload.id);
        const state = (await c.service.inspect(c.owner, upload.id)).artifact;
        await expect(
          c.service.purge(c.owner, upload.id, {
            version: state.version,
            archiveRevision: state.archiveRevision,
            confirmTitle: state.title,
          }),
        ).rejects.toMatchObject({
          statusCode: 409,
          blockers: expect.arrayContaining([
            expect.objectContaining({ kind: 'pending-upload' }),
          ]),
        });
      });
    },
  );
