import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.ts';
import { DecisionModels } from '../server/decisions/models.ts';
import { decisionSettingsFromEnv } from '../server/decisions/settings.ts';
import {
  decisionProfileSchema,
  type DecisionQuestion,
} from '../shared/decision-profile.ts';
import { AgentProfiles } from '../server/integrations/agent-profiles.ts';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const predicate: DecisionQuestion = {
  id: 'relevant',
  kind: 'boolean',
  instructions:
    'Does the quoted input contain an unresolved implementation choice?',
};
const usage = {
  input_tokens: 10,
  output_tokens: 4,
  total_tokens: 14,
  input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
  output_tokens_details: { reasoning_tokens: 0 },
};
async function http(
  handler: (body: any, response: any, request: any) => void | Promise<void>,
) {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let source = '';
    for await (const part of req) source += part;
    const body = JSON.parse(source);
    requests.push({ path: req.url, body, headers: req.headers });
    res.setHeader('Content-Type', 'application/json');
    await handler(body, res, req);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return {
    url: `http://127.0.0.1:${(server.address() as any).port}`,
    requests,
  };
}
const answer = (body: any, p = 0.95) => ({
  model: body.model,
  answers: body.questions.map((q: any) => ({
    name: q.name,
    type: 'predicate',
    probability: p,
  })),
  usage,
});
async function workspace(settings: any) {
  const store = await Store.open(':memory:');
  cleanup.push(() => store.close());
  const user = await store.createUser(
      randomUUID() + '@test.invalid',
      'Decision owner',
      null,
    ),
    project = await store.createProject(user, 'Independent decisions', ''),
    artifact = await store.artifact(project.mainArtifactId, user.id);
  const models = new DecisionModels({ store, settings });
  await models.ready;
  cleanup.push(() => models.close());
  const profile = await models.captureProfile(user, artifact.id);
  const request = (overrides: any = {}) => ({
    user,
    artifactId: artifact.id,
    artifactVersion: artifact.version,
    profile,
    input: 'The team has not chosen the integration boundary.',
    purpose: 'conversation-offer' as const,
    questions: [predicate],
    idempotencyKey: randomUUID(),
    ...overrides,
  });
  return {
    store,
    user,
    project,
    artifact,
    models,
    profile,
    settings,
    request,
  };
}
const native = (url: string, overrides: any = {}) => ({
  production: false,
  timeoutMs: 3000,
  defaultProfile: decisionProfileSchema.parse({
    provider: 'openai-decisions',
    model: 'gpt-6-luna',
  }),
  openai: {
    baseUrl: url + '/v1',
    apiKey: 'explicit-openai-decisions-fixture-key',
    models: ['gpt-6-luna'],
  },
  ...overrides,
});
describe('independent typed decision models over actual native HTTP contracts', () => {
  it('preserves native OpenAI predicate probability, choice confidence, score expectation and per-question refusal separately', async () => {
    const api = await http((body, res) =>
      res.end(
        JSON.stringify({
          model: body.model,
          usage,
          answers: [
            { type: 'predicate', name: 'relevant', probability: 0.95 },
            {
              type: 'choice',
              name: 'kind',
              choice: 'diagram',
              confidence: 0.61,
              probabilities: [
                { value: 'prose', probability: 0.1 },
                { value: 'diagram', probability: 0.9 },
              ],
            },
            {
              type: 'score',
              name: 'severity',
              score: 0.4,
              confidence: 0.9,
              probabilities: [
                { value: 0, label: 'Low', probability: 0.6 },
                { value: 1, label: 'High', probability: 0.4 },
              ],
            },
            { type: 'refusal', name: 'private' },
          ],
        }),
      ),
    );
    const w = await workspace(native(api.url));
    const questions: DecisionQuestion[] = [
      predicate,
      {
        id: 'kind',
        kind: 'choice',
        instructions: 'Select the useful explanatory form.',
        choices: [{ value: 'prose' }, { value: 'diagram' }],
      },
      {
        id: 'severity',
        kind: 'score',
        instructions: 'Rate the input severity.',
        levels: [{ label: 'Low' }, { label: 'High' }],
      },
      {
        id: 'private',
        kind: 'boolean',
        instructions: 'Determine whether the input can be evaluated.',
      },
    ];
    const result = await w.models.decide(w.request({ questions }));
    expect(result.status).toBe('partial');
    expect(result.answers[0]).toMatchObject({
      status: 'answered',
      value: true,
      probability: 0.95,
      confidence: null,
    });
    expect(result.answers[1]).toMatchObject({
      status: 'abstained',
      value: null,
      candidate: 'diagram',
      confidence: 0.61,
    });
    expect(result.answers[1]!.probabilities[1]?.probability).toBe(0.9);
    expect(result.answers[2]).toMatchObject({
      status: 'answered',
      value: 0.4,
      confidence: 0.9,
    });
    expect(result.answers[3]).toMatchObject({
      status: 'refused',
      value: null,
      error: 'provider-refusal',
    });
    expect(result.provenance.usage).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
    });
    expect(result.provenance.adapterVersion).toContain('2ac178e');
    expect(api.requests[0].path).toBe('/v1/decisions');
    expect(api.requests[0].headers.authorization).toBe(
      'Bearer explicit-openai-decisions-fixture-key',
    );
    expect(api.requests[0].body.questions[0]).toEqual({
      name: 'relevant',
      type: 'predicate',
      instructions: predicate.instructions,
    });
  });
  it('uses native Jev noul/choice/score and keeps typed values and unknown usage intact', async () => {
    const api = await http((body, res) =>
      res.end(
        JSON.stringify({
          model: 'jev-released-model',
          answers: {
            relevant: { type: 'noul', noul: 0.02 },
            typed: {
              type: 'choice',
              choice: 'option_1',
              confidence: 0.95,
              probabilities: { option_0: 0.1, option_1: 0.9 },
            },
            severity: {
              type: 'score',
              score: 0.3,
              confidence: 0.9,
              legend: { 0: 'Low', 1: 'High' },
              probabilities: { 0: 0.7, 1: 0.3 },
            },
          },
          usage: { input_tokens: null, output_tokens: null },
        }),
      ),
    );
    const w = await workspace(
      native(api.url, {
        defaultProfile: decisionProfileSchema.parse({
          provider: 'jev',
          model: 'jev-latest',
        }),
        jev: {
          baseUrl: api.url,
          apiKey: 'explicit-jev-fixture-key',
          models: ['jev-latest'],
        },
      }),
    );
    const questions: DecisionQuestion[] = [
      predicate,
      {
        id: 'typed',
        kind: 'choice',
        instructions: 'Choose between these typed values.',
        choices: [{ value: false }, { value: 'false' }],
      },
      {
        id: 'severity',
        kind: 'score',
        instructions: 'Rate severity.',
        levels: [{ label: 'Low' }, { label: 'High' }],
      },
    ];
    const result = await w.models.decide(w.request({ questions }));
    expect(result.answers[0]).toMatchObject({
      value: false,
      probability: 0.02,
      confidence: null,
    });
    expect(result.answers[1]?.value).toBe('false');
    expect(result.answers[1]!.probabilities.map((x) => x.value)).toEqual([
      false,
      'false',
    ]);
    expect(result.provenance).toMatchObject({
      requestedModel: 'jev-latest',
      model: 'jev-released-model',
      modelResolution: 'provider-reported-unresolved',
      usage: { inputTokens: null, outputTokens: null, totalTokens: null },
    });
    expect(api.requests[0].path).toBe('/v1/systemone');
    expect(api.requests[0].body.questions.relevant).toEqual({
      type: 'noul',
      instructions: predicate.instructions,
    });
    expect(api.requests[0].body.questions.typed.criteria.option_1).toContain(
      'string: "false"',
    );
  });
  it('deduplicates exact keys and scoped source hashes but rejects changed input under one key', async () => {
    const api = await http((body, res) =>
      res.end(JSON.stringify(answer(body))),
    );
    const w = await workspace(native(api.url)),
      input = w.request({ idempotencyKey: 'stable' });
    const original = await w.models.decide(input);
    expect((await w.models.decide(input)).id).toBe(original.id);
    const cached = await w.models.decide({
      ...input,
      idempotencyKey: 'another-admission',
    });
    expect(cached.id).not.toBe(original.id);
    expect(cached.provenance.cachedFrom).toBe(original.id);
    expect(cached.provenance.usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    });
    expect(api.requests).toHaveLength(1);
    await expect(
      w.models.decide({ ...input, input: 'Changed source.' }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(api.requests).toHaveLength(1);
    await w.store.exec(
      'DELETE FROM memberships WHERE project_id=? AND user_id=?',
      w.project.id,
      w.user.id,
    );
    await expect(w.models.decide(input)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(api.requests).toHaveLength(1);
  });
  it('retains independent persisted picker choices and rejects viewer writes', async () => {
    const w = await workspace(native('http://127.0.0.1:1'));
    const chat = new AgentProfiles(
      w.store,
      { model: 'fixture/chat' } as any,
      {},
    );
    await chat.initialize();
    await chat.view(w.user, w.artifact.id, {
      harness: 'vercel-fx',
      provider: 'ai-gateway',
      model: 'fixture/chat',
    });
    const view = await w.models.profile(
      w.user,
      w.artifact.id,
      decisionProfileSchema.parse({ provider: 'jev', model: 'jev-latest' }),
    );
    expect(view.profile.provider).toBe('jev');
    expect(view.independentOfChat).toBe(true);
    expect((await chat.selected(w.artifact.id)).harness).toBe('vercel-fx');
    const viewer = await w.store.createUser(
      'viewer-' + randomUUID() + '@test.invalid',
      'Viewer',
      null,
    );
    await w.store.exec(
      'INSERT INTO memberships VALUES(?,?,?)',
      w.project.id,
      viewer.id,
      'viewer',
    );
    await expect(
      w.models.profile(viewer, w.artifact.id, w.profile),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(
      (await w.models.profile(viewer, w.artifact.id)).profile.provider,
    ).toBe('jev');
  });
  it('fails closed for missing native credentials, changed registrations and unregistered models without fallback', async () => {
    const w = await workspace({
      production: false,
      timeoutMs: 3000,
      defaultProfile: decisionProfileSchema.parse({
        provider: 'openai-decisions',
        model: 'gpt-6-luna',
      }),
    });
    await expect(w.models.decide(w.request())).rejects.toMatchObject({
      statusCode: 503,
    });
    const api = await http((body, res) =>
      res.end(JSON.stringify(answer(body))),
    );
    const second = new DecisionModels({
      store: w.store,
      settings: native(api.url),
    });
    await second.ready;
    cleanup.push(() => second.close());
    await expect(second.decide(w.request())).rejects.toMatchObject({
      statusCode: 409,
    });
    const fresh = await second.captureProfile(w.user, w.artifact.id);
    await expect(
      second.decide(
        w.request({ profile: { ...fresh, model: 'unregistered' } }),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(api.requests).toHaveLength(0);
  });
  it('makes malformed native distributions and Jev null answers explicit errors rather than negative decisions', async () => {
    const api = await http((body, res) =>
      res.end(
        JSON.stringify({
          model: body.model,
          answers: [
            {
              type: 'choice',
              name: 'kind',
              choice: 'a',
              confidence: 0.9,
              probabilities: { a: 0.8, b: 0.2 },
            },
          ],
          usage,
        }),
      ),
    );
    const w = await workspace(native(api.url));
    const result = await w.models.decide(
      w.request({
        questions: [
          {
            id: 'kind',
            kind: 'choice',
            instructions: 'Pick.',
            choices: [{ value: 'a' }, { value: 'b' }],
          },
        ],
      }),
    );
    expect(result.status).toBe('error');
    expect(result.answers[0]).toMatchObject({
      value: null,
      error: 'invalid-response',
    });
    expect(api.requests).toHaveLength(1);
    const jev = await http((_b, res) =>
      res.end(
        JSON.stringify({
          model: 'jev-latest',
          answers: { relevant: null },
          usage: { input_tokens: null, output_tokens: null },
        }),
      ),
    );
    const other = new DecisionModels({
      store: w.store,
      settings: native(api.url, {
        defaultProfile: decisionProfileSchema.parse({
          provider: 'jev',
          model: 'jev-latest',
        }),
        jev: {
          baseUrl: jev.url,
          apiKey: 'explicit-jev-key',
          models: ['jev-latest'],
        },
      }),
    });
    await other.ready;
    cleanup.push(() => other.close());
    const profile = await other.profile(
      w.user,
      w.artifact.id,
      decisionProfileSchema.parse({ provider: 'jev', model: 'jev-latest' }),
    );
    const invalid = await other.decide(
      w.request({ profile: profile.profile }),
    );
    expect(invalid.status).toBe('error');
    expect(invalid.answers[0]?.value).toBeNull();
    expect(invalid.answers[0]?.status).not.toBe('refused');
  });
  it('bounds transient native retries without invoking a configured structured alternative', async () => {
    const api = await http((_b, res) => {
        res.statusCode = 503;
        res.end('{"error":"provider outage"}');
      }),
      fallback = await http((_b, res) => res.end('{}'));
    const w = await workspace(
      native(api.url, {
        structured: {
          baseUrl: fallback.url,
          apiKey: 'explicit-fallback-fixture-key',
          models: ['fixture/decision'],
        },
      }),
    );
    const result = await w.models.decide(w.request());
    expect(result.status).toBe('error');
    expect(result.answers[0]?.value).toBeNull();
    expect(api.requests).toHaveLength(3);
    expect(fallback.requests).toHaveLength(0);
  });
  it('preserves explicit cancellation while a real native HTTP response is pending', async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => (started = resolve)),
      api = await http(() => started()),
      w = await workspace(native(api.url));
    const controller = new AbortController(),
      running = w.models.decide(w.request({ signal: controller.signal }));
    await ready;
    controller.abort();
    const result = await running;
    expect(result.status).toBe('cancelled');
    expect(result.answers[0]).toMatchObject({
      value: null,
      error: 'cancelled',
    });
    expect((await w.models.history(w.user, w.artifact.id))[0]?.status).toBe(
      'cancelled',
    );
  });
  it('rejects oversized UTF-8 contexts without truncation or network requests, and prevents HTTP inside SQL transactions', async () => {
    const api = await http((body, res) =>
      res.end(JSON.stringify(answer(body))),
    );
    const w = await workspace(
      native(api.url, {
        defaultProfile: decisionProfileSchema.parse({
          provider: 'jev',
          model: 'jev-latest',
        }),
        jev: {
          baseUrl: api.url,
          apiKey: 'fixture-jev',
          models: ['jev-latest'],
        },
      }),
    );
    await expect(
      w.models.decide(w.request({ input: '🙂'.repeat(8000) })),
    ).rejects.toMatchObject({ statusCode: 413 });
    expect(api.requests).toHaveLength(0);
    await expect(
      w.store.tx(() => w.models.decide(w.request())),
    ).rejects.toThrow('outside source SQL');
    expect(api.requests).toHaveLength(0);
  });
  it('uses structured AI SDK decisions only under explicit selection and does not invent native reliability values', async () => {
    const api = await http((_body, res) =>
      res.end(
        JSON.stringify({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                answers: [
                  { id: 'relevant', status: 'answered', value: true },
                ],
              }),
            },
          ],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: {
              total: 4,
              noCache: 4,
              cacheRead: 0,
              cacheWrite: 0,
            },
            outputTokens: { total: 2, text: 2, reasoning: 0 },
          },
          warnings: [],
        }),
      ),
    );
    const w = await workspace(
      native('http://127.0.0.1:1', {
        structured: {
          baseUrl: api.url,
          apiKey: 'explicit-sdk-decision-fixture',
          models: ['fixture/decision'],
        },
      }),
    );
    await w.models.profile(
      w.user,
      w.artifact.id,
      decisionProfileSchema.parse({
        provider: 'vercel-structured',
        model: 'fixture/decision',
      }),
    );
    const result = await w.models.decide(
      w.request({
        profile: await w.models.captureProfile(w.user, w.artifact.id),
      }),
    );
    expect(result.status).toBe('abstained');
    expect(result.answers[0]).toMatchObject({
      value: null,
      candidate: true,
      error: 'unscored-answer',
      probability: null,
      confidence: null,
      probabilities: [],
    });
    expect(result.provenance.mode).toBe('structured-generation');
    expect(api.requests[0].path).toBe('/language-model');
  });
  it('validates endpoint security and independent environment defaults', () => {
    const settings = decisionSettingsFromEnv({
      NODE_ENV: 'production',
      STUDIO_MODEL: 'chat/model',
    });
    expect(settings.defaultProfile.provider).toBe('llama-cpp-cpu');
    expect(settings.structured).toBeUndefined();
    expect(() =>
      decisionSettingsFromEnv({
        NODE_ENV: 'production',
        OPENAI_API_KEY: 'fixture',
        STUDIO_OPENAI_DECISIONS_BASE_URL: 'http://127.0.0.1:1',
      }),
    ).toThrow('HTTPS');
  });
  it('rejects mismatched native Jev answer types and inconsistent selected choice probabilities', async () => {
    const jev = await http((_body, res) =>
      res.end(
        JSON.stringify({
          model: 'jev-latest',
          answers: { relevant: { type: 'choice', noul: 0.95 } },
          usage: { input_tokens: null, output_tokens: null },
        }),
      ),
    );
    const w = await workspace(
      native(jev.url, {
        defaultProfile: decisionProfileSchema.parse({
          provider: 'jev',
          model: 'jev-latest',
        }),
        jev: {
          baseUrl: jev.url,
          apiKey: 'jev-fixture',
          models: ['jev-latest'],
        },
      }),
    );
    expect((await w.models.decide(w.request())).answers[0]).toMatchObject({
      status: 'error',
      value: null,
      error: 'invalid-response',
    });
    const api = await http((body, res) =>
      res.end(
        JSON.stringify({
          model: body.model,
          usage,
          answers: [
            {
              type: 'choice',
              name: 'kind',
              choice: 'a',
              confidence: 0.95,
              probabilities: [
                { value: 'a', probability: 0.1 },
                { value: 'b', probability: 0.9 },
              ],
            },
          ],
        }),
      ),
    );
    const other = new DecisionModels({
      store: w.store,
      settings: native(api.url),
    });
    await other.ready;
    cleanup.push(() => other.close());
    const profile = (
      await other.profile(
        w.user,
        w.artifact.id,
        decisionProfileSchema.parse({
          provider: 'openai-decisions',
          model: 'gpt-6-luna',
        }),
      )
    ).profile;
    expect(
      (
        await other.decide(
          w.request({
            profile,
            questions: [
              {
                id: 'kind',
                kind: 'choice',
                instructions: 'Pick.',
                choices: [{ value: 'a' }, { value: 'b' }],
              },
            ],
          }),
        )
      ).answers[0],
    ).toMatchObject({
      status: 'error',
      value: null,
      error: 'invalid-response',
    });
  });
});

