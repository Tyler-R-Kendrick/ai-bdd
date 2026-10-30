import { createGateway } from 'ai';

export type FreeGatewayModelKind = 'language' | 'evaluation';
export type GatewayFetch = typeof globalThis.fetch;
export type FreeGatewayOptions = NonNullable<Parameters<typeof createGateway>[0]> & {
  /** Trusted server transport injection; no environment or browser input selects this. */
  metadataFetch?: GatewayFetch | undefined;
  now?: (() => number) | undefined;
};
type GatewayProvider = ReturnType<typeof createGateway>;
/** Only modalities whose every inference crosses the price/routing guard are exposed. */
export type FreeGatewayProvider = Pick<GatewayProvider,
  'specificationVersion' | 'chat' | 'languageModel' | 'decision' | 'decisionModel' | 'evaluation' | 'evaluationModel'
> & ((modelId: Parameters<GatewayProvider>[0]) => ReturnType<GatewayProvider>);
export class FreeGatewayPolicyError extends Error {
  readonly code = 'FREE_MODEL_REQUIRED';
  readonly reason: 'model' | 'pricing' | 'stale-pricing' | 'metadata' | 'routing' | 'transport';
  constructor(reason: FreeGatewayPolicyError['reason']) {
    super('Only models with freshly verified zero-cost Gateway routes are allowed.');
    this.name = 'FreeGatewayPolicyError';
    this.reason = reason;
  }
}
const catalogOrigin = 'https://ai-gateway.vercel.sh';
const maximumMetadataAge = 60000;
const maximumMetadataBytes = 4 * 1024 * 1024;
const modelId = /^[a-z0-9][a-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const endpointFees = new Set([
  'prompt', 'completion', 'request', 'image', 'image_output', 'web_search',
  'internal_reasoning', 'input_cache_read', 'input_cache_write',
  'cache_read', 'cache_write', 'audio', 'input_audio', 'output_audio',
  'audio_input', 'audio_output', 'discount',
]);
const requiredEndpointFees = ['prompt', 'completion', 'request', 'image', 'image_output', 'web_search', 'internal_reasoning'];
const zero = (value: unknown) =>
  // Never coerce: a positive price such as 1e-9999 underflows Number to zero.
  typeof value === 'string' && /^0+(?:\.0+)?(?:e[+-]?[0-9]+)?$/i.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const freeEndpoint = (endpoint: Record<string, unknown>) => {
  if (endpoint.status !== 0 || !record(endpoint.pricing)) return false;
  const pricing = endpoint.pricing;
  if (!requiredEndpointFees.every(key => zero(pricing[key]))) return false;
  if ((endpoint.supports_implicit_caching === true || (Array.isArray(endpoint.tags) && endpoint.tags.includes('implicit-caching'))) && !zero(pricing.input_cache_read)) return false;
  return Object.entries(pricing).every(([key, price]) =>
    endpointFees.has(key) && (key === 'discount' ? price === 0 || zero(price) : zero(price)));
};
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const cancel = () => { signal.removeEventListener('abort', cancel); reject(signal.reason); };
    signal.addEventListener('abort', cancel, { once: true });
    pending.then(value => { signal.removeEventListener('abort', cancel); resolve(value); }, error => { signal.removeEventListener('abort', cancel); reject(error); });
  });
}
function freeCatalogModel(value: unknown, kind: FreeGatewayModelKind) {
  if (!record(value) || value.type !== kind || !record(value.pricing)) return false;
  const pricing = value.pricing;
  return zero(pricing.input) && zero(pricing.output) &&
    Object.entries(pricing).every(([key, price]) =>
      key === 'varies_by_provider' ? price === false :
        (key === 'input' || key === 'output') && zero(price));
}
/** Cleanup must not mask the policy/abort error or wait for an uncooperative body. */
function cancelQuietly(target: { cancel(): Promise<unknown> } | null | undefined) {
  void target?.cancel().catch(() => {});
}
async function metadata(path: string, signal: AbortSignal | undefined, options: Pick<FreeGatewayOptions, 'metadataFetch' | 'fetch' | 'now'>) {
  signal?.throwIfAborted();
  const now = options.now ?? Date.now;
  const url = new URL(path, catalogOrigin);
  // Price metadata is re-read for each real attempt. A nonce avoids an old CDN
  // quote despite cache:no-store; an aged or undated response is refused.
  url.searchParams.set('_pricing_check', String(now()));
  const timeout = AbortSignal.timeout(10000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    const pending = (options.metadataFetch ?? options.fetch ?? globalThis.fetch)(url, {
      redirect: 'error',
      headers: { accept: 'application/json', 'cache-control': 'no-cache' }, signal: combined,
    });
    void pending.then(value => { if (combined.aborted) cancelQuietly(value.body); }, () => {});
    response = await abortable(pending, combined);
  } catch {
    if (signal?.aborted) throw signal.reason;
    throw new FreeGatewayPolicyError('metadata');
  }
  const date = Date.parse(response.headers.get('date') ?? '');
  const age = response.headers.get('age');
  if (!Number.isFinite(date) || now() - date > maximumMetadataAge || date - now() > 5000 ||
      (age !== null && (!/^[0-9]+$/.test(age) || Number(age) * 1000 > maximumMetadataAge))) {
    cancelQuietly(response.body);
    throw new FreeGatewayPolicyError('stale-pricing');
  }
  if (!response.ok) { cancelQuietly(response.body); throw new FreeGatewayPolicyError('metadata'); }
  const reader = response.body?.getReader();
  if (!reader) throw new FreeGatewayPolicyError('metadata');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await abortable(reader.read(), combined);
      combined.throwIfAborted();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maximumMetadataBytes) throw new FreeGatewayPolicyError('metadata');
      chunks.push(part.value);
    }
    const content = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { content.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(content));
  } catch (error) {
    cancelQuietly(reader);
    if (signal?.aborted) throw signal.reason;
    if (error instanceof FreeGatewayPolicyError) throw error;
    throw new FreeGatewayPolicyError('metadata');
  } finally { reader.releaseLock(); }
}

