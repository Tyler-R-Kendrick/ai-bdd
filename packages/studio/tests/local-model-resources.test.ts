import { afterEach, describe, expect, it } from 'vitest';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { LOCAL_MODELS, DEFAULT_LOCAL_MODEL_ID } from '../server/local/catalog.ts';
import { LOCAL_DEFAULT_RSS_BYTES, LOCAL_MAX_RSS_BYTES, localModelResources, workerResourceConfiguration } from '../server/local/model-resources.mjs';

const candidate = 'qwen3-0.6b-q4-k-m';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function configuration(modelId = candidate, extra = {}) {
  const registered = localModelResources(modelId);
  return { directory: '/missing-owned-resource-fixture-' + randomUUID(), file: registered.file, rssCeilingBytes: registered.rssCeilingBytes, useMmap: registered.useMmap, ...extra };
}

describe('immutable registered local model resource policy (no weights)', () => {
  it('keeps default/older budgets and caps only the Coder allocation at 2560MiB', () => {
    expect(LOCAL_DEFAULT_RSS_BYTES).toBe(1073741824); expect(LOCAL_MAX_RSS_BYTES).toBe(2684354560);
    for (const model of LOCAL_MODELS) {
      const resource = localModelResources(model.id);
      expect(resource.rssCeilingBytes).toBe(model.id === 'qwen2.5-coder-1.5b-instruct-q4-k-m' ? 2684354560 : model.id === candidate ? 1610612736 : 1073741824);
      expect(resource.useMmap).toBe(model.id === 'qwen2.5-coder-1.5b-instruct-q4-k-m');
      expect(Object.isFrozen(resource)).toBe(true); expect(Object.isFrozen(resource.file)).toBe(true);
    }
    expect(() => { (localModelResources(candidate) as any).rssCeilingBytes = Number.MAX_SAFE_INTEGER; }).toThrow();
    expect(() => localModelResources('unregistered')).toThrow();
  });

  it.each([undefined, null, NaN, Infinity, -Infinity, 0, 1.5, 16777215, 1610612737, Number.MAX_SAFE_INTEGER])('refuses malformed or excessive private ceilings %s', rssCeilingBytes => {
    expect(() => workerResourceConfiguration(candidate, configuration(candidate, { rssCeilingBytes }))).toThrow();
  });

  it('allows private lowering but refuses default-model raises and candidate/file identity mismatch', () => {
    expect(workerResourceConfiguration(candidate, configuration(candidate, { rssCeilingBytes: 16777216 })).rssCeilingBytes).toBe(16777216);
    expect(() => workerResourceConfiguration(DEFAULT_LOCAL_MODEL_ID, configuration(DEFAULT_LOCAL_MODEL_ID, { rssCeilingBytes: 1610612736 }))).toThrow();
    expect(() => workerResourceConfiguration(candidate, configuration(candidate, { file: localModelResources(DEFAULT_LOCAL_MODEL_ID).file }))).toThrow();
    expect(() => workerResourceConfiguration(candidate, configuration(candidate, { directory: 'relative' }))).toThrow();
  });
  it.each([undefined, NaN, Infinity, 2684354561, Number.MAX_SAFE_INTEGER])('refuses malformed or over-cap Pro Coder ceilings %s', rssCeilingBytes => {
    const coder = 'qwen2.5-coder-1.5b-instruct-q4-k-m';
    expect(() => workerResourceConfiguration(coder, configuration(coder, { rssCeilingBytes }))).toThrow();
  });
  it.each([undefined, null, 0, 1, 'true', {}, false])('refuses a malformed or mismatched mapped-model flag %j', useMmap => {
    const coder = 'qwen2.5-coder-1.5b-instruct-q4-k-m';
    expect(() => workerResourceConfiguration(coder, configuration(coder, { useMmap }))).toThrow();
  });
  it('refuses enabling mapping for an older model without changing its registered policy', () => {
    expect(() => workerResourceConfiguration(DEFAULT_LOCAL_MODEL_ID, configuration(DEFAULT_LOCAL_MODEL_ID, { useMmap: true }))).toThrow();
    expect(() => { (localModelResources('qwen2.5-coder-1.5b-instruct-q4-k-m') as any).useMmap = false; }).toThrow();
  });
});

