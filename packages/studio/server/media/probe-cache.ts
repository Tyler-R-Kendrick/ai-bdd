import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { AudioProbe } from '../audio-renderer.ts';
import { Store, HttpError } from '../store.ts';
import { audioProbeSchema } from './protocol.ts';
const sha = (value: Uint8Array | string) =>
  createHash('sha256').update(value).digest('hex');
/** Derived metadata only; callers must check owned source bytes and authorization on every read. */
export class CachedAudioSourceProbe {
  readonly ready: Promise<void>;
  private readonly owner = randomUUID();
  constructor(
    readonly options: {
      store: Store;
      fingerprint: string;
      probe: (
        bytes: Uint8Array,
        options?: { signal?: AbortSignal },
      ) => Promise<AudioProbe>;
      leaseMs?: number;
      hourlyLimit?: number;
      concurrentLimit?: number;
    },
  ) {
    this.ready = this.initialize();
    void this.ready.catch(() => {});
  }
  private async initialize() {
    await this.options.store.tx(async () => {
      await this.options.store.lock('schema:studio.media-probe');
      await this.options.store.db.exec(
        `CREATE TABLE IF NOT EXISTS studio_media_probe_cache(id TEXT PRIMARY KEY,source_sha256 TEXT NOT NULL,runtime_fingerprint TEXT NOT NULL,status TEXT NOT NULL,fence BIGINT NOT NULL DEFAULT 0,lease_owner TEXT,lease_expires BIGINT,probe_json TEXT,probe_sha256 TEXT,error_status INTEGER,updated_at BIGINT NOT NULL);CREATE TABLE IF NOT EXISTS studio_media_probe_admissions(id TEXT PRIMARY KEY,admitted_at BIGINT NOT NULL);CREATE INDEX IF NOT EXISTS studio_media_probe_admission_time ON studio_media_probe_admissions(admitted_at);`,
      );
    });
  }
  private get store() {
    return this.options.store;
  }
  private async locked<T>(operation: () => Promise<T>) {
    return this.store.tx(async () => {
      await this.store.lock('media-probe:admission');
      return operation();
    });
  }
  readonly probe = async (
    bytes: Uint8Array,
    options: { signal?: AbortSignal } = {},
  ): Promise<AudioProbe> => {
    await this.ready;
    if (this.store.db.inTransaction())
      throw new Error(
        'Audio probe network evaluation must run outside source SQL transactions',
      );
    if (bytes.byteLength < 16 || bytes.byteLength > 10 * 1024 * 1024)
      throw new HttpError(
        413,
        'An audio source must be a complete file of at most 10 MiB',
      );
    const source = sha(bytes),
      id = sha(source + ':' + this.options.fingerprint),
      signal = AbortSignal.any([
        ...(options.signal ? [options.signal] : []),
        AbortSignal.timeout(120000),
      ]);
    const leaseMs = this.options.leaseMs ?? 90000;
    while (true) {
      signal.throwIfAborted();
      const claim = await this.locked(async () => {
        const now = Date.now(),
          row = await this.store.one(
            'SELECT * FROM studio_media_probe_cache WHERE id=?',
            id,
          );
        if (
          row &&
          (row.source_sha256 !== source ||
            row.runtime_fingerprint !== this.options.fingerprint)
        )
          throw new HttpError(
            409,
            'The audio metadata receipt does not match its source and runtime',
          );
        if (
          row &&
          row.updated_at > now - 86400000 &&
          row.status === 'completed'
        ) {
          if (sha(row.probe_json) !== row.probe_sha256)
            throw new HttpError(
              409,
              'The cached audio metadata receipt failed integrity verification',
            );
          return {
            cached: audioProbeSchema.parse(JSON.parse(row.probe_json)),
          };
        }
        if (
          row &&
          row.updated_at > now - 300000 &&
          row.status === 'error' &&
          [400, 413].includes(row.error_status)
        )
          throw new HttpError(
            row.error_status,
            'This source previously failed complete audio decoding',
          );
        if (row?.status === 'running' && Number(row.lease_expires) > now)
          return null;
        const count = async (sql: string, ...params: any[]) =>
          Number((await this.store.one(sql, ...params))?.n ?? 0);
        if (
          (await count(
            'SELECT COUNT(*) AS n FROM studio_media_probe_admissions WHERE admitted_at>?',
            now - 3600000,
          )) >= (this.options.hourlyLimit ?? 300) ||
          (await count(
            "SELECT COUNT(*) AS n FROM studio_media_probe_cache WHERE status='running' AND lease_expires>?",
            now,
          )) >= (this.options.concurrentLimit ?? 2)
        )
          throw new HttpError(
            429,
            'The shared audio inspection budget is exhausted; retry later',
          );
        const fence = Number(row?.fence ?? 0) + 1;
        await this.store.exec(
          "INSERT INTO studio_media_probe_cache(id,source_sha256,runtime_fingerprint,status,fence,lease_owner,lease_expires,updated_at) VALUES(?,?,?,'running',?,?,?,?) ON CONFLICT(id) DO UPDATE SET status='running',fence=excluded.fence,lease_owner=excluded.lease_owner,lease_expires=excluded.lease_expires,probe_json=NULL,probe_sha256=NULL,error_status=NULL,updated_at=excluded.updated_at",
          id,
          source,
          this.options.fingerprint,
          fence,
          this.owner,
          now + leaseMs,
          now,
        );
        await this.store.exec(
          'INSERT INTO studio_media_probe_admissions(id,admitted_at) VALUES(?,?)',
          randomUUID(),
          now,
        );
        return { fence };
      });
      if (claim && 'cached' in claim) return claim.cached!;
      if (!claim) {
        await delay(30, undefined, { signal });
        continue;
      }
      const controller = new AbortController(),
        combined = AbortSignal.any([signal, controller.signal]);
      let heartbeat: Promise<void> | undefined;
      const timer = setInterval(
        () => {
          if (heartbeat) return;
          heartbeat = this.locked(async () => {
            const row = await this.store.one(
              'SELECT * FROM studio_media_probe_cache WHERE id=?',
              id,
            );
            if (
              row?.status !== 'running' ||
              row.lease_owner !== this.owner ||
              Number(row.fence) !== claim.fence ||
              Number(row.lease_expires) <= Date.now()
            )
              throw new Error('Audio probe lease lost');
            await this.store.exec(
              'UPDATE studio_media_probe_cache SET lease_expires=? WHERE id=?',
              Date.now() + leaseMs,
              id,
            );
          })
            .catch((error) => controller.abort(error))
            .finally(() => {
              heartbeat = undefined;
            });
        },
        Math.max(25, Math.floor(leaseMs / 3)),
      );
      timer.unref();
      let result: AudioProbe | undefined, error: unknown;
      try {
        result = audioProbeSchema.parse(
          await this.options.probe(bytes, { signal: combined }),
        );
        combined.throwIfAborted();
      } catch (caught) {
        error = caught;
      }
      clearInterval(timer);
      await heartbeat;
      const accepted = await this.locked(async () => {
        const row = await this.store.one(
          'SELECT * FROM studio_media_probe_cache WHERE id=?',
          id,
        );
        if (
          row?.status !== 'running' ||
          row.lease_owner !== this.owner ||
          Number(row.fence) !== claim.fence ||
          Number(row.lease_expires) <= Date.now()
        )
          return false;
        const value = result && !error ? JSON.stringify(result) : null,
          status =
            error instanceof HttpError &&
            [400, 413].includes(error.statusCode)
              ? error.statusCode
              : null;
        await this.store.exec(
          'UPDATE studio_media_probe_cache SET status=?,probe_json=?,probe_sha256=?,error_status=?,lease_owner=NULL,lease_expires=NULL,updated_at=? WHERE id=? AND fence=?',
          value ? 'completed' : status ? 'error' : 'queued',
          value,
          value ? sha(value) : null,
          status,
          Date.now(),
          id,
          claim.fence!,
        );
        return true;
      });
      if (!accepted)
        throw new HttpError(
          409,
          'The audio inspection lost its publication lease',
        );
      if (error) throw error;
      return result!;
    }
  };
  async cleanup() {
    await this.ready;
    await this.locked(async () => {
      await this.store.exec(
        "DELETE FROM studio_media_probe_cache WHERE status<>'running' AND updated_at<?",
        Date.now() - 86400000,
      );
      await this.store.exec(
        'DELETE FROM studio_media_probe_admissions WHERE admitted_at<?',
        Date.now() - 86400000,
      );
    });
  }
}