export async function authorizeFreeGatewayModel(
  id: string, kind: FreeGatewayModelKind, signal?: AbortSignal,
  options: Pick<FreeGatewayOptions, 'metadataFetch' | 'fetch' | 'now'> = {},
) {
  if (!modelId.test(id) || id.startsWith('vmc/')) throw new FreeGatewayPolicyError('model');
  const catalog = await metadata('/v1/models', signal, options);
  if (!record(catalog) || !Array.isArray(catalog.data) || catalog.data.length > 10000)
    throw new FreeGatewayPolicyError('metadata');
  const matches = catalog.data.filter(item => record(item) && item.id === id);
  if (matches.length !== 1 || !freeCatalogModel(matches[0], kind)) throw new FreeGatewayPolicyError('pricing');
  const endpoints = await metadata('/v1/models/' + id.split('/').map(encodeURIComponent).join('/') + '/endpoints', signal, options);
  if (!record(endpoints) || !record(endpoints.data) || endpoints.data.id !== id || !Array.isArray(endpoints.data.endpoints) || endpoints.data.endpoints.length > 100)
    throw new FreeGatewayPolicyError('metadata');
  const routes: unknown[] = endpoints.data.endpoints;
  const providers: string[] = [];
  for (const endpoint of routes) {
    if (!record(endpoint) ||
        typeof endpoint.provider_name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(endpoint.provider_name) ||
        !freeEndpoint(endpoint)) continue;
    providers.push(endpoint.provider_name);
  }
  const allowed = [...new Set(providers)].sort();
  // Provider-level routing cannot distinguish paid/free endpoints under the same
  // slug. Exclude the entire provider if any of its advertised endpoints differs.
  const safe = allowed.filter(provider => routes.every((endpoint: unknown) =>
    !record(endpoint) || endpoint.provider_name !== provider ||
    freeEndpoint(endpoint)));
  if (!safe.length) throw new FreeGatewayPolicyError('pricing');
  return { modelId: id, kind, providers: safe, checkedAt: (options.now ?? Date.now)() };
}

