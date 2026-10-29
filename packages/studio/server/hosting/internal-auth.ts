import { createHmac, timingSafeEqual } from 'node:crypto';
import { HttpError } from '../store.ts';
/** Deployment bindings do not authenticate callers; every private call also carries an expiring HMAC. */
export function internalHeaders(
  secret: string,
  path: string,
  body: string,
  now = Date.now(),
): Record<string, string> {
  if (secret.length < 32)
    throw new Error('STUDIO_JOB_SECRET must contain at least 32 characters.');
  const timestamp = String(now),
    digest = createHmac('sha256', secret)
      .update(`POST\n${path}\n${timestamp}\n${body}`)
      .digest('hex');
  return {
    'content-type': 'application/json',
    'x-studio-time': timestamp,
    'x-studio-signature': digest,
  };
}
export function assertInternalRequest(
  secret: string,
  path: string,
  body: string,
  headers: { time?: string; signature?: string },
  now = Date.now(),
) {
  if (secret.length < 32)
    throw new Error('STUDIO_JOB_SECRET must contain at least 32 characters.');
  const timestamp = Number(headers.time);
  if (
    !headers.time ||
    !/^\d{13}$/.test(headers.time) ||
    !Number.isSafeInteger(timestamp) ||
    Math.abs(now - timestamp) > 60_000 ||
    !headers.signature ||
    !/^[a-f0-9]{64}$/.test(headers.signature)
  )
    throw new HttpError(401, 'Internal request authorization failed');
  const expected = internalHeaders(secret, path, body, timestamp)[
    'x-studio-signature'
  ]!;
  if (
    !timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(headers.signature, 'hex'),
    )
  )
    throw new HttpError(401, 'Internal request authorization failed');
}
export function assertCronSecret(
  expected: string | undefined,
  authorization: string | null,
) {
  if (!expected || expected.length < 32 || !authorization)
    throw new HttpError(401, 'Maintenance authorization failed');
  const actual = Buffer.from(authorization),
    valid = Buffer.from('Bearer ' + expected);
  if (actual.length !== valid.length || !timingSafeEqual(actual, valid))
    throw new HttpError(401, 'Maintenance authorization failed');
}
