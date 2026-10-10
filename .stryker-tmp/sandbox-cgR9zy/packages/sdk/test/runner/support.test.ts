// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { AiBddError } from '../../src/contracts/index.ts';
import { Semaphore } from '../../src/runner/sync.ts';
import { ObservationRing, dedupe, errorPayload, isFuzzyTagged, redactPayload, toJson } from '../../src/runner/support.ts';
import { FakeRedactor } from './doubles/collaborators.ts';
import { buildObservation, toNodes } from './doubles/world.ts';

describe('Semaphore (async mutex for exclusive resources)', () => {
  it('R-RN2: serves waiters in FIFO order and never exceeds its limit', async () => {
    const s = new Semaphore(1);
    const order: number[] = [];
    let active = 0;
    let max = 0;
    const work = async (i: number): Promise<void> => {
      const release = await s.acquire();
      active += 1;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 2));
      order.push(i);
      active -= 1;
      release();
    };
    await Promise.all([0, 1, 2, 3, 4].map(work));
    expect(order).toEqual([0, 1, 2, 3, 4]);
    expect(max).toBe(1);
  });

  it('R-RN2: a limit of N admits N holders and release is idempotent', async () => {
    const s = new Semaphore(2);
    const a = await s.acquire();
    const b = await s.acquire();
    let third = false;
    const pending = s.acquire().then((release) => {
      third = true;
      return release;
    });
    await Promise.resolve();
    expect(third).toBe(false);
    a();
    a(); // double release must not hand out a second slot
    const release = await pending;
    expect(third).toBe(true);
    let fourth = false;
    void s.acquire().then(() => void (fourth = true));
    await new Promise((r) => setTimeout(r, 1));
    expect(fourth).toBe(false);
    b();
    release();
  });

  it('R-RN3: an aborted waiter is removed from the queue and rejects with ABORTED', async () => {
    const s = new Semaphore(1);
    const held = await s.acquire();
    const c = new AbortController();
    const waiter = s.acquire(c.signal);
    c.abort();
    await expect(waiter).rejects.toMatchObject({ code: 'ABORTED' });
    const next = s.acquire();
    held();
    const release = await next; // not blocked by the dead waiter
    release();
  });

  it('R-RN3: acquiring with an already aborted signal rejects immediately', async () => {
    const c = new AbortController();
    c.abort();
    await expect(new Semaphore(1).acquire(c.signal)).rejects.toBeInstanceOf(AiBddError);
  });
});

describe('support helpers', () => {
  it('R-SE1: errorPayload keeps AiBddError fields, duck-types foreign errors and falls back to INTERNAL', () => {
    expect(errorPayload(new AiBddError('MODEL_UNAVAILABLE', 'x'))).toMatchObject({ code: 'MODEL_UNAVAILABLE', retryable: true });
    expect(errorPayload({ code: 'STALE_REF', message: 'old', details: { a: 1 } })).toMatchObject({ code: 'STALE_REF', message: 'old', details: { a: 1 } });
    expect(errorPayload(Object.assign(new Error('stop'), { name: 'AbortError' })).code).toBe('ABORTED');
    expect(errorPayload(new Error('plain'))).toMatchObject({ code: 'INTERNAL', message: 'plain' });
    expect(errorPayload('str')).toMatchObject({ code: 'INTERNAL', message: 'str' });
    expect(errorPayload({ code: 'NOT_A_CODE', message: 'm' }).code).toBe('INTERNAL');
  });

  it('R-SE1: redactPayload scrubs message and details', () => {
    const red = new FakeRedactor({ pw: 'correct-horse-battery' });
    const p = redactPayload(red, { code: 'INTERNAL', message: 'saw correct-horse-battery', retryable: false, details: { v: ['correct-horse-battery'] } });
    expect(JSON.stringify(p)).not.toContain('correct-horse-battery');
    expect(JSON.stringify(p)).toContain('<secret:pw>');
  });

  it('R-CH3: the @fuzzy tag is recognised with or without the at sign', () => {
    expect(isFuzzyTagged(['a', '@fuzzy'])).toBe(true);
    expect(isFuzzyTagged(['fuzzy'])).toBe(true);
    expect(isFuzzyTagged(['billing'])).toBe(false);
  });

  it('R-CH2: dedupe keeps first occurrences in order; toJson round-trips interface values', () => {
    expect(dedupe(['a', 'b', 'a'])).toEqual(['a', 'b']);
    expect(toJson({ a: undefined, b: [1] })).toEqual({ b: [1] });
    expect(toJson(undefined)).toBeNull();
  });

  it('R-RN1: the observation ring only returns settled observations and honours pixel needs', () => {
    const ring = new ObservationRing();
    const plain = buildObservation(toNodes([{ role: 'heading', name: 'A' }]), { route: '/', revision: 1 });
    const shot = buildObservation(toNodes([{ role: 'heading', name: 'A' }]), { route: '/', revision: 2, pixels: true });
    expect(ring.take(false)).toBeUndefined();
    ring.remember(plain, false);
    expect(ring.take(false)).toBeUndefined();
    ring.remember(plain, true);
    expect(ring.take(false)).toBe(plain);
    expect(ring.take(true)).toBeUndefined();
    ring.remember(shot, true);
    expect(ring.take(true)).toBe(shot);
    ring.invalidate();
    expect(ring.take(false)).toBeUndefined();
  });
});
