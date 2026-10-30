import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Store } from '../server/store.ts';
import { openDatabase } from '../server/persistence/index.ts';
import { DiskObjectStore } from '../server/hosting/disk-objects.ts';
import { NativeT3StateLease, encryptNativeState, decryptNativeState, packNativeState, unpackNativeState, cleanupManagedT3Checkpoints } from '../server/local/native-t3-state.ts';
const closes: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
async function fixture(postgres = false) {
  const root = await mkdtemp('/tmp/studio-native-state-test-'); closes.push(() => rm(root, { recursive: true, force: true }));
  const schema = 'native_t3_' + randomUUID().replaceAll('-', '');
  const store = await Store.open(postgres ? await openDatabase({ adapter: 'postgres', url: process.env.STUDIO_TEST_POSTGRES_URL!, schema }) : ':memory:'); closes.push(() => store.close());
  const peer = postgres ? await Store.open(await openDatabase({ adapter: 'postgres', url: process.env.STUDIO_TEST_POSTGRES_URL!, schema })) : undefined;
  if (peer) closes.push(() => peer.close());
  if (postgres) closes.push(() => store.db.exec('DROP SCHEMA "' + schema + '" CASCADE'));
  const user = await store.createUser('native-state@example.invalid', 'State owner', null);
  const project = await store.createProject(user, 'Native checkpoint', '');
  const artifact = await store.createArtifact(user, project.id, 'document', 'Temporary draft');
  const objects = new DiskObjectStore(join(root, 'objects'));
  const key = randomBytes(32), id = 'a'.repeat(64);
  const options = { store, objects, key, id, artifactId: artifact.id };
  const state = join(root, 'state'); await mkdir(join(state, 'native/userdata'), { recursive: true });
  await writeFile(join(state, 'session.json'), 'fresh-program-owned-session');
  await writeFile(join(state, 'native/userdata/statev2.sqlite'), 'native-owned-database');
  return { root, state, store, peer, objects, key, id, options, artifact };
}
if (process.env.STUDIO_REQUIRE_NATIVE_T3_POSTGRES === '1' && !process.env.STUDIO_TEST_POSTGRES_URL) throw new Error('Native T3 PostgreSQL acceptance requires STUDIO_TEST_POSTGRES_URL');
describe.each(['sqlite', ...(process.env.STUDIO_TEST_POSTGRES_URL ? ['postgres'] : [])])('native encrypted state and scope fencing on %s', provider => {
  const workspace = () => fixture(provider === 'postgres');
  it('authenticates checkpoint bytes, encryption key and exact stable native state identity', () => {
    const key = randomBytes(32), id = 'a'.repeat(64), plain = Buffer.from('private fresh native token');
    const value = encryptNativeState(plain, key, id);
    expect(value.includes(plain)).toBe(false);
    expect(decryptNativeState(value, key, id)).toEqual(plain);
    const corrupt = Buffer.from(value); corrupt[corrupt.length - 1] ^= 1;
    for (const check of [() => decryptNativeState(corrupt, key, id), () => decryptNativeState(value, randomBytes(32), id), () => decryptNativeState(value, key, 'b'.repeat(64))]) expect(check).toThrow('invalid');
  });
  it('archives bounded owned state and rejects symlinks, traversal and duplicate destinations', async () => {
    const f = await workspace(), packed = await packNativeState(f.state);
    expect(packed.inventory.databases).toEqual([{ path: 'native/userdata/statev2.sqlite', bytes: 21 }]);
    const restored = join(f.root, 'restored'); await unpackNativeState(packed.archive, restored);
    expect(await readFile(join(restored, 'session.json'), 'utf8')).toBe('fresh-program-owned-session');
    for (const files of [ [{ path: 'native/userdata/../../escape', bytes: 'eA==' }], [{ path: 'session.json', bytes: 'eA==' }, { path: 'session.json', bytes: 'eA==' }] ]) await expect(unpackNativeState(gzipSync(JSON.stringify({ version: 1, files })), join(f.root, 'bad-' + files.length))).rejects.toThrow('invalid');
    await symlink(join(f.state, 'session.json'), join(f.state, 'native/userdata/link'));
    await expect(packNativeState(f.state)).rejects.toThrow('invalid');
  });
  it('excludes the known OpenCode diagnostic log directory while retaining native SQLite and WAL files', async () => {
    const f = await workspace();
    await mkdir(join(f.state, 'data/opencode/log'), { recursive: true });
    await writeFile(join(f.state, 'data/opencode/log/private.log'), 'unnecessary private diagnostic text');
    await writeFile(join(f.state, 'data/opencode/opencode.db'), 'owned-opencode-sqlite');
    await writeFile(join(f.state, 'data/opencode/opencode.db-wal'), 'owned-opencode-wal');
    const { archive, inventory } = await packNativeState(f.state);
    expect(inventory.files).toBe(4);
    const restored = join(f.root, 'without-logs'); await unpackNativeState(archive, restored);
    await expect(readFile(join(restored, 'data/opencode/log/private.log'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(restored, 'data/opencode/opencode.db'), 'utf8')).toBe('owned-opencode-sqlite');
    expect(await readFile(join(restored, 'data/opencode/opencode.db-wal'), 'utf8')).toBe('owned-opencode-wal');
  });
  it('holds one SQL owner and restores authenticated checkpoint state after releasing the old owner', async () => {
    const f = await workspace(), first = await NativeT3StateLease.acquire(f.options);
    await expect(NativeT3StateLease.acquire({ ...f.options, store: f.peer ?? f.store })).rejects.toMatchObject({ statusCode: 429 });
    await first.checkpoint(f.state); await first.release();
    const next = await NativeT3StateLease.acquire({ ...f.options, store: f.peer ?? f.store });
    expect(next.generation).toBe(first.generation + 1);
    await expect(first.renew()).rejects.toMatchObject({ statusCode: 409 });
    const restore = join(f.root, 'restored'); await expect(next.restore(restore)).resolves.toBe(true);
    expect(await readFile(join(restore, 'session.json'), 'utf8')).toBe('fresh-program-owned-session');
    await next.release();
  });
  it('rejects checkpoint publication when ownership changes during object upload and retains durable cleanup intent', async () => {
    const f = await workspace();
    const objects = { ...f.objects, provider: f.objects.provider, get: f.objects.get.bind(f.objects), delete: f.objects.delete.bind(f.objects), async put(...args: Parameters<DiskObjectStore['put']>) { const saved = await f.objects.put(...args); await (f.peer ?? f.store).exec('UPDATE studio_native_t3_states SET owner=? WHERE id=?', 'different-owner', f.id); return saved; } };
    const lease = await NativeT3StateLease.acquire({ ...f.options, objects });
    await expect(lease.checkpoint(f.state)).rejects.toMatchObject({ statusCode: 409 });
    expect((await f.store.one('SELECT checkpoint_key AS key FROM studio_native_t3_states')).key).toBeNull();
    expect((await f.store.one('SELECT count(*) AS n FROM studio_native_t3_cleanup')).n).toBe(1);
  });
  it('rechecks ownership after checkpoint download before restoring private bytes', async () => {
    const f = await workspace(), lease = await NativeT3StateLease.acquire(f.options);
    await lease.checkpoint(f.state); await lease.release();
    const objects = { ...f.objects, provider: f.objects.provider, put: f.objects.put.bind(f.objects), delete: f.objects.delete.bind(f.objects), async get(...args: Parameters<DiskObjectStore['get']>) { const saved = await f.objects.get(...args); await (f.peer ?? f.store).exec('UPDATE studio_native_t3_states SET owner=? WHERE id=?', 'different-owner', f.id); return saved; } };
    const next = await NativeT3StateLease.acquire({ ...f.options, objects });
    await expect(next.restore(join(f.root, 'rejected'))).rejects.toMatchObject({ statusCode: 409 });
    await expect(readFile(join(f.root, 'rejected/session.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('retains the encrypted object pointer across artifact deletion and failed Blob cleanup, then retries safely', async () => {
    const f = await workspace(), lease = await NativeT3StateLease.acquire(f.options);
    await lease.checkpoint(f.state); await lease.release();
    const objectKey = (await f.store.one('SELECT checkpoint_key AS key FROM studio_native_t3_states')).key;
    await f.store.exec('DELETE FROM artifacts WHERE id=?', f.artifact.id);
    await expect(NativeT3StateLease.acquire(f.options)).rejects.toMatchObject({ statusCode: 404 });
    let failures = 1;
    const objects = { provider: f.objects.provider, put: f.objects.put.bind(f.objects), get: f.objects.get.bind(f.objects), async delete(key: string) { if (failures--) throw new Error('Temporary Blob failure'); await f.objects.delete(key); } };
    await cleanupManagedT3Checkpoints(f.store, objects);
    expect((await f.store.one('SELECT checkpoint_key AS key FROM studio_native_t3_states')).key).toBe(objectKey);
    await f.store.exec('UPDATE studio_native_t3_states SET lease_until=?', '2000-01-01T00:00:00.000Z');
    await cleanupManagedT3Checkpoints(f.store, objects);
    expect(await f.store.one('SELECT id FROM studio_native_t3_states')).toBeUndefined();
    expect(await f.objects.get(objectKey, { maxBytes: 100000 })).toBeNull();
  });
  it.skipIf(provider !== 'postgres')('admits only one winner when independent PostgreSQL instances race for the same native state', async () => {
    const f = await workspace();
    const attempts = await Promise.allSettled([NativeT3StateLease.acquire(f.options), NativeT3StateLease.acquire({ ...f.options, store: f.peer! })]);
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const failed = attempts.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ statusCode: 429 });
    for (const result of attempts) if (result.status === 'fulfilled') await result.value.release();
  });
});
