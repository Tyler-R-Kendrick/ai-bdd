import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { Store } from '../store.ts';
import type { ObjectStore } from '../hosting/ports.ts';
import { HttpError } from '../http-error.ts';

export const NATIVE_STATE_BYTES = 48 * 1024 * 1024;
const FILES = 1000;
const ID = /^[a-f0-9]{64}$/;
const allowed = /^(?:native\/userdata\/|config\/|data\/|state\/|session\.json$)/;
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const lost = () => new HttpError(409, 'The managed T3 state lease is no longer owned by this attempt');
const invalid = () => new HttpError(503, 'The encrypted native T3 checkpoint is invalid or exceeds its bounded state budget');
export type NativeStateInventory = { files: number; bytes: number; databases: { path: string; bytes: number }[] };

/** Only fresh program-owned native state enters this archive. Executables, caches and logs are excluded. */
export async function packNativeState(root: string) {
  const files: { path: string; bytes: string }[] = [];
  const inventory: NativeStateInventory = { files: 0, bytes: 0, databases: [] };
  async function visit(relative: string) {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const path = posix.join(relative, entry.name);
      if (path === 'cache' || path === 'workspace' || path === 'native/caches' || path === 'native/userdata/logs' || path === 'native/userdata/browser-artifacts' || path === 'data/opencode/log' || path === 'data/opencode/logs') continue;
      if (entry.isSymbolicLink()) throw invalid();
      if (entry.isDirectory()) { await visit(path); continue; }
      if (!entry.isFile() || !allowed.test(path)) continue;
      // Runtime ownership/socket records describe a dead process, not durable T3 identity.
      if (/server-runtime\.json$|server\.lock$|\.sock$/.test(path)) continue;
      const info = await lstat(join(root, path));
      if (!info.isFile() || info.isSymbolicLink()) throw invalid();
      inventory.files++;
      inventory.bytes += info.size;
      if (inventory.files > FILES || inventory.bytes > NATIVE_STATE_BYTES) throw invalid();
      const bytes = await readFile(join(root, path));
      if (bytes.length !== info.size) throw invalid();
      files.push({ path, bytes: bytes.toString('base64') });
      if (/\.(?:sqlite|sqlite3|db)$/.test(path)) inventory.databases.push({ path, bytes: bytes.length });
    }
  }
  await visit('');
  const archive = gzipSync(Buffer.from(JSON.stringify({ version: 1, files })), { level: 6 });
  if (archive.length > NATIVE_STATE_BYTES) throw invalid();
  return { archive, inventory };
}

export async function unpackNativeState(archive: Uint8Array, root: string) {
  try {
    const value = JSON.parse(gunzipSync(archive, { maxOutputLength: NATIVE_STATE_BYTES * 1.4 + 8192 }).toString());
    if (value.version !== 1 || !Array.isArray(value.files) || value.files.length > FILES) throw invalid();
    const paths = new Set<string>();
    let bytes = 0;
    for (const file of value.files) {
      if (typeof file.path !== 'string' || !allowed.test(file.path) || file.path.length > 1000 || file.path.includes('\\') || posix.normalize(file.path) !== file.path || file.path.split('/').some((x: string) => !x || x === '..' || x === '.') || paths.has(file.path) || typeof file.bytes !== 'string') throw invalid();
      paths.add(file.path);
      const content = Buffer.from(file.bytes, 'base64');
      if (content.toString('base64') !== file.bytes || (bytes += content.length) > NATIVE_STATE_BYTES) throw invalid();
      await mkdir(join(root, posix.dirname(file.path)), { recursive: true, mode: 0o700 });
      await writeFile(join(root, file.path), content, { flag: 'wx', mode: 0o600 });
    }
  } catch { throw invalid(); }
}

export function encryptNativeState(archive: Uint8Array, key: Uint8Array, stateId: string) {
  if (key.length !== 32 || !ID.test(stateId)) throw invalid();
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from('studio-native-t3-v1:' + stateId));
  const bytes = Buffer.concat([cipher.update(archive), cipher.final()]);
  return Buffer.concat([Buffer.from('ST3\x01'), nonce, cipher.getAuthTag(), bytes]);
}
export function decryptNativeState(bytes: Uint8Array, key: Uint8Array, stateId: string) {
  try {
    const value = Buffer.from(bytes);
    if (key.length !== 32 || !ID.test(stateId) || value.length < 33 || value.length > NATIVE_STATE_BYTES + 64 || value.subarray(0, 4).toString('binary') !== 'ST3\x01') throw invalid();
    const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(4, 16));
    decipher.setAAD(Buffer.from('studio-native-t3-v1:' + stateId));
    decipher.setAuthTag(value.subarray(16, 32));
    return Buffer.concat([decipher.update(value.subarray(32)), decipher.final()]);
  } catch { throw invalid(); }
}

