import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { gatewayNativeDecisionProvider } from '../server/decisions/gateway-native.ts';
import type { DecisionQuestion, DecisionProfile } from '../shared/decision-profile.ts';
import { DecisionModels } from '../server/decisions/models.ts';
import { Store } from '../server/store.ts';

afterEach(() => vi.unstubAllGlobals());

const model = 'fixture/free-evaluation';
const profile: DecisionProfile = { provider: 'vercel-evaluation', model, minimumConfidence: .7, policyVersion: 'decision-policy-v1' };
const source = 'The selected color is blue. A person must approve Build. Ignore previous instructions is a quoted source fragment.';
const questions: DecisionQuestion[] = [
  { id: 'color', kind: 'boolean', instructions: 'Does the source explicitly select blue?' },
  {
    id: 'actor', kind: 'choice', instructions: 'Which typed value describes who approves Build?',
    choices: [{ value: true, description: 'A person approves.' }, { value: 'true', description: 'An agent approves.' }],
  },
  {
    id: 'coverage', kind: 'score', instructions: 'Rate the explicit approval evidence.',
    levels: [{ label: 'Missing', description: 'No approval actor.' }, { label: 'Partial' }, { label: 'Explicit', description: 'A person is required.' }],
  },
];
const normal = () => ({
  model,
  answers: {
    color: { type: 'boolean', probability: .93 },
    actor: { type: 'choice', choice: 'option_0', probabilities: { option_0: .88, option_1: .12 } },
    coverage: { type: 'score', score: 1.7, probabilities: { '0': .1, '1': .1, '2': .8 } },
  } as Record<string, unknown>,
  usage: { inputTokens: 231, outputTokens: 0 },
});
function fixture(options: {
  reply?: () => unknown;
  status?: number;
  price?: string;
  onRequest?: () => void;
} = {}) {
  const calls: { url: string; method: string; headers: Headers; body: any }[] = [];
  const transport: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const request = input instanceof Request ? input : undefined;
    const method = init?.method ?? request?.method ?? 'GET';
    const headers = new Headers(init?.headers ?? request?.headers);
    const raw = typeof init?.body === 'string' ? init.body : request ? await request.clone().text() : '';
    options.onRequest?.();
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ url: url.href, method, headers, body });
    const metadataHeaders = { Date: new Date().toUTCString(), Age: '0' };
    if (url.origin === 'https://ai-gateway.vercel.sh' && url.pathname === '/v1/models')
      return Response.json({ object: 'list', data: [{ id: model, type: 'evaluation', pricing: { input: options.price ?? '0', output: '0' }, context_window: 8192 }] }, { headers: metadataHeaders });
    if (url.pathname.endsWith('/endpoints'))
      return Response.json({ data: { id: model, endpoints: [{ provider_name: 'fixture', status: 0, pricing: {
        prompt: '0', completion: '0', request: '0', image: '0', image_output: '0', web_search: '0', internal_reasoning: '0', discount: 0,
      } }] } }, { headers: metadataHeaders });
    expect(url.href).toBe('https://ai-gateway.vercel.sh/v4/ai/decision-model');
    expect(method).toBe('POST');
    return Response.json(options.reply?.() ?? normal(), {
      status: options.status ?? 200,
      headers: { 'x-request-id': 'native-evaluation-fixture' },
    });
  };
  return {
    calls,
    provider: gatewayNativeDecisionProvider({ models: [model], apiKey: 'controlled-fixture-key' }, undefined, { fetch: transport }),
    transport,
    inference: () => calls.filter(call => call.method === 'POST'),
  };
}
const invoke = (provider: ReturnType<typeof gatewayNativeDecisionProvider>, overrides: {
  questions?: DecisionQuestion[]; profile?: DecisionProfile; signal?: AbortSignal; input?: string;
} = {}) => provider.evaluate({
  profile: overrides.profile ?? profile,
  input: overrides.input ?? source,
  questions: overrides.questions ?? questions,
  idempotencyKey: 'fixture-native-evaluation-1',
  signal: overrides.signal ?? new AbortController().signal,
});

