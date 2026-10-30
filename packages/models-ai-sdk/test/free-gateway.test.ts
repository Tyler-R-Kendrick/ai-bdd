import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateText, createGateway } from 'ai';
import { aiSdkModels, authorizeFreeGatewayModel, createFreeGateway, freeGatewayModels } from '../src/index.ts';
import { request } from './helpers.ts';
import { mapModelError } from '../src/errors.ts';

const id = 'owned/free';
const instant = Date.parse('2026-10-30T12:00:00Z');
const headers = { date: new Date(instant).toUTCString(), age: '0' };
const model = (pricing: unknown = { input: '0', output: '0' }, type = 'language') => ({ id, type, pricing });
const fees = () => ({ prompt: '0', completion: '0', request: '0', image: '0', image_output: '0', web_search: '0', internal_reasoning: '0', discount: 0 });
const endpoint = (overrides: Record<string, unknown> = {}) => ({ provider_name: 'owned-free', status: 0, pricing: fees(), ...overrides });
const response = (data: unknown, init: ResponseInit = {}) => Response.json(data, { ...init, headers: { ...headers, ...init.headers } });

function fixture(options: { catalog?: unknown; endpoints?: unknown; metadata?: (url: URL) => Response | Promise<Response> } = {}) {
  const metadata: URL[] = [], inference: { url: URL; body: any }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.startsWith('/v1/models')) {
      metadata.push(url);
      if (options.metadata) return options.metadata(url);
      return response(url.pathname === '/v1/models' ? (options.catalog ?? { data: [model()] }) : (options.endpoints ?? { data: { id, endpoints: [endpoint()] } }));
    }
    inference.push({ url, body: JSON.parse(String(init?.body)) });
    return response({ content: [{ type: 'text', text: 'owned completion' }], finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] });
  };
  return { fetcher, metadata, inference, options: { fetch: fetcher, now: () => instant } };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('free Gateway price authority', () => {
  it('checks every actual SDK attempt and refuses a previously free price change', async () => {
    let paid = false;
    const f = fixture({ metadata: url => response(url.pathname === '/v1/models' ? { data: [model({ input: paid ? '1' : '0', output: '0' })] } : { data: { id, endpoints: [endpoint()] } }) });
    const gateway = createFreeGateway({ ...f.options, apiKey: 'owned-protocol-key' });
    expect((await generateText({ model: gateway(id), prompt: 'synthetic', maxRetries: 0 })).text).toBe('owned completion');
    paid = true;
    await expect(generateText({ model: gateway(id), prompt: 'synthetic', maxRetries: 0 })).rejects.toThrow('zero-cost');
    expect(f.metadata).toHaveLength(3);
    expect(f.metadata.every(url => url.searchParams.get('_pricing_check') === String(instant))).toBe(true);
    expect(f.inference).toHaveLength(1);
  });

  it('guards string and explicit Gateway objects instead of delegating to a global default provider', async () => {
    const f = fixture({ catalog: { data: [model({ input: '1', output: '0' })] } });
    const unguarded = createGateway({ apiKey: 'untrusted-provider' })(id);
    for (const input of [id, unguarded]) {
      const models = aiSdkModels({ extract: input, act: input, checkgen: input, judge: input }, { gateway: { ...f.options, apiKey: 'owned-protocol-key' }, maxRetries: 0 });
      await expect(models.act.generate(request())).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE', retryable: false });
    }
    expect(f.metadata).toHaveLength(2);
    expect(f.inference).toHaveLength(0);
  });

  it.each(['missing', 'vmc/free', '/bad', 'provider/model/extra', 'provider/model?paid=true'])('refuses virtual or invalid model %s without metadata or inference', async name => {
    const f = fixture();
    await expect(authorizeFreeGatewayModel(name, 'language', undefined, f.options)).rejects.toMatchObject({ reason: 'model' });
    expect(f.metadata).toHaveLength(0);
    expect(f.inference).toHaveLength(0);
  });

  it.each([{}, { data: {} }, { data: Array.from({ length: 10001 }, () => null) }])('refuses a malformed or unbounded catalog', async catalog => {
    const f = fixture({ catalog });
    await expect(authorizeFreeGatewayModel(id, 'language', undefined, f.options)).rejects.toMatchObject({ reason: 'metadata' });
    expect(f.metadata).toHaveLength(1);
    expect(f.inference).toHaveLength(0);
  });

  it.each([
    [], [model(), model()], [null, [], 'unknown'],
    [model(undefined, 'evaluation')], [{ id, type: 'language' }],
    [model(null)], [model([])], [model({ input: '0', output: '0', varies_by_provider: true })],
    [model({ input: '0', output: '0', unpriced_fee: '0' })],
    [model({ input: '0', output: '1' })], [model({ input: '1e-9999', output: '0' })],
    [model({ input: 0, output: '0' })], [model({ input: '0', output: null })],
    [model({ input: ' 0', output: '0' })], [model({ input: '-0', output: '0' })],
  ].map(entries => ({ entries })))('refuses ambiguous, paid, rounded or unknown catalog prices', async ({ entries }) => {
    const f = fixture({ catalog: { data: entries } });
    await expect(authorizeFreeGatewayModel(id, 'language', undefined, f.options)).rejects.toMatchObject({ reason: 'pricing' });
    expect(f.metadata).toHaveLength(1);
    expect(f.inference).toHaveLength(0);
  });

  it('accepts exact textual zero variants and explicit nonvarying prices', async () => {
    const f = fixture({ catalog: { data: [model({ input: '00.000E+9999', output: '0e-9999', varies_by_provider: false })] } });
    expect(await authorizeFreeGatewayModel(id, 'language', undefined, f.options)).toEqual({ modelId: id, kind: 'language', providers: ['owned-free'], checkedAt: instant });
  });

  it.each([{}, { data: [] }, { data: { id: 'other/model', endpoints: [] } }, { data: { id, endpoints: {} } }, { data: { id, endpoints: Array.from({ length: 101 }, () => endpoint()) } }])('refuses malformed or unbounded endpoint lists', async endpoints => {
    const f = fixture({ endpoints });
    await expect(authorizeFreeGatewayModel(id, 'language', undefined, f.options)).rejects.toMatchObject({ reason: 'metadata' });
    expect(f.metadata).toHaveLength(2);
    expect(f.inference).toHaveLength(0);
  });

  it.each([
    null, [], 'endpoint', endpoint({ provider_name: 1 }), endpoint({ provider_name: '' }), endpoint({ provider_name: 'provider/override' }),
    endpoint({ status: 1 }), endpoint({ pricing: null }), endpoint({ pricing: [] }),
    endpoint({ pricing: { prompt: '0', completion: '0' } }),
    endpoint({ pricing: { ...fees(), request: '1e-9999' } }),
    endpoint({ pricing: { ...fees(), unknown_fee: '0' } }),
    endpoint({ pricing: { ...fees(), discount: '0.1' } }),
    endpoint({ pricing: { ...fees(), request: 0 } }),
    endpoint({ supports_implicit_caching: true }), endpoint({ tags: ['implicit-caching'] }),
  ])('refuses invalid, nonzero, unknown and unquoted cached endpoints', async value => {
    const f = fixture({ endpoints: { data: { id, endpoints: [value] } } });
    await expect(authorizeFreeGatewayModel(id, 'language', undefined, f.options)).rejects.toMatchObject({ reason: 'pricing' });
    expect(f.inference).toHaveLength(0);
  });

  it('admits explicit cache and optional zero fees, deduplicates providers, and excludes mixed-price slugs', async () => {
    const f = fixture({ endpoints: { data: { id, endpoints: [
      null, endpoint({ provider_name: 'z-free', supports_implicit_caching: true, pricing: { ...fees(), input_cache_read: '0', input_cache_write: '0', audio_input: '0', discount: '0' } }),
      endpoint({ provider_name: 'a-free', tags: ['implicit-caching'], pricing: { ...fees(), input_cache_read: '0' } }), endpoint({ provider_name: 'a-free' }),
      endpoint({ provider_name: 'mixed' }), endpoint({ provider_name: 'mixed', pricing: { ...fees(), completion: '1' } }),
    ] } } });
    expect((await authorizeFreeGatewayModel(id, 'language', undefined, f.options)).providers).toEqual(['a-free', 'z-free']);
  });
});

