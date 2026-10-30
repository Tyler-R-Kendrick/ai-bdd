import { describe, expect, it } from 'vitest';
import { createFreeGateway } from '../src/free-gateway.ts';
import type { GatewayFetch, FreeGatewayModelKind } from '../src/free-gateway.ts';

const modelId = 'owned/free';
const base = 'https://ai-gateway.vercel.sh/v4/ai';
const path = base + '/language-model';
const headers = { 'ai-language-model-id': modelId, 'content-type': 'application/json' };
const body = JSON.stringify({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'Preserve this source.' }] }] });
const endpointPrice = { prompt: '0', completion: '0', request: '0', image: '0', image_output: '0', web_search: '0', internal_reasoning: '0', discount: 0 };

/** Exercise the SDK's actual installed fetch closure without exporting private policy helpers. */
function boundary(kind: FreeGatewayModelKind = 'language', options: { providers?: string[]; baseURL?: string } = {}) {
  const metadata: URL[] = [];
  const inference: { url: URL; init: RequestInit; body: Record<string, unknown> }[] = [];
  const metadataFetch: GatewayFetch = async input => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    metadata.push(url);
    const responseHeaders = { date: new Date().toUTCString(), age: '0' };
    if (url.pathname === '/v1/models')
      return Response.json({ data: [{ id: modelId, type: kind, pricing: { input: '0', output: '0' } }] }, { headers: responseHeaders });
    expect(url.pathname).toBe('/v1/models/owned/free/endpoints');
    return Response.json({ data: { id: modelId, endpoints: (options.providers ?? ['free-a', 'free-b']).map(provider_name => ({ provider_name, status: 0, pricing: endpointPrice })) } }, { headers: responseHeaders });
  };
  const transport: GatewayFetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    inference.push({ url, init: init ?? {}, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return kind === 'evaluation'
      ? Response.json({ model: modelId, answers: { allowed: { type: 'boolean', probability: .9 } } })
      : Response.json({ content: [{ type: 'text', text: 'Owned transport.' }], finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } }, warnings: [] });
  };
  const gateway = createFreeGateway({ apiKey: 'owned-fixture', metadataFetch, fetch: transport, ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }) });
  const model = kind === 'language' ? gateway.languageModel(modelId) : gateway.evaluationModel(modelId);
  // The installed SDK stores its transport in config; this is intentionally not a production API.
  const fetch = (model as unknown as { config: { fetch: GatewayFetch } }).config.fetch;
  return { gateway, fetch, metadata, inference };
}
const valid = (data: unknown = JSON.parse(body)): RequestInit => ({ method: 'POST', headers, body: JSON.stringify(data) });
const pinned = (providers = ['free-a', 'free-b']) => ({ gateway: { only: providers, models: [], byok: {} } });

async function refused(f: ReturnType<typeof boundary>, input: Parameters<GatewayFetch>[0], init?: RequestInit, reason?: string) {
  if (reason) await expect(f.fetch(input, init)).rejects.toMatchObject({ code: 'FREE_MODEL_REQUIRED', reason });
  else await expect(f.fetch(input, init)).rejects.toBeInstanceOf(Error);
  expect(f.inference).toEqual([]);
}

