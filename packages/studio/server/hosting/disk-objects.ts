import { link, mkdir, open, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ObjectStore } from './ports.ts';
import {
  assertObjectKey,
  assertObjectLimit,
  assertObjectType,
  describeObject,
  ObjectConflictError,
  ObjectIntegrityError,
  verifyObject,
} from './objects.ts';

/** Local adapter only; hosted composition refuses this ephemeral storage option. */
export class DiskObjectStore implements ObjectStore {
  readonly provider = 'disk';
  constructor(readonly directory: string) {}
  private path(key: string) {
    assertObjectKey(key);
    const root = resolve(this.directory);
    const target = resolve(root, key);
    if (!target.startsWith(root + sep))
      throw new Error('Object key leaves its storage root.');
    return target;
  }
  async put(
    key: string,
    bytes: Uint8Array,
    { contentType }: { contentType: string },
  ) {
    assertObjectLimit(bytes.byteLength);
    assertObjectType(contentType);
    const target = this.path(key);
    const descriptor = describeObject(key, bytes, contentType);
    const header = Buffer.from(JSON.stringify(descriptor));
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(header.byteLength);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.pending-${randomUUID()}`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(Buffer.concat([prefix, header, bytes]));
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await link(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = await this.get(key, {
          maxBytes: Math.max(bytes.byteLength, 1),
        }).catch(() => null);
        if (
          !existing ||
          existing.sha256 !== descriptor.sha256 ||
          existing.contentType !== contentType
        )
          throw new ObjectConflictError(
            'An immutable object already exists with different content.',
          );
        return { ...descriptor, etag: descriptor.sha256 };
      }
      return { ...descriptor, etag: descriptor.sha256 };
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  async get(
    key: string,
    options: { maxBytes: number; expectedSha256?: string },
  ) {
    assertObjectLimit(options.maxBytes);
    const target = this.path(key);
    let file;
    try {
      file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > options.maxBytes + 2052)
        throw new ObjectIntegrityError('Stored object exceeds its byte bound.');
      const prefix = Buffer.alloc(4);
      if ((await file.read(prefix, 0, 4, 0)).bytesRead !== 4)
        throw new ObjectIntegrityError('Stored object header is incomplete.');
      const length = prefix.readUInt32LE(0);
      if (length < 2 || length > 2048 || stat.size < 4 + length)
        throw new ObjectIntegrityError('Stored object header is invalid.');
      const header = Buffer.alloc(length);
      await file.read(header, 0, length, 4);
      const descriptor = JSON.parse(header.toString());
      if (descriptor.key !== key)
        throw new ObjectIntegrityError(
          'Stored object key does not match its metadata.',
        );
      const bytes = Buffer.alloc(stat.size - 4 - length);
      await file.read(bytes, 0, bytes.length, 4 + length);
      return verifyObject(
        { ...descriptor, bytes, etag: descriptor.sha256 },
        options.maxBytes,
        options.expectedSha256,
      );
    } finally {
      await file.close();
    }
  }
  async delete(key: string) {
    await unlink(this.path(key)).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
}
