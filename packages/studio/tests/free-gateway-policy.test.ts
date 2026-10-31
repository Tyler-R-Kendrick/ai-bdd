import { describe, expect, it } from 'vitest';
import { generateText } from 'ai';
import { authorizeFreeGatewayModel, createFreeGateway, freeGatewayModels } from '@ai-bdd/models-ai-sdk';
import { decisionSettingsFromEnv } from '../server/decisions/settings.ts';
import { integrationSettingsFromEnv } from '../server/integrations/settings.ts';
const id = 'fixture/free-model';
const response = (value: unknown, age = 0) => Response.json(value, { headers: { date: new Date(Date.now() - age).toUTCString(), age: String(Math.floor(age / 1000)) } });
function fixture(options: { model?: any; endpoints?: any[]; age?: number; unavailable?: boolean } = {}) {
  const calls: { url: URL; init?: RequestInit }[] = [], inference: any[] = [];
  const endpoint = { provider_name: 'owned-free', status: 0, pricing: { prompt: '0', completion: '0', request: '0', image: '0', image_output: '0', web_search: '0', internal_reasoning: '0', discount: 0 } };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url, ...(init ? { init } : {}) });
    if (url.pathname === '/v1/models') return options.unavailable ? response({}, 0) : response({ data: [options.model ?? { id, type: 'language', pricing: { input: '0', output: '0' } }] }, options.age);
    if (url.pathname.endsWith('/endpoints')) return response({ data: { id, endpoints: options.endpoints ?? [endpoint] } }, options.age);
    inference.push(JSON.parse(String(init?.body)));
    return response({ content: [{ type: 'text', text: '4' }], finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 4, noCache: 4, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] });
  };
  return { fetcher, calls, inference, endpoint };
}
describe('free-only Gateway request boundary', () => {
  it('uses actual SDK generation with freshly read metadata, explicit free providers and no fallback/BYOK', async () => {
    const f = fixture(), gateway = createFreeGateway({ apiKey: 'owned-protocol-fixture', fetch: f.fetcher });
    const result = await generateText({ model: gateway(id), prompt: '2+2', maxRetries: 0 });
    expect(result.text).toBe('4');
    expect(f.inference).toHaveLength(1);
    expect(f.inference[0].providerOptions).toEqual({ gateway: { only: ['owned-free'], models: [], byok: {} } });
    expect(f.calls.slice(0, 2).every(call => call.url.searchParams.has('_pricing_check'))).toBe(true);
    expect(f.calls.slice(0, 2).every(call => !new Headers(call.init?.headers).has('authorization'))).toBe(true);
    expect(f.calls.every(call => call.init?.redirect === 'error')).toBe(true);
  });
  it.each([
    { input: '0.000001', output: '0' }, { input: '0', output: '1' },
    { input: '', output: '0' }, { input: null, output: '0' },
    { input: '0', output: '0', varies_by_provider: true },
    { input: '0', output: '0', unknown_fee: '0' },
    { input: '1e-9999', output: '0' },
  ])('refuses nonzero, unknown or ambiguous catalog pricing before inference %j', async pricing => {
    const f = fixture({ model: { id, type: 'language', pricing } });
    await expect(authorizeFreeGatewayModel(id, 'language', undefined, { fetch: f.fetcher })).rejects.toMatchObject({ code: 'FREE_MODEL_REQUIRED' });
    expect(f.inference).toHaveLength(0);
    expect(f.calls).toHaveLength(1);
  });
  it.each(['request', 'image', 'image_output', 'web_search', 'internal_reasoning', 'input_cache_read', 'input_cache_write', 'unknown_fee'])('refuses endpoint fee %s before inference', async key => {
    const base = fixture().endpoint;
    const f = fixture({ endpoints: [{ ...base, pricing: { ...base.pricing, [key]: '0.01' } }] });
    await expect(authorizeFreeGatewayModel(id, 'language', undefined, { fetch: f.fetcher })).rejects.toMatchObject({ code: 'FREE_MODEL_REQUIRED' });
    expect(f.inference).toHaveLength(0);
  });
  it('excludes an entire provider slug when another endpoint under that slug is paid', async () => {
    const base = fixture().endpoint;
    const f = fixture({ endpoints: [base, { ...base, pricing: { ...base.pricing, completion: '1' } }, { ...base, provider_name: 'other-free' }] });
    expect((await authorizeFreeGatewayModel(id, 'language', undefined, { fetch: f.fetcher })).providers).toEqual(['other-free']);
  });
  it('does not reuse a previously free price after an upstream price change', async () => {
    let paid = false;
    const f = fixture(), fetcher: typeof fetch = async (input, init) => {
      const r = await f.fetcher(input, init);
      if (new URL(String(input)).pathname === '/v1/models' && paid) return response({ data: [{ id, type: 'language', pricing: { input: '1', output: '0' } }] });
      return r;
    };
    const gateway = createFreeGateway({ apiKey: 'owned-protocol-fixture', fetch: fetcher });
    await generateText({ model: gateway(id), prompt: 'first', maxRetries: 0 }); paid = true;
    await expect(generateText({ model: gateway(id), prompt: 'second', maxRetries: 0 })).rejects.toThrow('zero-cost');
    expect(f.inference).toHaveLength(1);
  });
  it.each<any>([{ gateway: { models: ['paid/model'] } }, { gateway: { byok: { provider: [{ apiKey: 'refused' }] } } }, { gateway: { serviceTier: 'priority' } }, { gateway: { only: ['paid-provider'] } }, { anotherProvider: {} }])('refuses caller routing changes before inference %j', async providerOptions => {
    const f = fixture(), gateway = createFreeGateway({ apiKey: 'owned-protocol-fixture', fetch: f.fetcher });
    await expect(generateText({ model: gateway(id), prompt: 'test', providerOptions, maxRetries: 0 })).rejects.toThrow();
    expect(f.inference).toHaveLength(0);
  });
  it('refuses stale metadata and virtual or unknown models', async () => {
    const f = fixture({ age: 120000 });
    await expect(authorizeFreeGatewayModel(id, 'language', undefined, { fetch: f.fetcher })).rejects.toMatchObject({ reason: 'stale-pricing' });
    await expect(authorizeFreeGatewayModel('vmc/pretend-free', 'language', undefined, { fetch: f.fetcher })).rejects.toMatchObject({ reason: 'model' });
    const fresh = fixture();
    await expect(authorizeFreeGatewayModel('fixture/unknown', 'language', undefined, { fetch: fresh.fetcher })).rejects.toMatchObject({ reason: 'pricing' });
  });
  it('filters advertised models through endpoint prices', async () => {
    const f = fixture();
    expect(await freeGatewayModels('language', { fetch: f.fetcher })).toEqual([id]);
  });
  it('rejects missing fee dimensions and arbitrary priced proxy origins', async () => {
    const f = fixture({ endpoints: [{ provider_name: 'owned-free', status: 0, pricing: { prompt: '0', completion: '0' } }] });
    await expect(authorizeFreeGatewayModel(id, 'language', undefined, { fetch: f.fetcher })).rejects.toMatchObject({ reason: 'pricing' });
    expect(() => createFreeGateway({ baseURL: 'https://paid-proxy.example.test/v4/ai' })).toThrow('zero-cost');
    expect(() => createFreeGateway({ baseURL: 'https://ai-gateway.vercel.sh/another-api' })).toThrow('zero-cost');
  });
  it('rejects a tiny positive endpoint fee without numeric underflow', async () => {
    const base = fixture().endpoint;
    const f = fixture({ endpoints: [{ ...base, pricing: { ...base.pricing, request: '1e-9999' } }] });
    await expect(authorizeFreeGatewayModel(id, 'language', undefined, { fetch: f.fetcher })).rejects.toMatchObject({ reason: 'pricing' });
    expect(f.inference).toHaveLength(0);
  });
  it('refuses an SDK endpoint whose foreign prefix has the same length', async () => {
    const f = fixture();
    const gateway = createFreeGateway({ apiKey: 'owned-sdk-fixture', fetch: f.fetcher });
    const model = gateway(id);
    // A misconfigured SDK endpoint must still be checked at the actual fetch boundary.
    (model as any).config.baseURL = 'https://ai-gateway.vercel.sh/evilxx';
    await expect(generateText({ model, prompt: 'owned fixture', maxRetries: 0 })).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
    expect(f.inference).toHaveLength(0);
  });
  it('aborts blocked metadata without waiting for an uncooperative transport', async () => {
    const controller = new AbortController();
    const pending = authorizeFreeGatewayModel(id, 'language', controller.signal, { fetch: async () => new Promise(() => {}) });
    controller.abort(new Error('owned cancellation'));
    await expect(pending).rejects.toThrow('owned cancellation');
  });
  it('aborts a blocked metadata body and cancels its stream before inference', async () => {
    const controller = new AbortController();
    let cancelled = false;
    const pending = authorizeFreeGatewayModel(id, 'language', controller.signal, { fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { date: new Date().toUTCString(), age: '0' } }) });
    await new Promise(resolve => setTimeout(resolve, 5));
    controller.abort(new Error('owned stream cancellation'));
    await expect(pending).rejects.toThrow('owned stream cancellation');
    expect(cancelled).toBe(true);
  });
  it('keeps local decisions as default and refuses unpriced production agent/model registrations', () => {
    expect(decisionSettingsFromEnv({ NODE_ENV: 'production' }).defaultProfile.provider).toBe('llama-cpp-cpu');
    expect(decisionSettingsFromEnv({ NODE_ENV: 'production' }).evaluation).toBeUndefined();
    for (const env of [{ OPENAI_API_KEY: 'refused' }, { JEV_API_KEY: 'refused' }])
      expect(() => decisionSettingsFromEnv({ NODE_ENV: 'production', ...env })).toThrow('free-model policy');
    for (const env of [{ STUDIO_REMOTE_PLANNER: 'on' }, { STUDIO_T3_MCP_URL: 'https://agent.example.test/mcp' }, { STUDIO_OPEN_DESIGN_REGISTRATION: '/owned/unverified.json' }])
      expect(() => integrationSettingsFromEnv({ NODE_ENV: 'production', ...env })).toThrow('free-model policy');
  });
});
