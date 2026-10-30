import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { DiskObjectStore } from '../server/hosting/disk-objects.ts';
import { VercelBlobObjectStore } from '../server/hosting/vercel-objects.ts';
import { BlobError, get as getBlob } from '@vercel/blob';
import {
  objectDigest,
  ObjectConflictError,
} from '../server/hosting/objects.ts';

let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'studio-objects-'));
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
describe('local immutable object-store contract', () => {
  it('retains bytes across adapter instances, verifies integrity, and rejects overwrites/traversal', async () => {
    const first = new DiskObjectStore(directory),
      second = new DiskObjectStore(directory);
    const bytes = Buffer.from('private evidence bytes');
    const stored = await first.put('evidence/run-1/image.png', bytes, {
      contentType: 'image/png',
    });
    expect(
      (
        await second.get(stored.key, {
          maxBytes: 100,
          expectedSha256: stored.sha256,
        })
      )?.bytes,
    ).toEqual(bytes);
    expect(
      (await second.put(stored.key, bytes, { contentType: 'image/png' }))
        .sha256,
    ).toBe(stored.sha256);
    await expect(
      first.put(stored.key, Buffer.from('different'), {
        contentType: 'image/png',
      }),
    ).rejects.toThrow('different content');
    await expect(first.get('../outside', { maxBytes: 100 })).rejects.toThrow(
      'Invalid',
    );
    await expect(first.get(stored.key, { maxBytes: 1 })).rejects.toThrow(
      'bound',
    );
    const path = join(directory, stored.key);
    const content = await readFile(path);
    content[content.length - 1] ^= 1;
    await writeFile(path, content);
    await expect(second.get(stored.key, { maxBytes: 100 })).rejects.toThrow(
      'integrity',
    );
    await second.delete(stored.key);
    expect(await first.get(stored.key, { maxBytes: 100 })).toBeNull();
  });
});