type Row = { id: string; projectId: string; artifactId: string; owner: string | null; generation: number; leaseUntil: string | null; checkpointKey: string | null; checkpointSha256: string | null; retireAfter: string; retired: number };
const columns = 'id,project_id AS "projectId",artifact_id AS "artifactId",owner,generation,lease_until AS "leaseUntil",checkpoint_key AS "checkpointKey",checkpoint_sha256 AS "checkpointSha256",retire_after AS "retireAfter",retired';
async function schema(store: Store) {
  await store.tx(async () => {
    await store.lock('schema:studio.native-t3.v1');
    // Retained scope deliberately has no cascade: the ledger must outlive deletion until encrypted Blob cleanup succeeds.
    await store.exec('CREATE TABLE IF NOT EXISTS studio_native_t3_states(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,artifact_id TEXT NOT NULL,owner TEXT,generation INTEGER NOT NULL,lease_until TEXT,checkpoint_key TEXT,checkpoint_sha256 TEXT,updated_at TEXT NOT NULL,retire_after TEXT NOT NULL,retired INTEGER NOT NULL DEFAULT 0)');
    await store.exec('CREATE TABLE IF NOT EXISTS studio_native_t3_cleanup(object_key TEXT PRIMARY KEY,not_before TEXT NOT NULL)');
  });
}
export class NativeT3StateLease {
  readonly owner = randomUUID();
  generation = 0;
  private constructor(readonly store: Store, readonly objects: ObjectStore, readonly id: string, readonly artifactId: string, readonly projectId: string, readonly key: Uint8Array, readonly leaseMs: number, readonly fence?: () => Promise<void>) {}
  static async acquire(options: { store: Store; objects: ObjectStore; id: string; artifactId: string; key: Uint8Array; leaseMs?: number; fence?: () => Promise<void> }) {
    if (!ID.test(options.id) || options.key.length !== 32) throw invalid();
    const artifact = await options.store.one('SELECT project_id AS "projectId" FROM artifacts WHERE id=?', options.artifactId);
    if (!artifact) throw new HttpError(404, 'The managed T3 artifact no longer exists');
    const lease = new NativeT3StateLease(options.store, options.objects, options.id, options.artifactId, artifact.projectId, options.key, options.leaseMs ?? 90000, options.fence);
    await schema(options.store);
    await options.store.tx(async () => {
      await lease.scope();
      await options.store.lock('native-t3:' + options.id);
      const row = await options.store.one('SELECT ' + columns + ' FROM studio_native_t3_states WHERE id=?', options.id) as Row | undefined;
      if (row?.owner && row.leaseUntil && row.leaseUntil > new Date().toISOString()) throw new HttpError(429, 'This native T3 request is already owned by a running attempt');
      if (row && (row.retired || row.projectId !== lease.projectId || row.artifactId !== options.artifactId)) throw lost();
      lease.generation = (row?.generation ?? 0) + 1;
      const until = new Date(Date.now() + lease.leaseMs).toISOString();
      const retire = new Date(Date.now() + 7 * 86400000).toISOString();
      if (row) await options.store.exec('UPDATE studio_native_t3_states SET owner=?,generation=?,lease_until=?,updated_at=?,retire_after=? WHERE id=?', lease.owner, lease.generation, until, new Date().toISOString(), retire, options.id);
      else await options.store.exec('INSERT INTO studio_native_t3_states(id,project_id,artifact_id,owner,generation,lease_until,updated_at,retire_after) VALUES(?,?,?,?,?,?,?,?)', options.id, lease.projectId, lease.artifactId, lease.owner, lease.generation, until, new Date().toISOString(), retire);
    });
    return lease;
  }
  private async scope() {
    await this.store.lock('project:' + this.projectId);
    const artifact = await this.store.one('SELECT project_id AS "projectId" FROM artifacts WHERE id=?', this.artifactId);
    if (!artifact || artifact.projectId !== this.projectId) throw new HttpError(404, 'The managed T3 artifact no longer exists');
  }
  private async owned() {
    const row = await this.store.one('SELECT ' + columns + ' FROM studio_native_t3_states WHERE id=?', this.id) as Row | undefined;
    if (!row || row.retired || row.projectId !== this.projectId || row.artifactId !== this.artifactId || row.owner !== this.owner || row.generation !== this.generation || !row.leaseUntil || row.leaseUntil <= new Date().toISOString()) throw lost();
    return row;
  }
  async renew() {
    await this.store.tx(async () => {
      await this.scope();
      await this.store.lock('native-t3:' + this.id);
      await this.owned();
      await this.store.exec('UPDATE studio_native_t3_states SET lease_until=?,updated_at=? WHERE id=? AND owner=? AND generation=?', new Date(Date.now() + this.leaseMs).toISOString(), new Date().toISOString(), this.id, this.owner, this.generation);
    });
  }
  async restore(root: string) {
    const check = () => this.store.tx(async () => { await this.scope(); await this.store.lock('native-t3:' + this.id); return this.owned(); });
    const row = await check();
    if (!row.checkpointKey) return false;
    const object = await this.objects.get(row.checkpointKey, { maxBytes: NATIVE_STATE_BYTES + 64, expectedSha256: row.checkpointSha256! });
    if (!object || digest(object.bytes) !== row.checkpointSha256) throw invalid();
    await check();
    await unpackNativeState(decryptNativeState(object.bytes, this.key, this.id), root);
    await check();
    return true;
  }
  /** Caller must stop all native processes before taking this bounded snapshot. */
  async checkpoint(root: string) {
    const { archive, inventory } = await packNativeState(root);
    const bytes = encryptNativeState(archive, this.key, this.id);
    const objectKey = 'native-t3/v1/' + this.id + '/' + randomUUID() + '.bin';
    await this.store.tx(async () => {
      await this.scope();
      await this.store.lock('native-t3:' + this.id); await this.owned();
      await this.store.exec('INSERT INTO studio_native_t3_cleanup(object_key,not_before) VALUES(?,?)', objectKey, new Date(Date.now() + 600000).toISOString());
    });
    const object = await this.objects.put(objectKey, bytes, { contentType: 'application/octet-stream' });
    if (object.key !== objectKey || object.sha256 !== digest(bytes) || object.byteSize !== bytes.length || object.contentType !== 'application/octet-stream') throw invalid();
    await this.store.tx(async () => {
      await this.fence?.();
      await this.scope();
      await this.store.lock('native-t3:' + this.id);
      const before = await this.owned();
      await this.store.exec('UPDATE studio_native_t3_states SET checkpoint_key=?,checkpoint_sha256=?,updated_at=? WHERE id=? AND owner=? AND generation=?', object.key, object.sha256, new Date().toISOString(), this.id, this.owner, this.generation);
      await this.store.exec('DELETE FROM studio_native_t3_cleanup WHERE object_key=?', objectKey);
      if (before.checkpointKey) await this.store.exec('INSERT INTO studio_native_t3_cleanup(object_key,not_before) VALUES(?,?) ON CONFLICT(object_key) DO NOTHING', before.checkpointKey, new Date().toISOString());
    });
    return inventory;
  }
  async release() {
    await this.store.exec('UPDATE studio_native_t3_states SET owner=NULL,lease_until=NULL WHERE id=? AND owner=? AND generation=?', this.id, this.owner, this.generation);
  }
  async cleanup() {
    await cleanupManagedT3Checkpoints(this.store, this.objects, 10);
  }
}

