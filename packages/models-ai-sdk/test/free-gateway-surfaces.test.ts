import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createFreeGateway } from '../src/free-gateway.ts';
import type { FreeGatewayOptions, FreeGatewayProvider, GatewayFetch } from '../src/free-gateway.ts';

const reviewedSurface = ['specificationVersion', 'chat', 'languageModel', 'decision', 'decisionModel', 'evaluation', 'evaluationModel'] as const;
const unsupported = [
  'embedding', 'embeddingModel', 'textEmbeddingModel', 'image', 'imageModel',
  'video', 'videoModel', 'reranking', 'rerankingModel', 'speech', 'speechModel',
  'transcription', 'transcriptionModel', 'experimental_transcription', 'experimental_realtime',
  'experimental_batch', 'tools', 'getAvailableModels', 'getCredits', 'getSpendReport', 'getGenerationInfo',
] as const;

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** All HTTP and WebSocket boundaries are owned counters, including unexpected ambient SDK transports. */
function boundary() {
  let http = 0, sockets = 0;
  const ownedHttp: GatewayFetch = async () => { http++; throw new Error('Owned transport: HTTP was not authorized.'); };
  class OwnedWebSocket {
    constructor() { sockets++; throw new Error('Owned transport: WebSocket was not authorized.'); }
  }
  vi.stubGlobal('fetch', ownedHttp);
  vi.stubGlobal('WebSocket', OwnedWebSocket);
  const gateway = createFreeGateway({
    apiKey: 'owned-fixture', fetch: ownedHttp, metadataFetch: ownedHttp,
    webSocket: OwnedWebSocket as unknown as NonNullable<FreeGatewayOptions['webSocket']>,
  });
  const unsafe = gateway as unknown as Record<string, unknown>;
  const noAttempts = () => { expect(http).toBe(0); expect(sockets).toBe(0); };
  return { gateway, unsafe, noAttempts };
}

describe('free Gateway exposes only reviewed guarded SDK surfaces', () => {
  it('exports the same narrow surface in the TypeScript provider contract', () => {
    expectTypeOf<keyof FreeGatewayProvider>().toEqualTypeOf<typeof reviewedSurface[number]>();
    expectTypeOf<ReturnType<typeof createFreeGateway>>().toEqualTypeOf<FreeGatewayProvider>();
  });

  it('exposes exactly the reviewed enumerable API and freezes additions, deletions and replacement', () => {
    const f = boundary();
    expect(typeof f.gateway).toBe('function');
    expect(Object.keys(f.gateway).sort()).toEqual([...reviewedSurface].sort());
    expect(Object.isFrozen(f.gateway)).toBe(true);
    expect(f.gateway.specificationVersion).toBe('v4');
    expect(Reflect.set(f.gateway, 'transcriptionModel', () => { throw new Error('Unreviewed factory'); })).toBe(false);
    expect(Reflect.set(f.gateway, 'chat', () => { throw new Error('Unreviewed replacement'); })).toBe(false);
    expect(Reflect.deleteProperty(f.gateway, 'languageModel')).toBe(false);
    expect(() => Object.defineProperty(f.gateway, 'experimental_realtime', { value: () => undefined })).toThrow(TypeError);
    expect(f.unsafe.transcriptionModel).toBeUndefined();
    f.noAttempts();
  });

  it.each(unsupported)('does not expose or invoke the SDK %s surface', name => {
    const f = boundary();
    expect(f.unsafe[name]).toBeUndefined();
    const factory = f.unsafe[name] as (id: string) => unknown;
    expect(() => factory('owned/paid-unverified')).toThrow(TypeError);
    f.noAttempts();
  });

  it.each(['transcriptionModel', 'transcription', 'experimental_transcription'])('blocks %s doStream before any WebSocket constructor or HTTP attempt', async name => {
    const f = boundary();
    const factory = f.unsafe[name] as (id: string) => {
      doStream(options: unknown): Promise<{ stream: ReadableStream<unknown> }>;
    };
    const attempt = async () => {
      const transcription = factory('owned/paid-transcription');
      const result = await transcription.doStream({
        inputAudioFormat: { type: 'pcm', sampleRate: 16000, channels: 1 },
        audio: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
      });
      await result.stream.getReader().read();
    };
    await expect(attempt()).rejects.toBeInstanceOf(TypeError);
    f.noAttempts();
  });

  it.each(['experimental_transcription', 'experimental_realtime'])('cannot mint a browser token through %s', name => {
    const f = boundary();
    const tokens = f.unsafe[name] as { getToken(options: unknown): unknown };
    expect(() => tokens.getToken({ model: 'owned/paid-unverified' })).toThrow(TypeError);
    f.noAttempts();
  });

  it('cannot construct paid hosted tools through the omitted tools namespace', () => {
    const f = boundary();
    const tools = f.unsafe.tools as { webSearch(options: unknown): unknown };
    expect(() => tools.webSearch({})).toThrow(TypeError);
    f.noAttempts();
  });

  it('retains the callable language-model factory with the guarded SDK transport', () => {
    const f = boundary();
    const model = f.gateway('owned/free-language');
    expect(model.modelId).toBe('owned/free-language');
    expect(model.provider).toBe('gateway');
    expect(model.specificationVersion).toBe('v4');
    expect(typeof model.doGenerate).toBe('function');
    expect(typeof model.doStream).toBe('function');
    f.noAttempts();
  });

  it.each(['chat', 'languageModel'] as const)('retains the %s language alias and exact model identity', name => {
    const f = boundary();
    const model = f.gateway[name]('owned/free-language');
    expect(model.modelId).toBe('owned/free-language');
    expect(model.provider).toBe('gateway');
    expect(model.specificationVersion).toBe('v4');
    expect(typeof model.doGenerate).toBe('function');
    expect(typeof model.doStream).toBe('function');
    f.noAttempts();
  });

  it.each(['decision', 'decisionModel', 'evaluation', 'evaluationModel'] as const)('retains the %s native evaluation alias and supported question kinds', name => {
    const f = boundary();
    const model = f.gateway[name]('owned/free-evaluation');
    expect(model.modelId).toBe('owned/free-evaluation');
    expect(model.provider).toBe('gateway');
    expect(model.specificationVersion).toBe('v4');
    expect(model.supportedQuestionTypes).toEqual(['choice', 'score', 'boolean']);
    expect(typeof model.doDecide).toBe('function');
    f.noAttempts();
  });

  it('gives every retained factory the same guarded SDK fetch closure', () => {
    const f = boundary();
    const models = [
      f.gateway('owned/free-language'), f.gateway.chat('owned/free-language'), f.gateway.languageModel('owned/free-language'),
      f.gateway.decision('owned/free-evaluation'), f.gateway.decisionModel('owned/free-evaluation'),
      f.gateway.evaluation('owned/free-evaluation'), f.gateway.evaluationModel('owned/free-evaluation'),
    ];
    const transports = models.map(model => (model as unknown as { config: { fetch: GatewayFetch } }).config.fetch);
    expect(transports.every(transport => typeof transport === 'function')).toBe(true);
    expect(new Set(transports).size).toBe(1);
    f.noAttempts();
  });
});
