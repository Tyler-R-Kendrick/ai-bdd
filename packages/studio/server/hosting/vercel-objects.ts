import * as blob from '@vercel/blob';
import type { ObjectStore } from './ports.ts';
import {
  assertObjectKey,
  assertObjectLimit,
  assertObjectType,
  boundedObjectStream,
  describeObject,
  ObjectConflictError,
  ObjectIntegrityError,
  verifyObject,
} from './objects.ts';

export type VercelBlobOptions = { token?: string; storeId?: string };
/** Private provider implementation. URLs and provider credentials never enter artifact content. */
export class VercelBlobObjectStore implements ObjectStore {
  readonly provider = 'vercel-blob';
  readonly #options: VercelBlobOptions;
  constructor(options: VercelBlobOptions = {}) {
    this.#options = { ...options };
  }
  async put(
    key: string,
    bytes: Uint8Array,
    { contentType }: { contentType: string },
  ) {
    assertObjectKey(key);
    assertObjectLimit(bytes.byteLength);
    assertObjectType(contentType);
    const expected = describeObject(key, bytes, contentType);
    try {
      const result = await blob.put(key, Buffer.from(bytes), {
        ...this.#options,
        access: 'private',
        addRandomSuffix: false,
        allowOverwrite: false,
        contentType,
        cacheControlMaxAge: 60,
        abortSignal: AbortSignal.timeout(30000),
      });
      if (result.pathname !== key)
        throw new ObjectIntegrityError(
          'Object provider changed the immutable storage key.',
        );
      return { ...expected, etag: result.etag };
    } catch (error) {
      // A timed-out successful write and a simultaneous identical write are both safe to adopt.
      const metadata = await blob
        .head(key, {
          ...this.#options,
          abortSignal: AbortSignal.timeout(15000),
        })
        .catch(() => null);
      if (!metadata) throw error;
      if (
        metadata.pathname !== key ||
        !Number.isSafeInteger(metadata.size) ||
        metadata.size < 0
      )
        throw new ObjectIntegrityError(
          'Object provider returned invalid immutable metadata.',
        );
      // A different length/type proves conflict without reading an arbitrarily
      // larger existing object. Equal metadata still requires the actual SHA.
      if (
        metadata.size !== bytes.byteLength ||
        metadata.contentType !== contentType
      )
        throw new ObjectConflictError(
          'An immutable object already exists with different content.',
        );
      const existing = await this.readObject(key, metadata, {
        maxBytes: Math.max(bytes.byteLength, 1),
      }).catch(() => null);
      if (existing) {
        if (
          existing.sha256 !== expected.sha256 ||
          existing.contentType !== contentType
        )
          throw new ObjectConflictError(
            'An immutable object already exists with different content.',
          );
        const { bytes: _, ...descriptor } = existing;
        return descriptor;
      }
      throw error;
    }
  }
  async get(
    key: string,
    options: { maxBytes: number; expectedSha256?: string },
  ) {
    assertObjectKey(key);
    assertObjectLimit(options.maxBytes);
    let metadata: Awaited<ReturnType<typeof blob.head>>;
    try {
      metadata = await blob.head(key, {
        ...this.#options,
        abortSignal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      if (error instanceof blob.BlobNotFoundError) return null;
      throw error;
    }
    return this.readObject(key, metadata, options);
  }
  private async readObject(
    key: string,
    metadata: Awaited<ReturnType<typeof blob.head>>,
    options: { maxBytes: number; expectedSha256?: string },
  ) {
    if (metadata.pathname !== key || metadata.size > options.maxBytes)
      throw new ObjectIntegrityError(
        'Object provider returned a different key or oversized object.',
      );
    const result = await blob.get(metadata.url, {
      ...this.#options,
      access: 'private',
      useCache: false,
      abortSignal: AbortSignal.timeout(30000),
    });
    if (!result) return null;
    if (result.statusCode !== 200 || result.blob.pathname !== key)
      throw new ObjectIntegrityError(
        'Object provider returned incomplete content.',
      );
    const bytes = await boundedObjectStream(result.stream, options.maxBytes);
    if (bytes.length !== metadata.size || result.blob.size !== metadata.size)
      throw new ObjectIntegrityError(
        'Object length changed during retrieval.',
      );
    const value = {
      ...describeObject(key, bytes, metadata.contentType, result.blob.etag),
      bytes,
    };
    return verifyObject(value, options.maxBytes, options.expectedSha256);
  }
  async delete(key: string) {
    assertObjectKey(key);
    await blob.del(key, {
      ...this.#options,
      abortSignal: AbortSignal.timeout(15000),
    });
  }
}