describe('bounded and cancellable public price metadata', () => {
  it.each([
    { date: '' }, { date: 'invalid' }, { date: new Date(instant - 61000).toUTCString() }, { date: new Date(instant + 6000).toUTCString() },
    { age: '61' }, { age: '-1' }, { age: 'NaN' }, { age: '0.1' },
  ])('refuses missing, stale, future or ambiguous metadata freshness %j', async freshness => {
    const f = fixture({ metadata: () => response({ data: [model()] }, { headers: freshness }) });
    await expect(authorizeFreeGatewayModel(id, 'language', undefined, f.options)).rejects.toMatchObject({ reason: 'stale-pricing' });
    expect(f.inference).toHaveLength(0);
  });

  it('refuses metadata without an HTTP Date', async () => {
    const f = fixture({ metadata: () => new Response('{}') });
    await expect(authorizeFreeGatewayModel(id, 'language', undefined, f.options)).rejects.toMatchObject({ reason: 'stale-pricing' });
    expect(f.inference).toHaveLength(0);
  });

  it('accepts an absent Age header with a fresh HTTP Date at the age boundary', async () => {
    const f = fixture({ metadata: url => {
      const r = response(url.pathname === '/v1/models' ? { data: [model()] } : { data: { id, endpoints: [endpoint()] } }, { headers: { date: new Date(instant - 60000).toUTCString() } });
      r.headers.delete('age'); return r;
    } });
    expect((await authorizeFreeGatewayModel(id, 'language', undefined, f.options)).providers).toEqual(['owned-free']);
  });

  it('uses the default clock and public fetch without authentication when no transport is injected', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(instant);
    const f = fixture();
    const fetcher = vi.fn(f.fetcher); vi.stubGlobal('fetch', fetcher);
    expect((await authorizeFreeGatewayModel(id, 'language')).checkedAt).toBe(instant);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [, init] of fetcher.mock.calls) {
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      expect(init?.redirect).toBe('error');
    }
  });

  it('prefers the dedicated public transport over the inference transport', async () => {
    const f = fixture(), forbidden = vi.fn<typeof fetch>();
    expect((await authorizeFreeGatewayModel(id, 'language', undefined, { ...f.options, metadataFetch: f.fetcher, fetch: forbidden })).providers).toEqual(['owned-free']);
    expect(forbidden).not.toHaveBeenCalled();
  });

  it.each([new Error('network unavailable'), 'transport failure'])('maps failed public fetches to safe policy errors', async error => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(error);
    await expect(authorizeFreeGatewayModel(id, 'language', undefined, { fetch: fetcher })).rejects.toMatchObject({ reason: 'metadata', message: expect.not.stringContaining(String(error)) });
  });

  it('rejects non-success metadata and a bodyless response without admitting inference', async () => {
    for (const result of [new Response('unavailable', { status: 503, headers }), new Response(null, { headers })]) {
      const f = fixture({ metadata: () => result });
      await expect(authorizeFreeGatewayModel(id, 'language', undefined, f.options)).rejects.toMatchObject({ reason: 'metadata' });
      expect(f.inference).toHaveLength(0);
    }
  });

  it('cancels rejected metadata bodies even when cancellation rejects or there is no body', async () => {
    let canceled = 0;
    for (const status of [200, 503]) {
      const body = new ReadableStream({ cancel() { canceled++; throw new Error('cleanup failed'); } });
      const f = fixture({ metadata: () => new Response(body, { status, headers: status === 200 ? { date: '' } : headers }) });
      await expect(authorizeFreeGatewayModel(id, 'language', undefined, f.options)).rejects.toMatchObject({ reason: status === 200 ? 'stale-pricing' : 'metadata' });
    }
    const noBody = fixture({ metadata: () => new Response(null, { headers: { date: '' } }) });
    await expect(authorizeFreeGatewayModel(id, 'language', undefined, noBody.options)).rejects.toMatchObject({ reason: 'stale-pricing' });
    expect(canceled).toBe(2);
  });

  it('assembles streamed metadata chunks and releases the reader lock', async () => {
    const bodies: ReadableStream<Uint8Array>[] = [];
    const f = fixture({ metadata: url => {
      const bytes = new TextEncoder().encode(JSON.stringify(url.pathname === '/v1/models' ? { data: [model()] } : { data: { id, endpoints: [endpoint()] } }));
      const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes.slice(0, 10)); controller.enqueue(bytes.slice(10)); controller.close(); } });
      bodies.push(body); return new Response(body, { headers });
    } });
    await authorizeFreeGatewayModel(id, 'language', undefined, f.options);
    expect(bodies.every(body => !body.locked)).toBe(true);
  });

  it.each(['invalid JSON', 'oversize', 'read failure'])('rejects %s and releases the metadata reader', async mode => {
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      if (mode === 'read failure') controller.error(new Error('private read failure'));
      else controller.enqueue(mode === 'oversize' ? new Uint8Array(4 * 1024 * 1024 + 1) : new TextEncoder().encode('invalid JSON'));
      if (mode !== 'read failure') controller.close();
    } });
    const f = fixture({ metadata: () => new Response(body, { headers }) });
    await expect(authorizeFreeGatewayModel(id, 'language', undefined, f.options)).rejects.toMatchObject({ reason: 'metadata' });
    expect(body.locked).toBe(false);
    expect(f.inference).toHaveLength(0);
  });

  it('does not fetch metadata for an already-aborted caller', async () => {
    const controller = new AbortController(); controller.abort(new Error('owned preflight abort'));
    const f = fixture();
    await expect(authorizeFreeGatewayModel(id, 'language', controller.signal, f.options)).rejects.toThrow('owned preflight abort');
    expect(f.metadata).toHaveLength(0);
  });

  it('does not wait for a blocked transport and cleans up a late response', async () => {
    const controller = new AbortController();
    let resolve!: (value: Response) => void, canceled = false;
    const pending = authorizeFreeGatewayModel(id, 'language', controller.signal, { fetch: () => new Promise<Response>(r => { resolve = r; }) });
    controller.abort(new Error('owned fetch abort'));
    await expect(pending).rejects.toThrow('owned fetch abort');
    resolve(new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers }));
    await Promise.resolve(); await Promise.resolve();
    expect(canceled).toBe(true);
  });

  it('bounds a transport that ignores the metadata deadline', async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const pending = authorizeFreeGatewayModel(id, 'language', undefined, { fetch: () => new Promise(() => {}) });
    deadline.abort(new DOMException('owned metadata deadline', 'TimeoutError'));
    await expect(pending).rejects.toMatchObject({ reason: 'metadata' });
  });

  it('preserves caller aborts while canceling a blocked metadata reader', async () => {
    const controller = new AbortController();
    let reading!: () => void, canceled = false;
    const started = new Promise<void>(resolve => { reading = resolve; });
    const body = new ReadableStream<Uint8Array>({ pull() { reading(); return new Promise(() => {}); }, cancel() { canceled = true; throw new Error('cleanup failed'); } });
    const f = fixture({ metadata: () => new Response(body, { headers }) });
    const pending = authorizeFreeGatewayModel(id, 'language', controller.signal, f.options);
    await started; controller.abort(new Error('owned reader abort'));
    await expect(pending).rejects.toThrow('owned reader abort');
    expect(canceled).toBe(true);
    expect(body.locked).toBe(false);
  });
});

