import { afterEach, describe, expect, it, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  createGateway,
  generateText,
  streamText,
  type LanguageModel,
} from 'ai';
import { identityLanguageModel } from '../server/hosting/identity-language-model.ts';
import type { IdentityExecutionContext } from '../server/hosting/identity-context.ts';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const generated = {
  content: [{ type: 'text', text: 'Scoped SDK result.' }],
  finishReason: { unified: 'stop', raw: 'stop' },
  usage,
  warnings: [],
};
describe('optional per-attempt SDK identity execution port', () => {
  it('keeps absent-port concrete models and guards string model identifiers', async () => {
    const model = createGateway({ apiKey: 'synthetic-sdk-fixture' })(
      'fixture/model',
    );
    expect(identityLanguageModel(model)).toBe(model);
    const requests: string[] = [];
    vi.stubEnv('AI_GATEWAY_API_KEY', 'owned-identity-model-fixture');
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push(url.origin + url.pathname);
      if (url.origin !== 'https://ai-gateway.vercel.sh' || url.pathname !== '/v1/models')
        throw new Error('A paid model must not reach inference');
      return Response.json({
        data: [{ id: 'fixture/model', type: 'language', pricing: { input: '1', output: '0' } }],
      }, { headers: { date: new Date().toUTCString(), age: '0' } });
    });
    const guarded = identityLanguageModel('fixture/model');
    expect(guarded).toMatchObject({ modelId: 'fixture/model' });
    await expect(generateText({ model: guarded, prompt: 'Owned fixture.', maxRetries: 0 }))
      .rejects.toMatchObject({ cause: { code: 'FREE_MODEL_REQUIRED', reason: 'pricing' } });
    expect(requests).toEqual(['https://ai-gateway.vercel.sh/v1/models']);
  });
  it('preserves v3 metadata/private receivers through actual AI SDK v4 generate and stream adaptation', async () => {
    const storage = new AsyncLocalStorage<boolean>();
    let entries = 0;
    const context: IdentityExecutionContext = {
      run: (operation) => {
        entries++;
        return storage.run(true, operation);
      },
    };
    class V3 {
      #response = 'Scoped SDK result.';
      specificationVersion = 'v3' as const;
      provider = 'fixture';
      modelId = 'v3-private';
      supportedUrls = {};
      async doGenerate() {
        expect(storage.getStore()).toBe(true);
        return {
          ...generated,
          content: [{ type: 'text', text: this.#response }],
        };
      }
      async doStream() {
        expect(storage.getStore()).toBe(true);
        const text = this.#response;
        return {
          stream: new ReadableStream({
            start(controller) {
              for (const value of [
                { type: 'text-start', id: 'text' },
                { type: 'text-delta', id: 'text', delta: text },
                { type: 'text-end', id: 'text' },
                { type: 'finish', finishReason: generated.finishReason, usage },
              ])
                controller.enqueue(value);
              controller.close();
            },
          }),
        };
      }
    }
    const model = identityLanguageModel(new V3() as LanguageModel, context);
    expect(
      typeof model === 'string'
        ? null
        : [model.specificationVersion, model.provider, model.modelId],
    ).toEqual(['v3', 'fixture', 'v3-private']);
    expect(
      (await generateText({ model, prompt: 'Fixture.', maxRetries: 0 })).text,
    ).toBe('Scoped SDK result.');
    expect(
      await streamText({ model, prompt: 'Fixture.', maxRetries: 0 }).text,
    ).toBe('Scoped SDK result.');
    expect(entries).toBe(2);
    expect(storage.getStore()).toBeUndefined();
  });
  it('enters the port for each reused real Gateway SDK request and leaves HTTP generation unchanged', async () => {
    const storage = new AsyncLocalStorage<boolean>();
    let entries = 0,
      received = 0;
    const server = createServer(async (req, res) => {
      for await (const _part of req) {
      }
      received++;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(generated));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    cleanup.push(
      () =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    const context: IdentityExecutionContext = {
      run: (operation) => {
        entries++;
        return storage.run(true, operation);
      },
    };
    const model = identityLanguageModel(
      createGateway({
        baseURL: `http://127.0.0.1:${(server.address() as any).port}`,
        apiKey: 'synthetic-sdk-fixture',
        fetch: (input, init) => {
          expect(storage.getStore()).toBe(true);
          return fetch(input, init);
        },
      })('fixture/model'),
      context,
    );
    for (let i = 0; i < 2; i++)
      expect(
        (
          await generateText({
            model,
            prompt: 'Actual HTTP fixture.',
            maxRetries: 0,
          })
        ).text,
      ).toBe('Scoped SDK result.');
    expect(entries).toBe(2);
    expect(received).toBe(2);
    expect(storage.getStore()).toBeUndefined();
  });
  it('does not call a provider when its execution port refuses admission', async () => {
    let called = false;
    const model = identityLanguageModel(
      createGateway({
        apiKey: 'synthetic-sdk-fixture',
        fetch: async () => {
          called = true;
          throw new Error('Must not run');
        },
      })('fixture/model'),
      {
        run: async () => {
          throw new Error('Identity unavailable');
        },
      },
    );
    await expect(
      generateText({ model, prompt: 'Denied.', maxRetries: 0 }),
    ).rejects.toThrow('Identity unavailable');
    expect(called).toBe(false);
  });
});
