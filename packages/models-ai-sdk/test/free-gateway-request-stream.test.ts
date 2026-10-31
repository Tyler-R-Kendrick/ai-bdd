import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFreeGateway } from '../src/free-gateway.ts';
import type { GatewayFetch } from '../src/free-gateway.ts';

const modelId = 'owned/free';
const url = 'https://ai-gateway.vercel.sh/v4/ai/language-model';
const headers = { 'ai-language-model-id': modelId, 'content-type': 'application/json' };
const maximumBytes = 16 * 1024 * 1024;
const encoder = new TextEncoder();
const endpointPrice = { prompt: '0', completion: '0', request: '0', image: '0', image_output: '0', web_search: '0', internal_reasoning: '0', discount: 0 };

afterEach(() => vi.restoreAllMocks());

/** Owned SDK request transport: no HTTP or inference provider is contacted. */
function boundary() {
  let metadata = 0;
  const inference: { init: RequestInit; body: Record<string, unknown> }[] = [];
  const metadataFetch: GatewayFetch = async input => {
    metadata++;
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    const responseHeaders = { date: new Date().toUTCString(), age: '0' };
    if (path === '/v1/models')
      return Response.json({ data: [{ id: modelId, type: 'language', pricing: { input: '0', output: '0' } }] }, { headers: responseHeaders });
    expect(path).toBe('/v1/models/owned/free/endpoints');
    return Response.json({ data: { id: modelId, endpoints: [{ provider_name: 'owned-free', status: 0, pricing: endpointPrice }] } }, { headers: responseHeaders });
  };
  const transport: GatewayFetch = async (_input, init) => {
    inference.push({ init: init ?? {}, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return Response.json({ owned: true });
  };
  const model = createFreeGateway({ apiKey: 'owned-fixture', fetch: transport, metadataFetch }).languageModel(modelId);
  const fetch = (model as unknown as { config: { fetch: GatewayFetch } }).config.fetch;
  return { fetch, inference, metadata: () => metadata };
}
function request(stream: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  return new Request(url, { method: 'POST', headers, body: stream, duplex: 'half', ...(signal === undefined ? {} : { signal }) });
}
function chunks(parts: Uint8Array[]) {
  let index = 0, pulls = 0, cancellations = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      if (index < parts.length) controller.enqueue(parts[index++]!);
      else controller.close();
    },
    cancel() { cancellations++; },
  }, { highWaterMark: 0 });
  return { stream, pulls: () => pulls, cancellations: () => cancellations };
}
function blocked(cancel: () => void | Promise<void> = () => undefined) {
  let markRead!: () => void;
  const reading = new Promise<void>(resolve => { markRead = resolve; });
  let pulls = 0, cancellations = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull() { pulls++; markRead(); return new Promise<void>(() => {}); },
    cancel() { cancellations++; return cancel(); },
  }, { highWaterMark: 0 });
  return { stream, reading, pulls: () => pulls, cancellations: () => cancellations };
}
async function refusal(f: ReturnType<typeof boundary>, operation: Promise<Response>) {
  await expect(operation).rejects.toMatchObject({ code: 'FREE_MODEL_REQUIRED', reason: 'transport' });
  expect(f.metadata()).toBe(0);
  expect(f.inference).toEqual([]);
}

