import { randomBytes } from 'node:crypto';

/** W3C trace context: one trace per scenario, one span per step. */
export interface TraceContext {
  traceId: string;
  spanId: string;
  traceparent: string;
}

export function newTrace(): { traceId: string } {
  return { traceId: randomBytes(16).toString('hex') };
}

export function span(traceId: string): TraceContext {
  const spanId = randomBytes(8).toString('hex');
  return { traceId, spanId, traceparent: `00-${traceId}-${spanId}-01` };
}

export function parseTraceparent(header: string | undefined): TraceContext | undefined {
  if (!header) return undefined;
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/u.exec(header.trim());
  if (!match) return undefined;
  return { traceId: match[1]!, spanId: match[2]!, traceparent: header.trim() };
}