describe('shared decision admission and receipt integrity', () => {
  it('charges actual attempts once, keeps cache and idempotent reads free, and shares the project budget across principals', async () => {
    const api = await http((body, res) =>
      res.end(JSON.stringify(answer(body))),
    );
    const w = await workspace(
      native(api.url, {
        budget: {
          principalPerHour: 1,
          projectPerHour: 1,
          principalConcurrent: 1,
          projectConcurrent: 1,
        },
      }),
    );
    const request = w.request();
    const first = await w.models.decide(request);
    expect((await w.models.decide(request)).id).toBe(first.id);
    const cached = await w.models.decide({
      ...request,
      idempotencyKey: randomUUID(),
    });
    expect(cached.provenance.cachedFrom).toBe(first.id);
    const limited = await w.models.decide(
      w.request({ input: 'A different unresolved boundary needs a choice.' }),
    );
    expect(limited.answers[0]).toMatchObject({
      status: 'error',
      error: 'budget-exhausted',
      value: null,
    });
    const member = await w.store.createUser(
      randomUUID() + '@test.invalid',
      'Another writer',
      null,
    );
    await w.store.exec(
      'INSERT INTO memberships(project_id,user_id,role) VALUES(?,?,?)',
      w.project.id,
      member.id,
      'editor',
    );
    const other = await w.models.decide(
      w.request({ user: member, input: 'Another writer needs a decision.' }),
    );
    expect(other.answers[0]?.error).toBe('budget-exhausted');
    expect(api.requests).toHaveLength(1);
    expect(
      Number(
        (
          await w.store.one(
            'SELECT COUNT(*) AS n FROM studio_decision_admissions',
          )
        )?.n,
      ),
    ).toBe(1);
  });
  it('rejects changed stored receipts on direct reads, idempotent replay and cache reuse', async () => {
    const api = await http((body, res) =>
      res.end(JSON.stringify(answer(body))),
    );
    const w = await workspace(native(api.url));
    const request = w.request(),
      result = await w.models.decide(request);
    await w.store.exec(
      'UPDATE studio_decision_calls SET result_json=? WHERE id=?',
      JSON.stringify({ ...result, status: 'refused' }),
      result.id,
    );
    await expect(
      w.models.readEvaluation(w.user, result.id),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(w.models.decide(request)).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(
      w.models.decide({ ...request, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(api.requests).toHaveLength(1);
  });
  it('fences a revoked in-flight actor and records cancellation without retaining the provider answer', async () => {
    let release!: () => void, arrived!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve)),
      incoming = new Promise<void>((resolve) => (arrived = resolve));
    const api = await http(async (body, res) => {
      arrived();
      await gate;
      res.end(JSON.stringify(answer(body)));
    });
    const w = await workspace(native(api.url, { leaseMs: 600 }));
    const member = await w.store.createUser(
      randomUUID() + '@test.invalid',
      'Revoked writer',
      null,
    );
    await w.store.exec(
      'INSERT INTO memberships(project_id,user_id,role) VALUES(?,?,?)',
      w.project.id,
      member.id,
      'editor',
    );
    const running = w.models.decide(w.request({ user: member }));
    const observed = running.catch((error) => error);
    await incoming;
    await w.store.tx(async () => {
      await w.store.db.lock('project:' + w.project.id);
      await w.store.exec(
        'DELETE FROM memberships WHERE project_id=? AND user_id=?',
        w.project.id,
        member.id,
      );
    });
    release();
    expect(await observed).toMatchObject({ statusCode: 404 });
    const row = await w.store.one(
      'SELECT * FROM studio_decision_calls WHERE user_id=?',
      member.id,
    );
    expect(row.status).toBe('cancelled');
    expect(row.error_code).toBe('access-revoked');
    expect(JSON.parse(row.result_json).answers[0]).toMatchObject({
      value: null,
      candidate: null,
      probability: null,
      error: 'access-revoked',
    });
  });
});