describe('free Gateway SDK request boundary', () => {
  it('pins every admitted actual SDK language-model call to verified free endpoints', async () => {
    const f = boundary();
    const generated = await f.gateway.languageModel(modelId).doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'Preserve this source.' }] }] });
    expect(generated.content).toEqual([{ type: 'text', text: 'Owned transport.' }]);
    expect(f.metadata).toHaveLength(2);
    expect(f.inference).toHaveLength(1);
    const call = f.inference[0]!;
    expect(call.url.href).toBe(path);
    expect(call.init.method).toBe('POST');
    expect(call.init.redirect).toBe('error');
    expect(new Headers(call.init.headers).get('ai-language-model-id')).toBe(modelId);
    expect(call.body.providerOptions).toEqual(pinned());
    expect(call.body.prompt).toEqual(JSON.parse(body).prompt);
  });

  it('validates native evaluation catalog kind and pins actual SDK evaluation calls', async () => {
    const f = boundary('evaluation');
    const result = await f.gateway.evaluationModel(modelId).doDecide({ state: [{ type: 'text', text: 'The change is approved.' }], questions: { allowed: { type: 'boolean', instructions: 'Is the change approved?' } } });
    expect(result.answers).toEqual({ allowed: { type: 'boolean', probability: .9 } });
    expect(f.inference).toHaveLength(1);
    expect(f.inference[0]!.url.pathname).toBe('/v4/ai/decision-model');
    expect(new Headers(f.inference[0]!.init.headers).get('ai-model-id')).toBe(modelId);
    expect(f.inference[0]!.body.providerOptions).toEqual(pinned());
    expect(f.inference[0]!.body.questions).toEqual({ allowed: { type: 'boolean', instructions: 'Is the change approved?' } });
  });

  it('refuses evaluation-to-language kind confusion even when the model price is zero', async () => {
    const f = boundary('evaluation');
    await refused(f, path, valid(), 'pricing');
    expect(f.metadata).toHaveLength(1);
  });

  it('accepts URL inputs and preserves unrelated JSON fields and local function tools', async () => {
    const f = boundary();
    const data = { prompt: JSON.parse(body).prompt, metadata: { source: 'artifact-7' }, tools: [{ type: 'function', name: 'owned_local', inputSchema: { type: 'object' } }] };
    await f.fetch(new URL(path), valid(data));
    expect(f.inference[0]!.body).toEqual({ ...data, providerOptions: pinned() });
  });

  it('preserves a standalone Request method, body, headers and cancellation signal', async () => {
    const f = boundary();
    const controller = new AbortController();
    const request = new Request(path, { ...valid(), signal: controller.signal });
    await f.fetch(request);
    expect(f.inference).toHaveLength(1);
    expect(f.inference[0]!.init.method).toBe('POST');
    expect(f.inference[0]!.init.signal).toBe(request.signal);
    expect(f.inference[0]!.body.prompt).toEqual(JSON.parse(body).prompt);
    expect(new Headers(f.inference[0]!.init.headers).get('ai-language-model-id')).toBe(modelId);
    expect(request.bodyUsed).toBe(true);
    await expect(request.text()).rejects.toBeInstanceOf(TypeError);
  });

  it('honors init method, matching model header, body and signal over the Request values', async () => {
    const f = boundary();
    const original = new AbortController();
    original.abort(new Error('Superseded Request cancellation'));
    const request = new Request(path, { method: 'PUT', headers: { ...headers, 'ai-language-model-id': 'owned/paid' }, body: '{"source":"old"}', signal: original.signal });
    const replacement = new AbortController();
    await f.fetch(request, { ...valid({ source: 'replacement' }), signal: replacement.signal });
    expect(f.inference).toHaveLength(1);
    expect(f.inference[0]!.init.signal).toBe(replacement.signal);
    expect(f.inference[0]!.body).toEqual({ source: 'replacement', providerOptions: pinned() });
    expect(new Headers(f.inference[0]!.init.headers).get('ai-language-model-id')).toBe(modelId);
    expect(await request.text()).toBe('{"source":"old"}');
  });

  it.each([
    ['missing method', undefined], ['GET', 'GET'], ['PUT', 'PUT'], ['lowercase post', 'post'],
  ])('refuses %s before metadata or inference', async (_name, method) => {
    const f = boundary();
    await refused(f, path, { headers, body, ...(method === undefined ? {} : { method }) }, 'transport');
    expect(f.metadata).toEqual([]);
  });

  it('honors an overriding forbidden method instead of a POST Request', async () => {
    const f = boundary();
    await refused(f, new Request(path, valid()), { method: 'DELETE' }, 'transport');
    expect(f.metadata).toEqual([]);
  });

  it.each([
    ['unsupported operation', base + '/embedding-model'],
    ['foreign prefix', 'https://ai-gateway.vercel.sh/wrong/v4/ai/language-model'],
    ['prefix confusion', 'https://ai-gateway.vercel.sh/aaaaaa/language-model'],
    ['foreign origin', 'https://owned.invalid/v4/ai/language-model'],
    ['URL username', 'https://owned@ai-gateway.vercel.sh/v4/ai/language-model'],
    ['URL password', 'https://:owned@ai-gateway.vercel.sh/v4/ai/language-model'],
    ['URL credentials', 'https://owned:fixture@ai-gateway.vercel.sh/v4/ai/language-model'],
    ['query override', path + '?model=owned/paid'],
    ['fragment override', path + '#owned/paid'],
  ])('refuses %s before metadata or inference', async (_name, url) => {
    const f = boundary();
    await refused(f, url, valid(), 'transport');
    expect(f.metadata).toEqual([]);
  });

  it('refuses a malformed input URL without making a network request', async () => {
    const f = boundary();
    await refused(f, 'not an absolute URL', valid());
    expect(f.metadata).toEqual([]);
  });

  it.each([
    ['missing body', undefined], ['binary raw body', new Uint8Array([123, 125])],
    ['malformed JSON', '{'], ['array body', '[]'], ['null body', 'null'],
    ['boolean body', 'false'], ['string body', '"source"'], ['numeric body', '1'],
  ])('refuses %s before metadata or inference', async (_name, raw) => {
    const f = boundary();
    await refused(f, path, { method: 'POST', headers, ...(raw === undefined ? {} : { body: raw }) }, 'transport');
    expect(f.metadata).toEqual([]);
  });

  it('bounds actual UTF-8 request bytes before parsing or metadata fetches', async () => {
    const f = boundary();
    const oversized = JSON.stringify({ source: 'é'.repeat(8 * 1024 * 1024) });
    expect(oversized.length).toBeLessThan(16 * 1024 * 1024);
    await refused(f, path, { method: 'POST', headers, body: oversized }, 'transport');
    expect(f.metadata).toEqual([]);
  });

  it.each([
    ['missing model header', {}], ['empty model', { 'ai-language-model-id': '' }],
    ['virtual alias', { 'ai-language-model-id': 'vmc/free' }],
    ['foreign path id', { 'ai-language-model-id': 'owned/free/paid' }],
  ])('refuses %s before metadata or inference', async (_name, badHeaders) => {
    const f = boundary();
    await refused(f, path, { ...valid(), headers: badHeaders }, 'model');
    expect(f.metadata).toEqual([]);
  });

  it.each([
    ['null provider options', { providerOptions: null }],
    ['array provider options', { providerOptions: [] }],
    ['foreign provider options', { providerOptions: { anthropic: {} } }],
    ['null gateway routing', { providerOptions: { gateway: null } }],
    ['array gateway routing', { providerOptions: { gateway: [] } }],
    ['paid fallback models', { providerOptions: { gateway: { models: ['owned/paid'] } } }],
    ['BYOK credentials', { providerOptions: { gateway: { byok: { provider: [{ apiKey: 'owned-fixture' }] } } } }],
    ['tier override', { providerOptions: { gateway: { tier: 'paid' } } }],
    ['provider order override', { providerOptions: { gateway: { order: ['paid'] } } }],
    ['budget override', { providerOptions: { gateway: { maxCost: 5 } } }],
    ['hosted paid tool', { tools: [{ type: 'provider-defined', id: 'gateway.web_search' }] }],
    ['tool with unspecified billing type', { tools: [{ name: 'unknown' }] }],
  ])('refuses %s before metadata or inference', async (_name, data) => {
    const f = boundary();
    await refused(f, path, valid(data), 'routing');
    expect(f.metadata).toEqual([]);
  });

  it.each([
    ['non-array only', 'free-a'], ['empty provider allowlist', []],
    ['non-string provider', [1]], ['unverified provider', ['paid']],
    ['mixed free and paid providers', ['free-a', 'paid']],
  ])('refuses %s after checking metadata but before inference', async (_name, only) => {
    const f = boundary();
    await refused(f, path, valid({ providerOptions: { gateway: { only } } }), 'routing');
    expect(f.metadata).toHaveLength(2);
  });

  it.each([
    ['no provider options', {}],
    ['empty provider options', { providerOptions: {} }],
    ['empty gateway routing', { providerOptions: { gateway: {} } }],
  ])('pins all verified free providers with %s', async (_name, data) => {
    const f = boundary();
    await f.fetch(path, valid(data));
    expect(f.inference).toHaveLength(1);
    expect(f.inference[0]!.body.providerOptions).toEqual(pinned());
  });

  it('allows an explicit free-provider subset and removes duplicate providers', async () => {
    const f = boundary();
    await f.fetch(path, valid({ providerOptions: { gateway: { only: ['free-b', 'free-b'] } } }));
    expect(f.inference).toHaveLength(1);
    expect(f.inference[0]!.body.providerOptions).toEqual(pinned(['free-b']));
  });

  it('rejects cancelled Request and init signals without contacting a model', async () => {
    const f = boundary();
    const controller = new AbortController();
    const reason = new Error('Owned cancellation');
    controller.abort(reason);
    await expect(f.fetch(new Request(path, { ...valid(), signal: controller.signal }))).rejects.toBe(reason);
    await expect(f.fetch(path, { ...valid(), signal: controller.signal })).rejects.toBe(reason);
    expect(f.metadata).toEqual([]);
    expect(f.inference).toEqual([]);
  });

  it('admits explicitly injected loopback protocol fixtures while retaining canonical price metadata', async () => {
    const f = boundary('language', { baseURL: 'http://127.0.0.1:9123/owned/ai/' });
    await f.fetch('http://127.0.0.1:9123/owned/ai/language-model', valid());
    expect(f.inference).toHaveLength(1);
    expect(f.inference[0]!.body.providerOptions).toEqual(pinned());
    expect(f.metadata.every(url => url.origin === 'https://ai-gateway.vercel.sh')).toBe(true);
  });
});