describe('bounded and cancellable Gateway Request body consumption', () => {
  it.each([false, true])('checks an already-aborted effective signal before reading (explicit undefined=%s)', async explicitUndefined => {
    const f = boundary(), source = blocked(), controller = new AbortController();
    const reason = new Error('Owned early cancellation');
    controller.abort(reason);
    const input = request(source.stream, controller.signal);
    // Fetch accepts explicit undefined at runtime; exactOptionalPropertyTypes omits it from RequestInit.
    const init = explicitUndefined ? { signal: undefined } as unknown as RequestInit : undefined;
    await expect(f.fetch(input, init)).rejects.toBe(reason);
    expect(source.pulls()).toBe(0);
    expect(input.bodyUsed).toBe(false);
    expect(f.metadata()).toBe(0);
    expect(f.inference).toEqual([]);
  });

  it('interrupts a blocked Request body on inherited caller cancellation', async () => {
    const f = boundary(), source = blocked(), controller = new AbortController();
    const input = request(source.stream, controller.signal);
    const operation = f.fetch(input);
    await source.reading;
    const reason = new Error('Owned mid-read cancellation');
    controller.abort(reason);
    await expect(operation).rejects.toBe(reason);
    expect(source.pulls()).toBe(1);
    expect(source.cancellations()).toBe(1);
    expect(input.bodyUsed).toBe(true);
    expect(f.metadata()).toBe(0);
    expect(f.inference).toEqual([]);
  }, 1000);

  it('interrupts a continuously yielding body when the caller aborts during a pull', async () => {
    const f = boundary(), controller = new AbortController();
    const reason = new Error('Owned infinite-stream cancellation');
    let pulls = 0, cancellations = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(control) { pulls++; control.enqueue(encoder.encode(' ')); if (pulls === 4) controller.abort(reason); },
      cancel() { cancellations++; },
    }, { highWaterMark: 0 });
    await expect(f.fetch(request(source, controller.signal))).rejects.toBe(reason);
    expect(pulls).toBe(4);
    expect(cancellations).toBe(1);
    expect(f.metadata()).toBe(0);
    expect(f.inference).toEqual([]);
  }, 1000);

  it('enforces the ten-second read deadline even when a body never produces a chunk', async () => {
    const f = boundary(), source = blocked(), deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const operation = f.fetch(request(source.stream));
    await source.reading;
    expect(timeout).toHaveBeenCalledWith(10000);
    deadline.abort(new DOMException('Owned read deadline', 'TimeoutError'));
    await refusal(f, operation);
    expect(source.cancellations()).toBe(1);
  }, 1000);

  it('checks monotonic elapsed time so zero-byte chunks cannot starve the deadline timer', async () => {
    const f = boundary();
    let pulls = 0, cancellations = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(control) { pulls++; control.enqueue(new Uint8Array()); },
      cancel() { cancellations++; },
    }, { highWaterMark: 0 });
    const input = request(source);
    vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValue(10101);
    await refusal(f, f.fetch(input));
    expect(pulls).toBeLessThanOrEqual(2);
    expect(cancellations).toBe(1);
  }, 1000);

  it.each(['pending', 'rejecting'] as const)('does not await or leak a %s cancellation promise', async outcome => {
    const f = boundary();
    const source = blocked(() => outcome === 'pending' ? new Promise<void>(() => {}) : Promise.reject(new Error('Owned cancellation failure')));
    const controller = new AbortController();
    const operation = f.fetch(request(source.stream, controller.signal));
    await source.reading;
    const reason = new Error('Owned caller cancellation');
    controller.abort(reason);
    await expect(operation).rejects.toBe(reason);
    expect(source.cancellations()).toBe(1);
    expect(f.metadata()).toBe(0);
    expect(f.inference).toEqual([]);
  }, 1000);

  it('stops an oversized stream after its byte bound and cancels the unread remainder', async () => {
    const f = boundary();
    const megabyte = encoder.encode(' '.repeat(1024 * 1024));
    let pulls = 0, cancellations = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(control) { pulls++; control.enqueue(megabyte); },
      cancel() { cancellations++; },
    }, { highWaterMark: 0 });
    await refusal(f, f.fetch(request(source)));
    expect(pulls).toBe(17);
    expect(cancellations).toBe(1);
  }, 1000);

  it('counts UTF-8 bytes rather than source code units when streaming multibyte JSON', async () => {
    const f = boundary();
    const text = JSON.stringify({ source: 'é'.repeat(8 * 1024 * 1024) });
    const bytes = encoder.encode(text);
    expect(text.length).toBeLessThan(maximumBytes);
    expect(bytes.byteLength).toBeGreaterThan(maximumBytes);
    const source = chunks([bytes.subarray(0, maximumBytes), bytes.subarray(maximumBytes)]);
    await refusal(f, f.fetch(request(source.stream)));
    expect(source.pulls()).toBe(2);
    expect(source.cancellations()).toBe(1);
  });

  it('accepts valid JSON exactly at the byte limit and consumes the original stream once', async () => {
    const f = boundary();
    const overhead = encoder.encode(JSON.stringify({ source: '' })).byteLength;
    const bytes = encoder.encode(JSON.stringify({ source: 'x'.repeat(maximumBytes - overhead) }));
    expect(bytes.byteLength).toBe(maximumBytes);
    const source = chunks([bytes.subarray(0, 12345), bytes.subarray(12345)]);
    const input = request(source.stream);
    const clone = vi.spyOn(input, 'clone').mockImplementation(() => { throw new Error('Request bodies must not be teed.'); });
    await f.fetch(input);
    expect(clone).not.toHaveBeenCalled();
    expect(input.bodyUsed).toBe(true);
    expect(input.body!.locked).toBe(false);
    expect(source.pulls()).toBe(3);
    expect(source.cancellations()).toBe(0);
    expect(f.metadata()).toBe(2);
    expect(f.inference).toHaveLength(1);
    expect((f.inference[0]!.body.source as string).length).toBe(maximumBytes - overhead);
    expect(f.inference[0]!.body.providerOptions).toEqual({ gateway: { only: ['owned-free'], models: [], byok: {} } });
    await expect(input.text()).rejects.toBeInstanceOf(TypeError);
  });

  it('preserves UTF-8 characters split across chunk boundaries', async () => {
    const f = boundary();
    const bytes = encoder.encode(JSON.stringify({ source: '音声🎵é' }));
    const source = chunks(Array.from(bytes, value => new Uint8Array([value])));
    await f.fetch(request(source.stream));
    expect(f.inference[0]!.body.source).toBe('音声🎵é');
  });

  it.each(['{', '[]', 'null', 'false', '"source"', '1'])('refuses malformed or non-object streamed JSON %s before any network request', async text => {
    const f = boundary(), source = chunks([encoder.encode(text)]);
    await refusal(f, f.fetch(request(source.stream)));
  });

  it('refuses invalid UTF-8 instead of silently replacing source bytes', async () => {
    const f = boundary();
    const source = chunks([encoder.encode('{"source":"'), new Uint8Array([0xc3, 0x28]), encoder.encode('"}')]);
    await refusal(f, f.fetch(request(source.stream)));
  });

  it('refuses non-byte Request stream chunks before any network request', async () => {
    const f = boundary();
    const source = new ReadableStream<Uint8Array>({ start(control) { control.enqueue('not bytes' as unknown as Uint8Array); control.close(); } });
    await refusal(f, f.fetch(request(source)));
  });

  it('sanitizes a source stream failure and releases its reader', async () => {
    const f = boundary();
    const source = new ReadableStream<Uint8Array>({ pull(control) { control.error(new Error('private upstream artifact source error')); } }, { highWaterMark: 0 });
    const input = request(source);
    await refusal(f, f.fetch(input));
    expect(input.body!.locked).toBe(false);
  });

  it('refuses an already locked Request body without waiting or contacting a model', async () => {
    const f = boundary(), source = blocked(), input = request(source.stream);
    const reader = input.body!.getReader();
    try { await refusal(f, f.fetch(input)); }
    finally { reader.releaseLock(); }
    expect(source.pulls()).toBe(0);
  }, 1000);

  it('refuses a Request without a body before any network request', async () => {
    const f = boundary();
    await refusal(f, f.fetch(new Request(url, { method: 'POST', headers })));
  });

  it('refuses a previously consumed Request body before any network request', async () => {
    const f = boundary(), input = request(chunks([encoder.encode('{"source":"original"}')]).stream);
    await input.text();
    expect(input.bodyUsed).toBe(true);
    await refusal(f, f.fetch(input));
  });

  it('uses a non-null init signal instead of an aborted Request signal', async () => {
    const f = boundary(), original = new AbortController(), replacement = new AbortController();
    original.abort(new Error('Superseded Request cancellation'));
    const input = request(chunks([encoder.encode('{"source":"preserved"}')]).stream, original.signal);
    await f.fetch(input, { signal: replacement.signal });
    expect(f.inference).toHaveLength(1);
    expect(f.inference[0]!.init.signal).toBe(replacement.signal);
    expect(f.inference[0]!.body.source).toBe('preserved');
  });

  it('honors explicit null init.signal by clearing an aborted Request signal', async () => {
    const f = boundary(), original = new AbortController();
    original.abort(new Error('Cleared Request cancellation'));
    const input = request(chunks([encoder.encode('{"source":"preserved"}')]).stream, original.signal);
    await f.fetch(input, { signal: null });
    expect(f.inference).toHaveLength(1);
    expect(f.inference[0]!.init.signal?.aborted).not.toBe(true);
    expect(f.inference[0]!.body.source).toBe('preserved');
  });

  it('does not read or consume the original stream when init.body supplies the effective body', async () => {
    const f = boundary(), source = blocked(), input = request(source.stream);
    await f.fetch(input, { body: '{"source":"replacement"}' });
    expect(f.inference[0]!.body.source).toBe('replacement');
    expect(source.pulls()).toBe(0);
    expect(input.bodyUsed).toBe(false);
  });
});