describe('actual Vercel Blob SDK HTTP protocol against an explicit local provider fixture', () => {
  const records = new Map<string, { bytes: Buffer; contentType: string }>();
  const bodyReads = new Map<string, number>();
  const lostWriteResponses = new Set<string>();
  const rejectedWrites = new Set<string>();
  const falseMetadataSizes = new Map<string, number>();
  const compressedGets = new Set<string>();
  const chunkedGets = new Set<string>();
  const headers: Record<string, string | undefined>[] = [];
  let origin: string;
  const server = createServer(async (request, reply) => {
    const url = new URL(request.url!, origin);
    const respond = (code: number, value: unknown) => {
      reply.writeHead(code, { 'content-type': 'application/json' });
      reply.end(JSON.stringify(value));
    };
    if (
      request.headers.authorization !==
      'Bearer vercel_blob_rw_fixture_test-only-key'
    ) {
      respond(403, {
        error: {
          code: 'forbidden',
          message: 'fixture authorization required',
        },
      });
      return;
    }
    if (request.method === 'PUT') {
      const key = url.searchParams.get('pathname')!;
      headers.push(request.headers as Record<string, string | undefined>);
      if (rejectedWrites.has(key)) {
        respond(400, {
          error: {
            code: 'bad_request',
            message: 'fixture write rejected before commit',
          },
        });
        return;
      }
      if (records.has(key)) {
        respond(409, {
          error: { code: 'bad_request', message: 'blob already exists' },
        });
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const contentType = String(request.headers['x-content-type']);
      records.set(key, { bytes, contentType });
      if (lostWriteResponses.delete(key)) {
        reply.destroy();
        return;
      }
      respond(200, {
        url: `${origin}/${key}`,
        downloadUrl: `${origin}/${key}?download=1`,
        pathname: key,
        contentType,
        contentDisposition: 'attachment',
        etag: objectDigest(bytes),
      });
      return;
    }
    if (request.method === 'POST' && url.pathname.endsWith('/delete')) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      body.urls.forEach((key: string) => records.delete(key));
      respond(200, {});
      return;
    }
    if (url.pathname === '/api/blob') {
      const key = url.searchParams.get('url')!;
      const record = records.get(key);
      if (!record) {
        respond(404, {
          error: { code: 'not_found', message: 'fixture object not found' },
        });
        return;
      }
      respond(200, {
        url: `${origin}/${key}`,
        downloadUrl: `${origin}/${key}?download=1`,
        pathname: key,
        size: falseMetadataSizes.get(key) ?? record.bytes.length,
        contentType: record.contentType,
        contentDisposition: 'attachment',
        cacheControl: 'private,no-store',
        uploadedAt: new Date(0).toISOString(),
        etag: objectDigest(record.bytes),
      });
      return;
    }
    const key = url.pathname.slice(1);
    bodyReads.set(key, (bodyReads.get(key) ?? 0) + 1);
    const record = records.get(key);
    if (!record) {
      reply.writeHead(404);
      reply.end();
      return;
    }
    const transport = compressedGets.has(key) ? gzipSync(record.bytes) : record.bytes;
    reply.writeHead(200, {
      'content-type': record.contentType,
      ...(chunkedGets.has(key)
        ? { 'transfer-encoding': 'chunked' }
        : { 'content-length': transport.length }),
      ...(compressedGets.has(key) ? { 'content-encoding': 'gzip' } : {}),
      etag: objectDigest(record.bytes),
    });
    reply.end(transport);
  });
  beforeAll(async () => {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    vi.stubEnv('VERCEL_BLOB_API_URL', origin + '/api/blob');
    vi.stubEnv('VERCEL_BLOB_RETRIES', '0');
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  it('reads private compressed JSON when the SDK reports zero for absent transport length', async () => {
    const token = 'vercel_blob_rw_fixture_test-only-key';
    const store = new VercelBlobObjectStore({ token });
    const key = 'studio/v1/manifests/chunked.json';
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, text: 'manifest bytes '.repeat(100) }));
    const expected = await store.put(key, bytes, { contentType: 'application/json' });
    compressedGets.add(key);
    chunkedGets.add(key);
    const sdk = await getBlob(origin + '/' + key, { token, access: 'private', useCache: false });
    expect(sdk?.statusCode).toBe(200);
    expect(sdk!.blob.size).toBe(0);
    expect(Buffer.from(await new Response(sdk!.stream).arrayBuffer())).toEqual(bytes);
    expect((await store.get(key, { maxBytes: bytes.length, expectedSha256: expected.sha256 }))?.bytes).toEqual(bytes);
    await expect(store.get(key, { maxBytes: bytes.length, expectedSha256: '0'.repeat(64) })).rejects.toThrow('integrity');
    const before = bodyReads.get(key)!;
    await expect(store.get(key, { maxBytes: bytes.length - 1 })).rejects.toThrow('oversized');
    expect(bodyReads.get(key)).toBe(before);
    falseMetadataSizes.set(key, bytes.length - 1);
    await expect(store.get(key, { maxBytes: bytes.length })).rejects.toThrow('length changed');
    falseMetadataSizes.set(key, 1);
    await expect(store.get(key, { maxBytes: 1 })).rejects.toThrow('bound');
  });
  it('rejects contradictory nonzero GET length even when decoded bytes match HEAD', async () => {
    const store = new VercelBlobObjectStore({ token: 'vercel_blob_rw_fixture_test-only-key' });
    const key = 'studio/v1/manifests/nonzero-transport.json';
    const bytes = Buffer.from(JSON.stringify({ text: 'same bounded logical bytes '.repeat(100) }));
    await store.put(key, bytes, { contentType: 'application/json' });
    compressedGets.add(key);
    await expect(store.get(key, { maxBytes: bytes.length, expectedSha256: objectDigest(bytes) })).rejects.toThrow('length changed');
  });
  it('uses private authenticated immutable operations and preserves bytes through the SDK', async () => {
    const store = new VercelBlobObjectStore({
      token: 'vercel_blob_rw_fixture_test-only-key',
    });
    const bytes = Buffer.from('SDK protocol fixture');
    const result = await store.put('studio/v1/evidence/one.bin', bytes, {
      contentType: 'application/octet-stream',
    });
    expect(headers[0]?.['x-vercel-blob-access']).toBe('private');
    expect(headers[0]?.['x-allow-overwrite']).toBe('0');
    expect(headers[0]?.['x-add-random-suffix']).toBe('0');
    expect(
      (
        await store.get(result.key, {
          maxBytes: 100,
          expectedSha256: result.sha256,
        })
      )?.bytes,
    ).toEqual(bytes);
    expect(
      (
        await store.put(result.key, bytes, {
          contentType: 'application/octet-stream',
        })
      ).sha256,
    ).toBe(result.sha256);
    await expect(
      store.put(result.key, Buffer.from('changed bytes'), {
        contentType: 'application/octet-stream',
      }),
    ).rejects.toThrow();
    await expect(
      store.get(result.key, {
        maxBytes: 100,
        expectedSha256: '0'.repeat(64),
      }),
    ).rejects.toThrow('integrity');
    await expect(store.get(result.key, { maxBytes: 1 })).rejects.toThrow(
      'oversized',
    );
    await store.delete(result.key);
    expect(await store.get(result.key, { maxBytes: 100 })).toBeNull();
  });
  it.each([
    {
      label: 'shorter bytes',
      replacement: 'x',
      contentType: 'application/octet-stream',
      reads: 0,
    },
    {
      label: 'longer bytes',
      replacement: 'replacement is longer',
      contentType: 'application/octet-stream',
      reads: 0,
    },
    {
      label: 'same-length different bytes',
      replacement: 'modified',
      contentType: 'application/octet-stream',
      reads: 1,
    },
    {
      label: 'different content type',
      replacement: 'original',
      contentType: 'text/plain',
      reads: 0,
    },
  ])(
    'classifies $label as typed immutable conflict with bounded reads',
    async ({ label, replacement, contentType, reads }) => {
      const store = new VercelBlobObjectStore({
        token: 'vercel_blob_rw_fixture_test-only-key',
      });
      const key =
        'studio/v1/conflicts/' + label.replaceAll(' ', '-') + '.bin';
      const bytes = Buffer.from('original');
      const first = await store.put(key, bytes, {
        contentType: 'application/octet-stream',
      });
      await expect(
        store.put(key, Buffer.from(replacement), { contentType }),
      ).rejects.toBeInstanceOf(ObjectConflictError);
      expect(bodyReads.get(key) ?? 0).toBe(reads);
      expect(
        (
          await store.get(key, {
            maxBytes: bytes.length,
            expectedSha256: first.sha256,
          })
        )?.bytes,
      ).toEqual(bytes);
      expect(records.get(key)?.contentType).toBe('application/octet-stream');
    },
  );
  it('adopts an actually committed write after a lost HTTP response only after bounded SHA verification', async () => {
    const store = new VercelBlobObjectStore({
      token: 'vercel_blob_rw_fixture_test-only-key',
    });
    const key = 'studio/v1/lost-write-response.bin';
    const bytes = Buffer.from('committed before the socket closes');
    lostWriteResponses.add(key);
    const first = await store.put(key, bytes, {
      contentType: 'application/octet-stream',
    });
    expect(first.sha256).toBe(objectDigest(bytes));
    expect(bodyReads.get(key)).toBe(1);
    expect(
      (
        await store.put(key, bytes, {
          contentType: 'application/octet-stream',
        })
      ).sha256,
    ).toBe(first.sha256);
    expect(bodyReads.get(key)).toBe(2);
  });
  it('preserves a failed provider write when no object exists', async () => {
    const store = new VercelBlobObjectStore({
      token: 'vercel_blob_rw_fixture_test-only-key',
    });
    const key = 'studio/v1/rejected-write.bin';
    rejectedWrites.add(key);
    await expect(
      store.put(key, Buffer.from('not committed'), {
        contentType: 'application/octet-stream',
      }),
    ).rejects.toBeInstanceOf(BlobError);
    expect(bodyReads.get(key) ?? 0).toBe(0);
    expect(await store.get(key, { maxBytes: 100 })).toBeNull();
  });
  it('never adopts a conflicting body when provider metadata misstates its size', async () => {
    const store = new VercelBlobObjectStore({
      token: 'vercel_blob_rw_fixture_test-only-key',
    });
    const key = 'studio/v1/lying-metadata.bin';
    await store.put(key, Buffer.from('a larger existing body'), {
      contentType: 'application/octet-stream',
    });
    falseMetadataSizes.set(key, 1);
    await expect(
      store.put(key, Buffer.from('x'), {
        contentType: 'application/octet-stream',
      }),
    ).rejects.toBeInstanceOf(BlobError);
    expect(bodyReads.get(key)).toBe(1);
    expect(records.get(key)?.bytes.toString()).toBe('a larger existing body');
  });
});
