import { describe, expect, it } from 'vitest';
import { NativeT3Diagnostics, type NativeT3Event } from '../server/local/native-t3-diagnostics.ts';

describe('managed native T3 operational diagnostics', () => {
  it('projects only finite failure metadata and never logs messages, causes, paths, credentials or prompts', async () => {
    const events: NativeT3Event[] = [];
    const diagnostics = new NativeT3Diagnostics(event => { events.push(event); });
    const secret = 'synthetic-private-token-DO-NOT-LOG';
    const error = Object.assign(new Error('https://127.0.0.1/oauth?token=' + secret), {
      name: secret, code: secret, statusCode: 503,
      stderr: '/private/' + secret, cause: { message: secret },
    });
    await expect(diagnostics.run('t3-oauth', async () => { throw error; })).rejects.toBe(error);
    expect(events).toEqual([
      { phase: 't3-oauth', state: 'start' },
      { phase: 't3-oauth', state: 'failure', errorClass: 'http', status: 503 },
    ]);
    diagnostics.request([{ content: secret }, { content: [{ type: 'text', text: secret }] }]);
    diagnostics.probe('opencode-readiness', 403);
    diagnostics.failure('t3-readiness', Object.assign(new Error(secret), { cause: { code: 'ECONNREFUSED', message: secret } }));
    diagnostics.exit('opencode-launch', 127, secret);
    expect(events.at(-2)).toEqual({ phase: 't3-readiness', state: 'failure', errorClass: 'system', code: 'ECONNREFUSED' });
    expect(events.at(-1)).toEqual({ phase: 'opencode-launch', state: 'exit', exitCode: 127 });
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(events)).not.toMatch(/stderr|cause|https?:|\/private\//);
    expect(Object.isFrozen(events[0])).toBe(true);
  });
  it('isolates synchronous and asynchronous observer failures without changing success or the original operation error', async () => {
    const result = { actualOperationResult: true };
    const operationError = new Error('synthetic operation failure remains the same object');
    for (const observer of [
      () => { throw new Error('synthetic logging failure'); },
      async () => { throw new Error('synthetic asynchronous logging failure'); },
    ]) {
      const diagnostics = new NativeT3Diagnostics(observer);
      let executions = 0;
      expect(await diagnostics.run('initial-checkpoint', async () => { executions++; return result; })).toBe(result);
      await expect(diagnostics.run('inference', async () => { executions++; throw operationError; })).rejects.toBe(operationError);
      expect(executions).toBe(2);
      await Promise.resolve();
    }
  });
  it('handles hostile thrown metadata without invoking message or serialization and keeps timing metadata bounded', async () => {
    const events: NativeT3Event[] = [];
    const diagnostics = new NativeT3Diagnostics(event => { events.push(event); });
    const hostile = { get statusCode() { throw new Error('synthetic secret getter'); }, toJSON() { throw new Error('must never serialize native error'); } };
    diagnostics.failure('restore-state', hostile);
    expect(events).toEqual([{ phase: 'restore-state', state: 'failure', errorClass: 'other' }]);
    await diagnostics.run('verify-tools', async () => true);
    expect(events.at(-1)).toMatchObject({ phase: 'verify-tools', state: 'complete' });
    expect(events.at(-1)!.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(events.at(-1)!.elapsedMs).toBeLessThanOrEqual(180000);
  });
});