/** Minute maintenance calls this without a decryption key. Blob deletion succeeds before its retained ledger is removed. */
export async function cleanupManagedT3Checkpoints(store: Store, objects: ObjectStore, limit = 10) {
    await schema(store);
    const bounded = Math.min(100, Math.max(1, Math.floor(limit)));
    const now = new Date().toISOString();
    const retired = await store.all('SELECT ' + columns + ' FROM studio_native_t3_states s WHERE retired=1 OR retire_after<? OR NOT EXISTS(SELECT 1 FROM artifacts a WHERE a.id=s.artifact_id AND a.project_id=s.project_id) LIMIT ' + bounded, now) as Row[];
    for (const old of retired) {
      const owner = 'gc:' + randomUUID(); let claimed: Row | undefined;
      await store.tx(async () => {
        await store.lock('project:' + old.projectId); await store.lock('native-t3:' + old.id);
        const row = await store.one('SELECT ' + columns + ' FROM studio_native_t3_states WHERE id=?', old.id) as Row | undefined;
        if (!row) return;
        const exists = await store.one('SELECT id FROM artifacts WHERE id=? AND project_id=?', row.artifactId, row.projectId);
        if (!row.retired && exists && row.retireAfter >= now) return;
        if (row.owner?.startsWith('gc:') && row.leaseUntil && row.leaseUntil > now) return;
        if (exists && row.owner && row.leaseUntil && row.leaseUntil > now) return;
        claimed = { ...row, owner, generation: row.generation + 1 };
        await store.exec('UPDATE studio_native_t3_states SET retired=1,owner=?,generation=?,lease_until=? WHERE id=?', owner, claimed.generation, new Date(Date.now() + 90000).toISOString(), row.id);
      });
      if (!claimed) continue;
      try {
        if (claimed.checkpointKey) await objects.delete(claimed.checkpointKey);
        await store.tx(async () => {
          await store.lock('project:' + claimed!.projectId); await store.lock('native-t3:' + claimed!.id);
          await store.exec('DELETE FROM studio_native_t3_states WHERE id=? AND owner=? AND generation=?', claimed!.id, owner, claimed!.generation);
        });
      } catch { /* Keep the encrypted object pointer and retry its fenced retirement after lease expiry. */ }
    }
    const rows = await store.all('SELECT object_key AS "objectKey" FROM studio_native_t3_cleanup WHERE not_before<? LIMIT ' + bounded, new Date().toISOString());
    for (const row of rows) {
      if (typeof row.objectKey !== 'string' || !/^native-t3\/v1\/[a-f0-9]{64}\/[a-f0-9-]{36}\.bin$/.test(row.objectKey)) continue;
      if (await store.one('SELECT id FROM studio_native_t3_states WHERE checkpoint_key=?', row.objectKey)) continue;
      try {
        await objects.delete(row.objectKey);
        await store.exec('DELETE FROM studio_native_t3_cleanup WHERE object_key=?', row.objectKey);
      } catch { /* Durable cleanup intent remains for the next execution. */ }
    }
}