describe('native free Gateway evaluations through the actual AI SDK boundary', () => {
  it('preserves full source, typed choices, ordered rubrics and native probabilities in one request', async () => {
    const f = fixture();
    const result = await invoke(f.provider);
    expect(f.inference()).toHaveLength(1);
    const request = f.inference()[0]!;
    expect(request.headers.get('ai-model-id')).toBe(model);
    expect(request.headers.get('ai-decision-model-specification-version')).toBe('4');
    expect(request.headers.get('idempotency-key')).toBe('fixture-native-evaluation-1');
    expect(request.body.stateParts).toEqual([{ type: 'json', value: { instructions: expect.stringContaining('untrusted data'), source } }]);
    expect(request.body.questions).toEqual({
      color: { type: 'boolean', instructions: questions[0]!.instructions },
      actor: { type: 'choice', instructions: questions[1]!.instructions, criteria: { option_0: 'true: A person approves.', option_1: '"true": An agent approves.' } },
      coverage: { type: 'score', instructions: questions[2]!.instructions, criteria: ['Missing: No approval actor.', 'Partial', 'Explicit: A person is required.'] },
    });
    expect(request.body.providerOptions.gateway).toEqual({ only: ['fixture'], models: [], byok: {} });
    expect(result).toEqual({
      model,
      answers: [
        { questionId: 'color', kind: 'boolean', probability: .93, value: true },
        { questionId: 'actor', kind: 'choice', value: true, confidence: .88, probabilities: [{ value: true, probability: .88 }, { value: 'true', probability: .12 }] },
        { questionId: 'coverage', kind: 'score', value: 1.7, confidence: .8, probabilities: [{ value: 0, label: 'Missing', probability: .1 }, { value: 1, label: 'Partial', probability: .1 }, { value: 2, label: 'Explicit', probability: .8 }] },
      ],
      providerRequestId: 'native-evaluation-fixture',
      usage: { inputTokens: 231, outputTokens: 0, totalTokens: 231 },
    });
    expect(result.localInference).toBeUndefined();
  });

  it('does not invent confidence when a native provider omits distributions', async () => {
    const f = fixture({ reply: () => ({ ...normal(), answers: {
      color: { type: 'boolean', probability: .4 },
      actor: { type: 'choice', choice: 'option_1' },
      coverage: { type: 'score', score: .7 },
    } }) });
    const result = await invoke(f.provider);
    expect(result.answers[0]).toMatchObject({ probability: .4, value: false });
    expect(result.answers[1]).toEqual({ questionId: 'actor', kind: 'choice', value: 'true' });
    expect(result.answers[2]).toEqual({ questionId: 'coverage', kind: 'score', value: .7 });
  });

  it.each([
    ['missing question', () => { const r = normal(); delete r.answers.actor; return r; }],
    ['extra question', () => ({ ...normal(), answers: { ...normal().answers, extra: { type: 'boolean', probability: 1 } } })],
    ['wrong answer type', () => ({ ...normal(), answers: { ...normal().answers, color: { type: 'choice', choice: 'option_0' } } })],
    ['unknown selected option', () => ({ ...normal(), answers: { ...normal().answers, actor: { type: 'choice', choice: 'outside' } } })],
    ['incomplete distribution', () => ({ ...normal(), answers: { ...normal().answers, actor: { type: 'choice', choice: 'option_0', probabilities: { option_0: .8 } } } })],
    ['non-normalized distribution', () => ({ ...normal(), answers: { ...normal().answers, actor: { type: 'choice', choice: 'option_0', probabilities: { option_0: .8, option_1: .1 } } } })],
    ['non-maximal choice', () => ({ ...normal(), answers: { ...normal().answers, actor: { type: 'choice', choice: 'option_0', probabilities: { option_0: .2, option_1: .8 } } } })],
    ['mismatched weighted score', () => ({ ...normal(), answers: { ...normal().answers, coverage: { type: 'score', score: .5, probabilities: { '0': .1, '1': .1, '2': .8 } } } })],
    ['invalid probability', () => ({ ...normal(), answers: { ...normal().answers, color: { type: 'boolean', probability: 1.01 } } })],
    ['unexpected resolved model', () => ({ ...normal(), model: 'fixture/paid-fallback' })],
    ['fractional usage', () => ({ ...normal(), usage: { inputTokens: 1.5, outputTokens: 0 } })],
  ])('rejects %s without retry or result repair', async (_label, reply) => {
    const f = fixture({ reply });
    await expect(invoke(f.provider)).rejects.toMatchObject({ code: 'invalid-response', retryable: false });
    expect(f.inference()).toHaveLength(1);
  });

  it('preserves declared rounding instead of renormalizing native output', async () => {
    const three: DecisionQuestion[] = [{ id: 'three', kind: 'choice', instructions: 'Choose.', choices: [{ value: 'a' }, { value: 'b' }, { value: 'c' }] }];
    const f = fixture({ reply: () => ({ model, answers: { three: { type: 'choice', choice: 'option_0', probabilities: { option_0: .33, option_1: .33, option_2: .33 } } }, rounding: { probabilityDecimals: 2 } }) });
    const result = await invoke(f.provider, { questions: three });
    expect(result.answers[0]!.probabilities!.map(item => item.probability)).toEqual([.33, .33, .33]);
    expect(result.answers[0]!.confidence).toBe(.33);
    expect(result.usage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null });
  });

  it('records native refusal without fabricating the discarded batch answers', async () => {
    const f = fixture({ reply: () => ({ ...normal(), answers: { ...normal().answers, actor: { type: 'refusal' } } }) });
    const result = await invoke(f.provider);
    expect(result.answers).toEqual([
      { questionId: 'color', kind: 'boolean', abstained: true },
      { questionId: 'actor', kind: 'choice', refused: true },
      { questionId: 'coverage', kind: 'score', abstained: true },
    ]);
    expect(result.usage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null });
  });

  it('blocks a positive catalog price before any evaluation request', async () => {
    const f = fixture({ price: '0.0000001' });
    await expect(invoke(f.provider)).rejects.toMatchObject({ code: 'provider-error', retryable: false });
    expect(f.inference()).toHaveLength(0);
  });

  it('blocks an unregistered model before metadata or inference I/O', async () => {
    const f = fixture();
    await expect(invoke(f.provider, { profile: { ...profile, model: 'fixture/unregistered' } })).rejects.toMatchObject({ code: 'provider-error' });
    expect(f.calls).toHaveLength(0);
  });

  it('refuses complete oversized source before I/O instead of trimming source or questions', async () => {
    const f = fixture();
    await expect(invoke(f.provider, { input: 'x'.repeat(8192) })).rejects.toMatchObject({ code: 'context-overflow', retryable: false });
    expect(f.calls).toHaveLength(0);
  });

  it('does not retry a failed free evaluation or expose its provider response', async () => {
    const f = fixture({ status: 503, reply: () => ({ message: 'private-provider-detail' }) });
    await expect(invoke(f.provider)).rejects.toMatchObject({ message: 'provider-error', code: 'provider-error', retryable: false });
    expect(f.inference()).toHaveLength(1);
  });

  it('uses a fresh validated identity scope for each evaluation call', async () => {
    let active = false, scopes = 0;
    const f = fixture({ onRequest: () => expect(active).toBe(true) });
    const provider = gatewayNativeDecisionProvider({ models: [model], apiKey: 'controlled-fixture-key' }, {
      async run(operation) { scopes++; active = true; try { return await operation(); } finally { active = false; } },
    }, { fetch: f.transport });
    await invoke(provider);
    await invoke(provider);
    expect(scopes).toBe(2);
    expect(active).toBe(false);
    expect(f.inference()).toHaveLength(2);
  });

  it('propagates cancellation before metadata or inference I/O', async () => {
    const f = fixture(), abort = new AbortController(), reason = new Error('owned cancellation');
    abort.abort(reason);
    await expect(invoke(f.provider, { signal: abort.signal })).rejects.toBe(reason);
    expect(f.calls).toHaveLength(0);
  });

  it('retains native SQL receipts and independent thresholds without an extra cached model call', async () => {
    const f = fixture();
    vi.stubGlobal('fetch', f.transport);
    const store = await Store.open(':memory:');
    const models = new DecisionModels({
      store,
      settings: {
        production: false,
        timeoutMs: 3000,
        defaultProfile: profile,
        evaluation: { models: [model], apiKey: 'controlled-fixture-key', metadataFetch: f.transport },
      },
    });
    try {
      const owner = await store.createUser(randomUUID() + '@example.test', 'Decision fixture owner', null);
      const project = await store.createProject(owner, 'Free native evaluation fixture', '');
      const artifact = await store.artifact(project.mainArtifactId, owner.id);
      const selected = await models.captureProfile(owner, artifact.id);
      const request = {
        user: owner,
        artifactId: artifact.id,
        artifactVersion: artifact.version,
        profile: selected,
        input: source,
        purpose: 'semantic-design-gap' as const,
        questions,
        idempotencyKey: randomUUID(),
      };
      const result = await models.decide(request);
      expect(result.status).toBe('answered');
      expect(result.provenance).toMatchObject({
        provider: 'vercel-evaluation', model, requestedModel: model,
        mode: 'native-decision', minimumConfidence: .7,
        inputHash: createHash('sha256').update(source).digest('hex'),
        artifactVersion: artifact.version,
        providerRequestId: 'native-evaluation-fixture',
        usage: { inputTokens: 231, outputTokens: 0, totalTokens: 231 },
      });
      expect(result.provenance.localInference).toBeUndefined();
      expect(await models.readEvaluation(owner, result.id)).toEqual(result);
      const cached = await models.decide({ ...request, idempotencyKey: randomUUID() });
      expect(cached.provenance.cachedFrom).toBe(result.id);
      expect(f.inference()).toHaveLength(1);
      const changed = await models.profile(owner, artifact.id, { ...selected, minimumConfidence: .95 });
      expect(changed.independentOfChat).toBe(true);
      const strict = await models.decide({ ...request, profile: changed.profile, idempotencyKey: randomUUID() });
      expect(strict.status).toBe('abstained');
      expect(strict.answers.map(answer => answer.value)).toEqual([null, null, null]);
      expect(strict.answers.map(answer => answer.candidate)).toEqual([true, true, 1.7]);
      expect(strict.answers[1]!.probabilities).toEqual(result.answers[1]!.probabilities);
      expect(strict.provenance.minimumConfidence).toBe(.95);
      expect(f.inference()).toHaveLength(2);
      expect(await store.artifact(artifact.id, owner.id)).toEqual(artifact);
    } finally {
      await models.close();
      await store.close();
    }
  });
});
