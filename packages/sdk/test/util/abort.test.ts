import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import { AiBddError } from '../../src/contracts/index.ts';
import { raceAbort } from '../../src/util/index.ts';

const listeners = (s: AbortSignal): number => getEventListeners(s, 'abort').length;
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('raceAbort: listener hygiene', () => {
  it('listens while the call is pending and stops once it resolves', async () => {
    const c = new AbortController();
    let resolveIt: (v: string) => void = () => {};
    const p = raceAbort(new Promise<string>((r) => (resolveIt = r)), c.signal, 'call');
    expect(listeners(c.signal)).toBe(1);
    resolveIt('v');
    await expect(p).resolves.toBe('v');
    expect(listeners(c.signal)).toBe(0);
  });

  it('stops listening once the call fails, and passes that very error on', async () => {
    const c = new AbortController();
    const boom = new Error('boom');
    let rejectIt: (e: Error) => void = () => {};
    const p = raceAbort(new Promise<string>((_, r) => (rejectIt = r)), c.signal, 'call');
    expect(listeners(c.signal)).toBe(1);
    rejectIt(boom);
    await expect(p).rejects.toBe(boom);
    expect(listeners(c.signal)).toBe(0);
  });

  it('the abort listener removes itself once it has fired', async () => {
    const c = new AbortController();
    const p = raceAbort(new Promise<string>(() => {}), c.signal, 'call');
    expect(listeners(c.signal)).toBe(1);
    c.abort();
    await expect(p).rejects.toBeInstanceOf(AiBddError);
    expect(listeners(c.signal)).toBe(0);
  });

  it('attaches no listener to a signal that is already aborted', async () => {
    const c = new AbortController();
    c.abort();
    await expect(raceAbort(new Promise<string>(() => {}), c.signal, 'call')).rejects.toBeInstanceOf(AiBddError);
    expect(listeners(c.signal)).toBe(0);
  });
});

describe('raceAbort: outcome', () => {
  it('rejects with an ABORTED error that names what was aborted, not retryable, without details', async () => {
    const c = new AbortController();
    const p = raceAbort(new Promise<string>(() => {}), c.signal, 'model generate');
    c.abort();
    const err = (await p.then(() => undefined, (e: unknown) => e)) as AiBddError;
    expect(err).toBeInstanceOf(AiBddError);
    expect(err.name).toBe('AiBddError');
    expect(err.code).toBe('ABORTED');
    expect(err.message).toBe('model generate aborted');
    expect(err.retryable).toBe(false);
    expect(err.details).toBeUndefined();
  });

  it('gives the same error for a signal that was aborted before the call', async () => {
    const c = new AbortController();
    c.abort();
    const err = (await raceAbort(Promise.resolve('too late'), c.signal, 'driver observe').then(() => undefined, (e: unknown) => e)) as AiBddError;
    expect(err.code).toBe('ABORTED');
    expect(err.message).toBe('driver observe aborted');
  });

  it('ignores an abort that comes after the call settled', async () => {
    const c = new AbortController();
    const p = raceAbort(Promise.resolve('ok'), c.signal, 'x');
    await expect(p).resolves.toBe('ok');
    c.abort();
    await tick();
    await expect(p).resolves.toBe('ok');
  });

  it('drops the late result of an abandoned call', async () => {
    const c = new AbortController();
    let resolveIt: (v: string) => void = () => {};
    const p = raceAbort(new Promise<string>((r) => (resolveIt = r)), c.signal, 'x');
    c.abort();
    await expect(p).rejects.toMatchObject({ code: 'ABORTED' });
    resolveIt('late');
    await tick();
    await expect(p).rejects.toMatchObject({ code: 'ABORTED' });
  });
});
