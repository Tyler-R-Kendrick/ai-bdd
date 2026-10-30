import { createHash } from 'node:crypto';
import type { ObjectDescriptor, StoredObject } from './ports.ts';

export class ObjectConflictError extends Error {}
export class ObjectIntegrityError extends Error {}
export const objectDigest = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
export function assertObjectKey(key: string) {
  if (
    typeof key !== 'string' ||
    !key.length ||
    key.length > 1024 ||
    !/^[A-Za-z0-9._/-]+$/.test(key) ||
    key.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Invalid internal object key.');
  return key;
}
export function assertObjectLimit(maxBytes: number) {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    maxBytes > 512 * 1024 * 1024
  )
    throw new Error('Object reads require an explicit bound of at most512 MB.');
}
export function assertObjectType(contentType: string) {
  if (
    !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:; charset=utf-8)?$/i.test(
      contentType,
    ) ||
    contentType.length > 160
  )
    throw new Error('Invalid object content type.');
}
export function describeObject(
  key: string,
  bytes: Uint8Array,
  contentType: string,
  etag?: string,
): ObjectDescriptor {
  return {
    key,
    byteSize: bytes.byteLength,
    contentType,
    sha256: objectDigest(bytes),
    ...(etag ? { etag } : {}),
  };
}
export function verifyObject(
  value: StoredObject,
  maxBytes: number,
  expectedSha256?: string,
) {
  assertObjectLimit(maxBytes);
  if (value.byteSize !== value.bytes.byteLength || value.byteSize > maxBytes)
    throw new ObjectIntegrityError(
      'Stored object exceeds its declared byte bound.',
    );
  if (
    objectDigest(value.bytes) !== value.sha256 ||
    (expectedSha256 && value.sha256 !== expectedSha256)
  )
    throw new ObjectIntegrityError(
      'Stored object does not match its integrity digest.',
    );
  return value;
}
export async function boundedObjectStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
) {
  assertObjectLimit(maxBytes);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > maxBytes)
        throw new ObjectIntegrityError(
          'Object stream exceeded its byte bound.',
        );
      chunks.push(result.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}