describe('trusted Gateway transport registration', () => {
  it.each([
    'https://paid-proxy.example.test/v4/ai',
    'https://ai-gateway.vercel.sh/other-api',
    'https://user@ai-gateway.vercel.sh/v4/ai',
    'https://:password@ai-gateway.vercel.sh/v4/ai',
    'https://ai-gateway.vercel.sh/v4/ai?paid=true',
    'https://ai-gateway.vercel.sh/v4/ai#paid',
    'http://ai-gateway.vercel.sh/v4/ai',
    'http://127.0.0.1:9123/owned',
  ])('refuses unverifiable inference registration %s', baseURL => {
    const f = fixture();
    expect(() => createFreeGateway({ ...f.options, baseURL })).toThrow('zero-cost');
    expect(f.metadata).toHaveLength(0);
    expect(f.inference).toHaveLength(0);
  });

  it('refuses non-HTTP loopback protocols even with an owned metadata transport', () => {
    const f = fixture();
    expect(() => createFreeGateway({ ...f.options, metadataFetch: f.fetcher, baseURL: 'ftp://localhost/owned' })).toThrow('zero-cost');
  });

  it('registers the canonical Gateway without enabling an inference call', () => {
    expect(createFreeGateway().languageModel(id).modelId).toBe(id);
  });
});