/** Public discovery only. Every invocation independently revalidates its route. */
export async function freeGatewayModels(kind: FreeGatewayModelKind, options: Pick<FreeGatewayOptions, 'metadataFetch' | 'fetch' | 'now'> = {}) {
  const catalog = await metadata('/v1/models', undefined, options);
  if (!record(catalog) || !Array.isArray(catalog.data)) throw new FreeGatewayPolicyError('metadata');
  const candidates = catalog.data.filter(item => freeCatalogModel(item, kind) && record(item) && typeof item.id === 'string').map(item => (item as Record<string, unknown>).id as string);
  if (candidates.length > 100) throw new FreeGatewayPolicyError('metadata');
  const quotes = await Promise.allSettled(candidates.map(id => authorizeFreeGatewayModel(id, kind, undefined, options)));
  return quotes.flatMap(quote => quote.status === 'fulfilled' ? [quote.value.modelId] : []);
}

const maximumRequestBytes = 16 * 1024 * 1024;
const requestBodyTimeout = 10000;

/** Consume the original Request stream so no unread clone branch can retain unbounded input. */
async function boundedRequestBody(request: Request, signal: AbortSignal | null | undefined) {
  signal?.throwIfAborted();
  if (request.bodyUsed || !request.body || request.body.locked) throw new FreeGatewayPolicyError('transport');
  const reader = request.body.getReader();
  const timeout = AbortSignal.timeout(requestBodyTimeout);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const deadline = performance.now() + requestBodyTimeout;
  let content = new Uint8Array(0);
  let bytes = 0;
  try {
    while (true) {
      combined.throwIfAborted();
      const part = await abortable(reader.read(), combined);
      combined.throwIfAborted();
      // A stream yielding immediately can starve the deadline's timer. Check
      // elapsed time as well as racing each potentially blocked read.
      if (performance.now() > deadline) throw new FreeGatewayPolicyError('transport');
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) throw new FreeGatewayPolicyError('transport');
      bytes += part.value.byteLength;
      if (bytes > maximumRequestBytes) throw new FreeGatewayPolicyError('transport');
      if (bytes > content.byteLength) {
        const grown = new Uint8Array(Math.min(maximumRequestBytes, Math.max(bytes, content.byteLength * 2, 16384)));
        grown.set(content); content = grown;
      }
      content.set(part.value, bytes - part.value.byteLength);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(content.subarray(0, bytes));
  } catch {
    cancelQuietly(reader);
    if (signal?.aborted) throw signal.reason;
    throw new FreeGatewayPolicyError('transport');
  } finally { reader.releaseLock(); }
}

/** Decode the request the SDK will actually send, before any public-price or inference fetch. */
async function gatewayRequest(input: Parameters<GatewayFetch>[0], init: Parameters<GatewayFetch>[1], inferenceBase: URL, basePath: string) {
  const target = new URL(input instanceof Request ? input.url : String(input));
  const kind: FreeGatewayModelKind | null = target.pathname === basePath + '/language-model' ? 'language' : target.pathname === basePath + '/decision-model' ? 'evaluation' : null;
  if (target.username || target.password || target.origin !== inferenceBase.origin || !kind || target.search || target.hash || (init?.method ?? (input instanceof Request ? input.method : 'GET')) !== 'POST')
    throw new FreeGatewayPolicyError('transport');
  // Fetch's explicit null clears a Request signal; undefined inherits it.
  const signal = init?.signal !== undefined ? init.signal : (input instanceof Request ? input.signal : undefined);
  signal?.throwIfAborted();
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  const id = headers.get(kind === 'language' ? 'ai-language-model-id' : 'ai-model-id') ?? '';
  const raw = init?.body ?? (input instanceof Request ? await boundedRequestBody(input, signal) : undefined);
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > maximumRequestBytes)
    throw new FreeGatewayPolicyError('transport');
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw new FreeGatewayPolicyError('transport'); }
  if (!record(body)) throw new FreeGatewayPolicyError('transport');
  return { target, kind, headers, id, body, signal };
}

