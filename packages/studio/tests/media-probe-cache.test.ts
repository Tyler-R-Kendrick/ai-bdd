import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Store, HttpError } from '../server/store.ts';
import { openDatabase } from '../server/persistence/index.ts';
import { CachedAudioSourceProbe } from '../server/media/probe-cache.ts';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const pg = process.env.STUDIO_TEST_POSTGRES_URL;
const metadata = {
  duration: 0.5,
  sampleRate: 48000,
  channels: 1 as const,
  decodedBytes: 96000,
  codec: 'pcm_s16le',
  format: 'wav',
};
async function fixture(database: 'sqlite' | 'postgres', pending = false) {
  const schema = 'test_' + randomUUID().replaceAll('-', '');
  const open = () =>
    database === 'sqlite'
      ? Store.open(':memory:')
      : openDatabase({ adapter: 'postgres', url: pg!, schema }).then((db) =>
          Store.open(db),
        );
  const first = await open(),
    second = database === 'sqlite' ? first : await open();
  cleanup.push(() => first.close());
  if (first !== second) cleanup.push(() => second.close());
  let count = 0,
    release!: () => void,
    arrived!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    incoming = new Promise<void>((r) => (arrived = r));
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
    }
    count++;
    arrived();
    if (pending && count === 1) await gate;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(metadata));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanup.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  const driver =
    (store: Store) =>
    async (bytes: Uint8Array, { signal }: any = {}) => {
      expect(store.db.inTransaction()).toBe(false);
      const response = await fetch(
        'http://127.0.0.1:' + (server.address() as any).port,
        { method: 'POST', body: Buffer.from(bytes), signal },
      );
      return response.json();
    };
  const a = new CachedAudioSourceProbe({
      store: first,
      fingerprint: 'image@sha256:a',
      probe: driver(first),
      leaseMs: 300,
    }),
    b = new CachedAudioSourceProbe({
      store: second,
      fingerprint: 'image@sha256:a',
      probe: driver(second),
      leaseMs: 300,
    });
  await Promise.all([a.ready, b.ready]);
  return {
    first,
    second,
    a,
    b,
    count: () => count,
    release,
    incoming,
    driver,
  };
}
for (const database of ['sqlite', 'postgres'] as const)
  describe.skipIf(database === 'postgres' && !pg)(
    'shared audio metadata receipts on ' + database,
    () => {
      it('shares one active probe across instances and reuses the hash-bound receipt without new admission', async () => {
        const w = await fixture(database, true),
          bytes = Buffer.alloc(64, 7),
          one = w.a.probe(bytes),
          two = w.b.probe(bytes);
        await w.incoming;
        w.release();
        expect(await one).toEqual(metadata);
        expect(await two).toEqual(metadata);
        expect(await w.b.probe(bytes)).toEqual(metadata);
        expect(w.count()).toBe(1);
        expect(
          Number(
            (
              await w.first.one(
                'SELECT COUNT(*) AS n FROM studio_media_probe_admissions',
              )
            )?.n,
          ),
        ).toBe(1);
      });
      it('invalidates by runtime digest and source bytes and rejects changed cached metadata', async () => {
        const w = await fixture(database),
          bytes = Buffer.alloc(64, 8);
        await w.a.probe(bytes);
        const other = new CachedAudioSourceProbe({
          store: w.second,
          fingerprint: 'image@sha256:b',
          probe: w.driver(w.second),
        });
        await other.probe(bytes);
        await w.a.probe(Buffer.alloc(64, 9));
        expect(w.count()).toBe(3);
        await w.first.exec(
          "UPDATE studio_media_probe_cache SET probe_json='{}'",
        );
        await expect(w.a.probe(bytes)).rejects.toMatchObject({
          statusCode: 409,
        });
      });
      it('admits a bounded number of actual probes and keeps completed cache reads free', async () => {
        const w = await fixture(database),
          limited = new CachedAudioSourceProbe({
            store: w.first,
            fingerprint: 'bounded',
            probe: w.driver(w.first),
            hourlyLimit: 1,
          });
        const bytes = Buffer.alloc(64, 3);
        await limited.probe(bytes);
        await expect(
          limited.probe(Buffer.alloc(64, 4)),
        ).rejects.toMatchObject({ statusCode: 429 });
        expect(await limited.probe(bytes)).toEqual(metadata);
        expect(w.count()).toBe(1);
      });
      it('fences late old metadata after a lease replacement', async () => {
        const w = await fixture(database, true),
          bytes = Buffer.alloc(64, 5),
          old = w.a.probe(bytes).catch((error) => error);
        await w.incoming;
        await w.second.exec(
          'UPDATE studio_media_probe_cache SET lease_expires=?',
          Date.now() - 1,
        );
        expect(await w.b.probe(bytes)).toEqual(metadata);
        w.release();
        expect(await old).toMatchObject({ statusCode: 409 });
        expect(w.count()).toBe(2);
      });
      it('releases failed transient attempts, caches only bounded permanent decode rejection, and never performs HTTP inside source SQL', async () => {
        const w = await fixture(database),
          bad = new CachedAudioSourceProbe({
            store: w.first,
            fingerprint: 'invalid-decode',
            probe: async () => {
              throw new HttpError(400, 'Invalid fixture source');
            },
          });
        const bytes = Buffer.alloc(64, 2);
        await expect(bad.probe(bytes)).rejects.toMatchObject({
          statusCode: 400,
        });
        await expect(bad.probe(bytes)).rejects.toMatchObject({
          statusCode: 400,
        });
        expect(
          Number(
            (
              await w.first.one(
                'SELECT COUNT(*) AS n FROM studio_media_probe_admissions',
              )
            )?.n,
          ),
        ).toBe(1);
        await w.first.tx(async () => {
          await expect(w.a.probe(bytes)).rejects.toThrow(
            'outside source SQL',
          );
        });
        expect(w.count()).toBe(0);
      });
    },
  );