describe('public free-model discovery and SDK error contract', () => {
  it.each([{}, { data: {} }])('rejects malformed discovery catalogs', async catalog => {
    const f = fixture({ catalog });
    await expect(freeGatewayModels('language', f.options)).rejects.toMatchObject({ reason: 'metadata' });
  });

  it('rejects an unbounded set of discovery candidates before endpoint fan-out', async () => {
    const f = fixture({ catalog: { data: Array.from({ length: 101 }, (_, n) => ({ ...model(), id: `owned/free-${n}` })) } });
    await expect(freeGatewayModels('language', f.options)).rejects.toMatchObject({ reason: 'metadata' });
    expect(f.metadata).toHaveLength(1);
  });

  it('lists only models whose current kind, model ID and endpoint prices all verify', async () => {
    const entries = [model(), model({ input: '1', output: '0' }), { ...model(), id: 1 }, { ...model(), id: 'bad-id' }, null];
    // A duplicate paid catalog ID invalidates that model even when its free entry looked eligible.
    const f = fixture({ catalog: { data: entries } });
    expect(await freeGatewayModels('language', f.options)).toEqual([]);
    const good = fixture();
    expect(await freeGatewayModels('language', good.options)).toEqual([id]);
    expect(await freeGatewayModels('evaluation', good.options)).toEqual([]);
  });

  it('limits a cyclic or over-deep error cause chain without looping', () => {
    const cyclic: { cause?: unknown } = {}; cyclic.cause = cyclic;
    expect(mapModelError(cyclic, { purpose: 'act', modelId: id })).toMatchObject({ code: 'MODEL_UNAVAILABLE' });
  });
});