/** Only the free-provider subset is caller configurable; all other routing is owned here. */
function requestRouting(body: Record<string, unknown>) {
  const providerOptions = body.providerOptions;
  if (providerOptions !== undefined && (!record(providerOptions) || Object.keys(providerOptions).some(key => key !== 'gateway')))
    throw new FreeGatewayPolicyError('routing');
  const routing = record(providerOptions) ? providerOptions.gateway : undefined;
  if (routing !== undefined && (!record(routing) || Object.keys(routing).some(key => key !== 'only')))
    throw new FreeGatewayPolicyError('routing');
  if (Array.isArray(body.tools) && body.tools.some(tool => record(tool) && tool.type !== 'function'))
    throw new FreeGatewayPolicyError('routing');
  return routing;
}

function requestedProviders(routing: unknown, providers: string[]) {
  if (!record(routing) || routing.only === undefined) return providers;
  if (!Array.isArray(routing.only) || !routing.only.length || routing.only.some(provider => typeof provider !== 'string' || !providers.includes(provider)))
    throw new FreeGatewayPolicyError('routing');
  return [...new Set(routing.only as string[])];
}

export function createFreeGateway(options: FreeGatewayOptions = {}): FreeGatewayProvider {
  const { metadataFetch, now, fetch: transport = globalThis.fetch, ...gatewayOptions } = options;
  const inferenceBase = new URL(gatewayOptions.baseURL ?? 'https://ai-gateway.vercel.sh/v4/ai');
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(inferenceBase.hostname);
  const basePath = inferenceBase.pathname.replace(/\/$/, '');
  if (inferenceBase.username || inferenceBase.password || inferenceBase.hash || inferenceBase.search ||
      !((inferenceBase.origin === catalogOrigin && basePath === '/v4/ai') ||
        (loopback && !!metadataFetch && ['http:', 'https:'].includes(inferenceBase.protocol))))
    throw new FreeGatewayPolicyError('transport');
  const guardedFetch: GatewayFetch = async (input, init) => {
    const { target, kind, headers, id, body, signal } = await gatewayRequest(input, init, inferenceBase, basePath);
    const routing = requestRouting(body);
    const quote = await authorizeFreeGatewayModel(id, kind, signal ?? undefined, { metadataFetch: metadataFetch ?? (options.fetch ? transport : undefined), now });
    body.providerOptions = { gateway: { only: requestedProviders(routing, quote.providers), models: [], byok: {} } };
    signal?.throwIfAborted();
    return transport(target, { ...init, method: 'POST', ...(signal === undefined ? {} : { signal }), headers, body: JSON.stringify(body), redirect: 'error' });
  };
  const gateway = createGateway({ ...gatewayOptions, fetch: guardedFetch });
  // In particular, SDK streaming transcription opens a WebSocket directly and
  // never enters fetch. Do not return that factory, tools, batch or any future
  // modality merely because the underlying SDK adds it.
  return Object.freeze(Object.assign((id: Parameters<GatewayProvider>[0]) => gateway(id), {
    specificationVersion: gateway.specificationVersion,
    chat: gateway.chat, languageModel: gateway.languageModel,
    decision: gateway.decision, decisionModel: gateway.decisionModel,
    evaluation: gateway.evaluation, evaluationModel: gateway.evaluationModel,
  }));
}
