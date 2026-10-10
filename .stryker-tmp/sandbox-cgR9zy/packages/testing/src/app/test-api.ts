// @ts-nocheck
import { timingSafeEqual } from 'node:crypto';
import type { JsonValue } from '@ai-bdd/sdk/contracts';
import { ACME_FLAGS, dispatch, type AcmeEvent, type AcmePlan, type AcmeState } from './model.ts';

/**
 * The Acme test API (SPEC 13.1), shared by the HTTP server and the fake driver's `request()`.
 *   POST /__test/reset
 *   POST /__test/seed {plan?, unpaid?, flags?, signedIn?}
 * Both require the header `x-acme-test-token`.
 */

export const TEST_TOKEN_HEADER = 'x-acme-test-token';

export interface TestApiRequest {
  method: string;
  path: string;
  headers?: Readonly<Record<string, string | undefined>> | undefined;
  body?: unknown;
}

export interface TestApiResponse {
  status: number;
  body: JsonValue;
  /** New session state when the call changed it. */
  state?: AcmeState;
}

function tokenOk(given: string | undefined, expected: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function header(headers: TestApiRequest['headers'], name: string): string | undefined {
  if (headers === undefined) return undefined;
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return v;
  return undefined;
}

const bad = (message: string): TestApiResponse => ({ status: 400, body: { error: message } });

const SEED_KEYS = ['plan', 'unpaid', 'flags', 'signedIn'];

function parseSeed(body: unknown): Extract<AcmeEvent, { type: 'seed' }> | string {
  if (body === undefined || body === null) return { type: 'seed' };
  if (typeof body !== 'object' || Array.isArray(body)) return 'body must be a JSON object';
  const o = body as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!SEED_KEYS.includes(k)) return `unknown field "${k}"`;
  const ev: { type: 'seed'; plan?: AcmePlan; unpaid?: number; flags?: string[]; signedIn?: boolean } = { type: 'seed' };
  if (o['plan'] !== undefined) {
    if (o['plan'] !== 'free' && o['plan'] !== 'pro') return 'plan must be "free" or "pro"';
    ev.plan = o['plan'];
  }
  if (o['unpaid'] !== undefined) {
    const u = o['unpaid'];
    if (typeof u !== 'number' || !Number.isInteger(u) || u < 0 || u > 1000) return 'unpaid must be an integer from 0 to 1000';
    ev.unpaid = u;
  }
  if (o['flags'] !== undefined) {
    const f = o['flags'];
    if (!Array.isArray(f) || f.some((x) => typeof x !== 'string' || !(ACME_FLAGS as readonly string[]).includes(x))) {
      return `flags must be an array of: ${ACME_FLAGS.join(', ')}`;
    }
    ev.flags = f as string[];
  }
  if (o['signedIn'] !== undefined) {
    if (typeof o['signedIn'] !== 'boolean') return 'signedIn must be a boolean';
    ev.signedIn = o['signedIn'];
  }
  return ev;
}

export function handleTestApi(req: TestApiRequest, ctx: { testToken: string; state: AcmeState; now: number }): TestApiResponse {
  const path = req.path.split('?')[0] ?? '';
  if (!path.startsWith('/__test/')) return { status: 404, body: { error: 'not found' } };
  if (!tokenOk(header(req.headers, TEST_TOKEN_HEADER), ctx.testToken)) {
    return { status: 401, body: { error: `missing or invalid ${TEST_TOKEN_HEADER} header` } };
  }
  const method = req.method.toUpperCase();
  if (path === '/__test/reset') {
    if (method !== 'POST') return { status: 405, body: { error: 'use POST' } };
    return { status: 200, body: { ok: true }, state: dispatch(ctx.state, { type: 'reset' }, ctx.now).state };
  }
  if (path === '/__test/seed') {
    if (method !== 'POST') return { status: 405, body: { error: 'use POST' } };
    const ev = parseSeed(req.body);
    if (typeof ev === 'string') return bad(ev);
    const state = dispatch(ctx.state, ev, ctx.now).state;
    return {
      status: 200,
      body: { ok: true, plan: state.plan, unpaid: state.unpaid, flags: [...state.flags], signedIn: state.signedIn },
      state,
    };
  }
  return { status: 404, body: { error: 'not found' } };
}