/** Actual shipping worker and advanced IPC. Missing assets stop before native binding or weights. */
async function worker() {
  const child = fork(new URL('../server/local/studio-local-worker.mjs', import.meta.url), [], {
    execArgv: [], serialization: 'advanced', env: { PATH: '/usr/local/bin:/usr/bin:/bin' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  cleanup.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  });
  async function request(modelId: string, config: unknown) {
    const events: any[] = [];
    return await new Promise<any[]>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Controlled worker resource deadline')); }, 5000);
      const onMessage = (event: any) => {
        events.push(event);
        if (event.type === 'error' || event.type === 'result') { clearTimeout(timeout); child.off('message', onMessage); resolve(events); }
      };
      child.on('message', onMessage);
      child.once('error', reject);
      child.send({ modelId, configuration: config, prompt: 'Never reaches inference', system: '', history: [], maxTokens: 16 });
    });
  }
  return { child, request };
}

describe('shipping worker registered ceilings through real advanced IPC', () => {
  it.each([DEFAULT_LOCAL_MODEL_ID, candidate, 'qwen2.5-coder-1.5b-instruct-q4-k-m'])('admits exactly the registered %s ceiling then refuses missing assets without loading weights', async modelId => {
    const running = await worker();
    const events = await running.request(modelId, configuration(modelId));
    expect(events[0]).toMatchObject({ type: 'phase', phase: 'worker-start', rssCeilingBytes: localModelResources(modelId).rssCeilingBytes, useMmap: localModelResources(modelId).useMmap });
    expect(events.at(-1)).toEqual({ type: 'error', code: 'inference' });
    expect(events.some(event => ['weights-verified', 'binding-loaded', 'inference-start'].includes(event.phase))).toBe(false);
  });

  it.each([NaN, Infinity, 1610612737])('refuses invalid advanced-IPC ceiling %s before any worker/model phase', async rssCeilingBytes => {
    const running = await worker();
    expect(await running.request(candidate, configuration(candidate, { rssCeilingBytes }))).toEqual([{ type: 'error', code: 'configuration' }]);
  });

  it('refuses rebinding a live candidate worker to the default model or another ceiling', async () => {
    const running = await worker();
    await running.request(candidate, configuration(candidate));
    expect(await running.request(DEFAULT_LOCAL_MODEL_ID, configuration(DEFAULT_LOCAL_MODEL_ID))).toEqual([{ type: 'error', code: 'configuration' }]);
  });

  it('refuses changing only a live worker\'s configured ceiling', async () => {
    const running = await worker(), config = configuration(candidate);
    await running.request(candidate, config);
    expect(await running.request(candidate, { ...config, rssCeilingBytes: 1073741824 })).toEqual([{ type: 'error', code: 'configuration' }]);
  });

  it('includes actual sampled RSS and selected ceiling when the private guard is lowered', async () => {
    const running = await worker();
    const events = await running.request(candidate, configuration(candidate, { rssCeilingBytes: 16777216 }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', code: 'memory', rssCeilingBytes: 16777216 });
    expect(Number.isSafeInteger(events[0].rss)).toBe(true); expect(events[0].rss).toBeGreaterThan(16777216);
  });
  it('refuses a mapped model private-IPC flag flip before any worker phase', async () => {
    const running = await worker(), coder = 'qwen2.5-coder-1.5b-instruct-q4-k-m';
    expect(await running.request(coder, configuration(coder, { useMmap: false }))).toEqual([{ type: 'error', code: 'configuration' }]);
  });
});
