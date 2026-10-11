import { describe, expect, it, vi } from 'vitest';
import type { CheckGenRequest, ChatModel, JsonValue, ModelRequest, ModelResponse, NodeKey } from '../../src/contracts/index.ts';
import { AiBddError } from '../../src/contracts/index.ts';
import { CHECKGEN_PROMPT_VERSION, createAsserter } from '../../src/assert/index.ts';
import { computeVolatileNodes } from '../../src/assert/generate.ts';
import { checkgenJsonSchema } from '../../src/assert/schema.ts';
import { checkgenSystemPrompt } from '../../src/assert/prompt.ts';
import { CONFIG, configWith, fakeEvidence, fakeRedactor, leaf, makeObs, q, scriptedModel, type NodeSpec, type ScriptStep } from './helpers.ts';

/*
 * Exact-value tests for the pieces of check generation that the behavioural tests in generate.test.ts leave loose: the model
 * request and evidence payload, the retry feedback text, the error messages the model is shown, the fuzzy-reason classification
 * and the volatile-node bookkeeping.
 */

const BEFORE: NodeSpec[] = [
  leaf('heading', 'Billing'),
  leaf('status', 'Current plan', { text: 'Free plan' }),
  leaf('button', 'Upgrade to Pro'),
];
const AFTER: NodeSpec[] = [
  leaf('heading', 'Billing'),
  leaf('status', 'Current plan', { text: 'Pro plan' }),
  leaf('status', 'Confirmation', { text: 'Your plan was upgraded' }),
];

function request(over: Partial<CheckGenRequest> = {}): CheckGenRequest {
  return {
    scenarioId: 'billing--upgrade/upgrade-to-pro', stepKey: 'then:abc123', criterion: 'the confirmation says the plan was upgraded',
    params: {}, before: makeObs(BEFORE, '/billing'), after: makeObs(AFTER, '/billing'), afterProbe: makeObs(AFTER, '/billing'), actionPreceded: true, ...over,
  };
}

const goodChange: JsonValue = {
  classification: 'change',
  predicates: [
    { op: 'text', query: q({ role: 'status', name: 'Confirmation' }), match: 'contains', value: { literal: 'upgraded' } },
    { op: 'text', query: q({ role: 'status', name: 'Current plan' }), match: 'contains', value: { literal: 'Pro' } },
  ],
};
const existsOnBoth: JsonValue = { classification: 'change', predicates: [{ op: 'exists', query: q({ role: 'heading', name: 'Billing' }) }] };
const one = (maxAttempts = 1) => ({ checks: { maxAttempts } });

function setup(steps: ScriptStep[], opts: { checks?: Partial<typeof CONFIG.checks>; secrets?: Record<string, string>; withEvidence?: boolean } = {}) {
  const model = scriptedModel(steps);
  const evidence = opts.withEvidence ? fakeEvidence() : undefined;
  const asserter = createAsserter({
    model, redactor: fakeRedactor(opts.secrets), config: opts.checks ? configWith(opts.checks) : CONFIG, ...(evidence ? { evidence } : {}),
  });
  return { model, asserter, evidence };
}

/** A ChatModel double whose responses are written out in full (the scripted model always fills object, modelId and finishReason). */
function rawModel(id: string, responses: (ModelResponse | Error | ((req: ModelRequest) => ModelResponse | Error))[]): ChatModel & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    id, requests,
    async generate(req) {
      requests.push(req);
      const step = responses[Math.min(requests.length - 1, responses.length - 1)]!;
      const out = typeof step === 'function' ? step(req) : step;
      if (out instanceof Error) throw out;
      return out;
    },
  };
}

const USAGE = { inputTokens: 3, outputTokens: 2 };
const resp = (over: Partial<ModelResponse>): ModelResponse => ({ toolCalls: [], usage: USAGE, finishReason: 'stop', modelId: 'resolved:model', ...over });

function asserterFor(model: ChatModel, checks: Partial<typeof CONFIG.checks> = { maxAttempts: 1 }) {
  return createAsserter({ model, redactor: fakeRedactor(), config: configWith(checks) });
}

const USER_MESSAGE = [
  '<criterion>',
  'the confirmation says the plan was upgraded',
  '</criterion>',
  '<params>',
  '{}',
  '</params>',
  'action_preceded: true (a user action happened between BEFORE and AFTER)',
  '<volatile_nodes>',
  '(none)',
  '</volatile_nodes>',
  '<untrusted_observation id="before">',
  '- heading "Billing"',
  '- status "Current plan" text="Free plan"',
  '- button "Upgrade to Pro"',
  '</untrusted_observation>',
  '<untrusted_observation id="after">',
  '- heading "Billing"',
  '- status "Current plan" text="Pro plan"',
  '- status "Confirmation" text="Your plan was upgraded"',
  '</untrusted_observation>',
].join('\n');

describe('check generation: exact model request and evidence (R-AS1, R-SE1)', () => {
  it('R-AS1: sends the complete request: purpose, system prompt, user message, output schema, temperature and context', async () => {
    const { asserter, model } = setup([goodChange]);
    await asserter.generate(request());
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]).toStrictEqual({
      purpose: 'checkgen',
      system: checkgenSystemPrompt(8),
      messages: [{ role: 'user', content: [{ type: 'text', text: USER_MESSAGE }] }],
      output: { name: 'check_program', schema: checkgenJsonSchema() },
      temperature: 0,
      context: { criterion: 'the confirmation says the plan was upgraded', attempt: 1, scenarioId: 'billing--upgrade/upgrade-to-pro', stepKey: 'then:abc123' },
    });
  });

  it('R-AS1: the system prompt follows checks.maxPredicates', async () => {
    const { asserter, model } = setup([goodChange], { checks: { maxPredicates: 3, maxAttempts: 1 } });
    await asserter.generate(request());
    expect(model.requests[0]!.system).toBe(checkgenSystemPrompt(3));
    expect(model.requests[0]!.system).toContain('1 to 3 predicates');
  });

  it('R-AS1: forwards the caller\'s abort signal to the model call', async () => {
    const ac = new AbortController();
    const { asserter, model } = setup([goodChange]);
    await asserter.generate(request({ signal: ac.signal }));
    expect(model.requests[0]!.signal).toBe(ac.signal);
    expect(Object.keys(model.requests[0]!)).toContain('signal');
  });

  it('R-AS1: stores one checkgen evidence record per attempt with the full request and the redacted response', async () => {
    const { asserter, evidence } = setup([goodChange], { withEvidence: true });
    await asserter.generate(request());
    expect(evidence!.artifacts).toHaveLength(1);
    expect(evidence!.artifacts[0]!.kind).toBe('checkgen');
    expect(JSON.parse(evidence!.artifacts[0]!.data)).toEqual({
      attempt: 1,
      scenarioId: 'billing--upgrade/upgrade-to-pro',
      stepKey: 'then:abc123',
      promptVersion: 'checkgen-v1',
      modelId: 'fake:checkgen',
      request: {
        purpose: 'checkgen',
        system: checkgenSystemPrompt(8),
        messages: [{ role: 'user', content: [{ type: 'text', text: USER_MESSAGE }] }],
        context: { criterion: 'the confirmation says the plan was upgraded', attempt: 1, scenarioId: 'billing--upgrade/upgrade-to-pro', stepKey: 'then:abc123' },
        temperature: 0,
      },
      response: goodChange,
      outcome: 'accepted',
      errors: [],
    });
  });

  it('R-AS1: an attempt whose model call failed is stored with a null response, the model id and its errors', async () => {
    const { asserter, evidence } = setup([new Error('boom'), goodChange], { withEvidence: true });
    await asserter.generate(request());
    const first = JSON.parse(evidence!.artifacts[0]!.data) as Record<string, unknown>;
    expect(first['response']).toBeNull();
    expect(first['modelId']).toBe('fake:checkgen');
    expect(first['outcome']).toBe('rejected');
    expect(first['errors']).toEqual(['model call failed: boom']);
    expect(first['attempt']).toBe(1);
    const second = JSON.parse(evidence!.artifacts[1]!.data) as { attempt: number; request: { messages: unknown[] }; errors: unknown[]; outcome: string };
    expect(second.attempt).toBe(2);
    expect(second.outcome).toBe('accepted');
    expect(second.errors).toEqual([]);
    // the second record carries the conversation as it was sent: original message, the empty assistant turn, the feedback
    expect(second.request.messages).toHaveLength(3);
  });

  it('R-AS1: the request of an earlier attempt is not changed by the messages appended for later attempts', async () => {
    const { asserter, model } = setup([existsOnBoth, goodChange]);
    await asserter.generate(request());
    expect(model.requests[0]!.messages).toHaveLength(1);
    expect(model.requests[1]!.messages).toHaveLength(3);
  });

  it('R-AS1: usage sums input and output tokens over every attempt', async () => {
    const { asserter } = setup([existsOnBoth, goodChange]);
    const res = await asserter.generate(request());
    expect(res.usage).toEqual({ modelCalls: 2, inputTokens: 20, outputTokens: 10 });
    expect(res.attempts).toBe(2);
  });
});

describe('check generation: retry feedback (R-AS1)', () => {
  it('R-AS1: feeds the model its own response and every error as a bullet list, one per line', async () => {
    const garbage: JsonValue = { classification: 'change', predicates: [{ op: 'bogus' }, { op: 'nope' }] };
    const { asserter, model } = setup([garbage, goodChange]);
    const res = await asserter.generate(request());
    const opError = (i: number): string => `predicates[${i}]: op must be one of exists, count, text, state, route`;
    expect(model.requests[1]!.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: USER_MESSAGE }] },
      { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(garbage) }] },
      { role: 'user', content: [{ type: 'text', text: `Your previous program was rejected:\n- ${opError(0)}\n- ${opError(1)}\nReturn a corrected program.` }] },
    ]);
    expect(res.errors).toEqual([`attempt 1: ${opError(0)}`, `attempt 1: ${opError(1)}`]);
    expect(res.program).toBeDefined();
  });

  it('R-AS1: after a failed model call the assistant turn is empty and the feedback names the failure', async () => {
    const { asserter, model } = setup([new Error('boom'), goodChange]);
    await asserter.generate(request());
    expect(model.requests[1]!.messages.slice(1)).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: '' }] },
      { role: 'user', content: [{ type: 'text', text: 'Your previous program was rejected:\n- model call failed: boom\nReturn a corrected program.' }] },
    ]);
  });

  it('R-AS1: a non-Error rejection is reported by its string form', async () => {
    const model = rawModel('m:x', [(): ModelResponse => { throw 'plain string'; }]);
    const res = await asserterFor(model).generate(request());
    expect(res.errors).toEqual(['attempt 1: model call failed: plain string']);
  });

  it('R-AS1: the response text is what the model said, redacted, when the model answered in text', async () => {
    const model = rawModel('m:x', [resp({ text: 'not json, token s3cr3t' }), resp({ text: JSON.stringify(goodChange) })]);
    const asserter = createAsserter({ model, redactor: fakeRedactor({ tok: 's3cr3t' }), config: configWith({ maxAttempts: 2 }) });
    const res = await asserter.generate(request());
    expect(res.program).toBeDefined();
    expect(model.requests[1]!.messages[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'not json, token [REDACTED:tok]' }] });
    expect(res.errors).toEqual(['attempt 1: the model returned no structured output (finish reason: stop)']);
  });
});

describe('check generation: model response handling (R-AS1)', () => {
  it('R-AS1: uses the model id the response reports, and the configured model id when it reports none', async () => {
    const reported = rawModel('m:configured', [resp({ object: goodChange, modelId: 'm:reported' })]);
    const a = await asserterFor(reported).generate(request());
    expect(a.program?.generatedBy).toEqual({ modelId: 'm:reported', promptVersion: CHECKGEN_PROMPT_VERSION });

    const silent = rawModel('m:configured', [resp({ object: goodChange, modelId: '' })]);
    const b = await asserterFor(silent).generate(request());
    expect(b.program?.generatedBy).toEqual({ modelId: 'm:configured', promptVersion: CHECKGEN_PROMPT_VERSION });
  });

  it('R-SE1: the evidence record carries the model id the response reported', async () => {
    const evidence = fakeEvidence();
    const model = rawModel('m:configured', [resp({ object: goodChange, modelId: 'm:reported' })]);
    await createAsserter({ model, redactor: fakeRedactor(), config: configWith({ maxAttempts: 1 }), evidence }).generate(request());
    expect(JSON.parse(evidence.artifacts[0]!.data)).toMatchObject({ modelId: 'm:reported' });
  });

  it('R-AS1: the structured object wins over the response text, even when the text is not JSON', async () => {
    const model = rawModel('m:x', [resp({ object: goodChange, text: 'not json at all' })]);
    const res = await asserterFor(model).generate(request());
    expect(res.program?.classification).toBe('change');
    expect(res.errors).toEqual([]);
  });

  it('R-AS1: with no object the response text is parsed as JSON', async () => {
    const model = rawModel('m:x', [resp({ text: JSON.stringify(goodChange) })]);
    const res = await asserterFor(model).generate(request());
    expect(res.program?.predicates).toHaveLength(2);
  });

  it('R-AS1: a response with neither object nor parseable text is "no structured output", naming the finish reason', async () => {
    for (const r of [resp({ finishReason: 'length' }), resp({ finishReason: 'length', text: 'not json' })]) {
      const res = await asserterFor(rawModel('m:x', [r])).generate(request());
      expect(res.program).toBeUndefined();
      expect(res.errors).toEqual(['attempt 1: the model returned no structured output (finish reason: length)']);
      expect(res.fuzzyReasons).toEqual(['check-generation-failed']);
    }
  });

  it('R-AS1: a null object is "no structured output" and the text is not consulted', async () => {
    const model = rawModel('m:x', [resp({ object: null, text: JSON.stringify(goodChange), finishReason: 'error' })]);
    const res = await asserterFor(model).generate(request());
    expect(res.program).toBeUndefined();
    expect(res.errors).toEqual(['attempt 1: the model returned no structured output (finish reason: error)']);
  });

  it('R-AS1: text that parses to JSON null is "no structured output" too', async () => {
    const model = rawModel('m:x', [resp({ text: 'null', finishReason: 'other' })]);
    const res = await asserterFor(model).generate(request());
    expect(res.errors).toEqual(['attempt 1: the model returned no structured output (finish reason: other)']);
  });

  it('R-AS1: an empty-object response is a schema error, not "no structured output"', async () => {
    const res = await asserterFor(rawModel('m:x', [resp({ object: {} })])).generate(request());
    expect(res.errors).toHaveLength(2);
    expect(res.errors.join('\n')).not.toContain('no structured output');
  });
});

describe('check generation: abort handling (R-AS1)', () => {
  it('R-AS1: an already aborted signal throws ABORTED with the exact message before any model call', async () => {
    const { asserter, model } = setup([goodChange]);
    const ac = new AbortController();
    ac.abort();
    const err = await asserter.generate(request({ signal: ac.signal })).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(AiBddError);
    expect(err).toMatchObject({ code: 'ABORTED', message: 'check generation aborted' });
    expect(model.requests).toHaveLength(0);
  });

  it('R-AS1: a signal aborted during the model call stops generation with the model\'s own error, without retrying', async () => {
    const ac = new AbortController();
    const boom = new Error('socket closed');
    const { asserter, model } = setup([() => { ac.abort(); return boom; }, goodChange]);
    const err = await asserter.generate(request({ signal: ac.signal })).then(() => undefined, (e: unknown) => e);
    expect(err).toBe(boom);
    expect(model.requests).toHaveLength(1);
  });

  it('R-AS1: an ABORTED error from the model is rethrown even when the signal is not aborted', async () => {
    const aborted = new AiBddError('ABORTED', 'model call aborted');
    const { asserter, model } = setup([aborted, goodChange]);
    const err = await asserter.generate(request()).then(() => undefined, (e: unknown) => e);
    expect(err).toBe(aborted);
    expect(model.requests).toHaveLength(1);
  });

  it('R-AS1: a non-ABORTED AiBddError with a live signal is an ordinary failed attempt', async () => {
    const ac = new AbortController();
    const { asserter, model } = setup([new AiBddError('MODEL_UNAVAILABLE', 'down'), goodChange]);
    const res = await asserter.generate(request({ signal: ac.signal }));
    expect(res.program).toBeDefined();
    expect(res.attempts).toBe(2);
    expect(model.requests).toHaveLength(2);
    expect(res.errors).toEqual(['attempt 1: model call failed: down']);
  });
});

describe('check generation: rejection messages and reasons (R-AS1, R-AS2, R-CH3)', () => {
  it('R-AS1: a change program already true before is rejected with the exact CHECK_NOT_DISCRIMINATIVE message', async () => {
    const res = await asserterFor(scriptedModel([existsOnBoth])).generate(request());
    expect(res.errors).toEqual([
      'attempt 1: CHECK_NOT_DISCRIMINATIVE: the program is already true on the BEFORE observation; it must be false before the action so that it fails if the action did nothing',
    ]);
    expect(res.fuzzyReasons).toEqual(['check-not-discriminative']);
  });

  it('R-AS1: an "invariant" label after an action is rejected with the same message (it is recorded as a change)', async () => {
    const inv: JsonValue = { classification: 'invariant', predicates: (existsOnBoth as { predicates: JsonValue }).predicates };
    const res = await asserterFor(scriptedModel([inv])).generate(request());
    expect(res.errors).toEqual([
      'attempt 1: CHECK_NOT_DISCRIMINATIVE: the program is already true on the BEFORE observation; it must be false before the action so that it fails if the action did nothing',
    ]);
  });

  it('R-SE1: a literal that contains a secret is rejected with the exact message and is not a volatility or discrimination failure', async () => {
    const leak: JsonValue = { classification: 'change', predicates: [{ op: 'text', query: q({ role: 'status', name: 'Current plan' }), match: 'contains', value: { literal: 'Pro' } }] };
    const { asserter } = setup([leak], { secrets: { plan: 'Pro' }, ...one() });
    const res = await asserter.generate(request());
    expect(res.errors).toEqual(['attempt 1: predicates[0]: a literal contains a secret value (or an encoding of one); never assert on secrets']);
    expect(res.fuzzyReasons).toEqual(['check-generation-failed']);
  });

  it('R-SE1: only the predicate holding the secret is reported, by index', async () => {
    const leak: JsonValue = {
      classification: 'change',
      predicates: [
        { op: 'text', query: q({ role: 'status', name: 'Confirmation' }), match: 'contains', value: { literal: 'upgraded' } },
        { op: 'text', query: q({ role: 'status', name: 'Current plan' }), match: 'contains', value: { literal: 'Pro' } },
      ],
    };
    const { asserter } = setup([leak], { secrets: { plan: 'Pro' }, ...one() });
    const res = await asserter.generate(request());
    expect(res.errors).toEqual(['attempt 1: predicates[1]: a literal contains a secret value (or an encoding of one); never assert on secrets']);
  });

  it('R-AS2: a testId of a node that changed between observations is rejected with the exact message', async () => {
    const after = makeObs([leaf('status', 'Sync', { testId: 'sync-badge', text: 'tick one' })], '/');
    const probe = makeObs([leaf('status', 'Sync', { testId: 'sync-badge', text: 'tick two' })], '/');
    const before = makeObs([leaf('heading', 'x')], '/');
    const out: JsonValue = { classification: 'change', predicates: [{ op: 'exists', query: q({ testId: 'sync-badge' }) }] };
    const { asserter } = setup([out], one());
    const res = await asserter.generate(request({ before, after, afterProbe: probe }));
    expect(res.errors).toEqual(['attempt 1: predicates[0]: testId "sync-badge" belongs to a node whose content changed between observations']);
    expect(res.fuzzyReasons).toEqual(['volatile-content']);
  });

  it('R-AS2: a testId that no volatile node carries is not rejected', async () => {
    const after = makeObs([leaf('status', 'Sync', { testId: 'sync-badge', text: 'tick one' }), leaf('status', 'Stable', { testId: 'stable' })], '/');
    const probe = makeObs([leaf('status', 'Sync', { testId: 'sync-badge', text: 'tick two' }), leaf('status', 'Stable', { testId: 'stable' })], '/');
    const before = makeObs([leaf('heading', 'x')], '/');
    const out: JsonValue = { classification: 'change', predicates: [{ op: 'exists', query: q({ testId: 'stable' }) }] };
    const { asserter } = setup([out], one());
    const res = await asserter.generate(request({ before, after, afterProbe: probe }));
    expect(res.errors).toEqual([]);
    expect(res.program).toBeDefined();
  });

  it('R-CH3: volatile issues together with a structural issue are a generation failure, not volatile-content', async () => {
    const out: JsonValue = {
      classification: 'change',
      predicates: [
        { op: 'text', query: q({ role: 'status', name: 'Confirmation' }), match: 'contains', value: { literal: 'upgraded at 12:30' } },
        { op: 'exists', query: q({ name: 'Confirmation' }) },
      ],
    };
    const res = await asserterFor(scriptedModel([out])).generate(request());
    expect(res.fuzzyReasons).toEqual(['check-generation-failed']);
    expect(res.errors).toHaveLength(2);
  });

  it('R-CH3: a vacuous issue together with a structural issue is not-discriminative', async () => {
    const out: JsonValue = {
      classification: 'invariant',
      predicates: [{ op: 'route', match: 'prefix', value: '/' }, { op: 'exists', query: q({ name: 'Confirmation' }) }],
    };
    const res = await asserterFor(scriptedModel([out])).generate(request({ actionPreceded: false }));
    expect(res.fuzzyReasons).toEqual(['check-not-discriminative']);
    expect(res.errors).toHaveLength(2);
  });

  it('R-CH3: a vacuous issue alone is not-discriminative', async () => {
    const out: JsonValue = { classification: 'invariant', predicates: [{ op: 'count', query: q({ role: 'button' }), cmp: 'gte', value: 0 }] };
    const res = await asserterFor(scriptedModel([out])).generate(request({ actionPreceded: false }));
    expect(res.fuzzyReasons).toEqual(['check-not-discriminative']);
  });

  it('R-CH3: a structural issue alone is a generation failure', async () => {
    const out: JsonValue = { classification: 'change', predicates: [{ op: 'exists', query: q({ name: 'Confirmation' }) }] };
    const res = await asserterFor(scriptedModel([out])).generate(request());
    expect(res.fuzzyReasons).toEqual(['check-generation-failed']);
    expect(res.errors).toEqual(['attempt 1: predicates[0]: query must specify a role or a testId']);
  });

  it('R-CH3: only volatile issues give volatile-content', async () => {
    const out: JsonValue = {
      classification: 'change',
      predicates: [{ op: 'text', query: q({ role: 'status', name: 'Confirmation' }), match: 'contains', value: { literal: 'upgraded at 12:30' } }],
    };
    const res = await asserterFor(scriptedModel([out])).generate(request());
    expect(res.fuzzyReasons).toEqual(['volatile-content']);
  });
});

describe('check generation: failure descriptions (R-AS1, R-AS2)', () => {
  const blankAfter = makeObs([], '/billing');
  const dialog = q({ role: 'dialog' });

  it('R-AS1: lists the first four unsatisfied predicates with their original index, verdict and actual value', async () => {
    const out: JsonValue = {
      classification: 'change',
      predicates: [
        { op: 'route', match: 'equals', value: '/billing' },
        { op: 'exists', query: dialog, negate: true },
        { op: 'exists', query: dialog },
        { op: 'count', query: dialog, cmp: 'eq', value: 0 },
        { op: 'count', query: dialog, cmp: 'gte', value: 1 },
        { op: 'exists', query: q({ role: 'alert' }) },
      ],
    };
    const res = await asserterFor(scriptedModel([out])).generate(request({ after: blankAfter, afterProbe: blankAfter }));
    expect(res.errors).toEqual([
      'attempt 1: the program is not satisfied on the AFTER observation: ' + [
        'predicates[1] (exists) unknown, actual {"matches":0,"blank":true}',
        'predicates[2] (exists) false, actual {"matches":0}',
        'predicates[3] (count) unknown, actual {"matches":0,"blank":true}',
        'predicates[4] (count) false, actual {"matches":0}',
      ].join('; '),
    ]);
    expect(res.fuzzyReasons).toEqual(['check-generation-failed']);
  });

  it('R-AS1: a single failure is described without a separator', async () => {
    const out: JsonValue = { classification: 'change', predicates: [{ op: 'exists', query: dialog }] };
    const res = await asserterFor(scriptedModel([out])).generate(request());
    expect(res.errors).toEqual(['attempt 1: the program is not satisfied on the AFTER observation: predicates[0] (exists) false, actual {"matches":0}']);
  });

  it('R-AS2: a program that holds on AFTER but not on the later probe is volatile, even when no lint rule saw it coming', async () => {
    const before = makeObs([leaf('heading', 'Billing')], '/billing');
    const after = makeObs([leaf('heading', 'Billing'), leaf('status', 'Sync', { text: 'tick' })], '/billing');
    const probe = makeObs([leaf('heading', 'Billing')], '/billing');
    const out: JsonValue = { classification: 'change', predicates: [{ op: 'exists', query: q({ role: 'status' }) }] };
    const { asserter, model } = setup([out, out], { checks: { maxAttempts: 2 } });
    const res = await asserter.generate(request({ before, after, afterProbe: probe }));
    expect(res.program).toBeUndefined();
    expect(res.fuzzyReasons).toEqual(['volatile-content']);
    const msg = 'the program holds on AFTER but not on the later probe of the same page (content is unstable): predicates[0] (exists) false, actual {"matches":0}';
    expect(res.errors).toEqual([`attempt 1: ${msg}`, `attempt 2: ${msg}`]);
    expect(model.requests).toHaveLength(2);
  });

  it('R-AS2: an unknown verdict on the later probe is reported as unknown', async () => {
    const before = makeObs([leaf('heading', 'Billing')], '/billing');
    const after = makeObs([leaf('heading', 'Billing')], '/billing');
    const probe = makeObs([], '/billing');
    const out: JsonValue = { classification: 'change', predicates: [{ op: 'exists', query: dialog, negate: true }] };
    const res = await asserterFor(scriptedModel([out])).generate(request({ before, after, afterProbe: probe }));
    expect(res.errors).toEqual([
      'attempt 1: the program holds on AFTER but not on the later probe of the same page (content is unstable): predicates[0] (exists) unknown, actual {"matches":0,"blank":true}',
    ]);
    expect(res.fuzzyReasons).toEqual(['volatile-content']);
  });

  it('R-AS1: a program that holds on after and on the probe passes the stability check and goes on to the before check', async () => {
    const res = await asserterFor(scriptedModel([goodChange])).generate(request());
    expect(res.program?.verified).toEqual({ afterTrue: true, probeTrue: true, beforeFalse: true, judgePassed: false });
  });
});

describe('computeVolatileNodes: exact bookkeeping (R-AS2)', () => {
  it('R-AS2: a node without text or value differs from a node whose text or value is any real string', () => {
    const bare = [leaf('status', 'S')];
    expect(computeVolatileNodes(makeObs(bare), makeObs([leaf('status', 'S', { text: 'Stryker was here!' })])).keys).toEqual([{ role: 'status', name: 'S' }]);
    expect(computeVolatileNodes(makeObs(bare), makeObs([leaf('status', 'S', { value: 'Stryker was here!' })])).keys).toEqual([{ role: 'status', name: 'S' }]);
    expect(computeVolatileNodes(makeObs([leaf('status', 'S', { text: 'Stryker was here!' })]), makeObs(bare)).keys).toEqual([{ role: 'status', name: 'S' }]);
  });

  it('R-AS2: an absent text or value is the same as an empty one', () => {
    const bare = makeObs([leaf('status', 'S')]);
    expect(computeVolatileNodes(bare, makeObs([leaf('status', 'S', { text: '' })]))).toEqual({ keys: [], testIds: [] });
    expect(computeVolatileNodes(bare, makeObs([leaf('status', 'S', { value: '' })]))).toEqual({ keys: [], testIds: [] });
  });

  it('R-AS2: text and value are separate fields of the node identity', () => {
    const a = makeObs([leaf('status', 'S', { text: 'x' })]);
    const b = makeObs([leaf('status', 'S', { value: 'x' })]);
    expect(computeVolatileNodes(a, b).keys).toEqual([{ role: 'status', name: 'S' }]);
  });

  it('R-AS2: of equal copies only the surplus after-copies are volatile, so only their test ids are reported', () => {
    const copy = (testId: string): NodeSpec => leaf('listitem', 'row', { testId });
    const after = makeObs([copy('a'), copy('b'), copy('c')]);
    const probe = makeObs([leaf('listitem', 'row', { testId: 'p' })]);
    expect(computeVolatileNodes(after, probe)).toEqual({ keys: [{ role: 'listitem', name: 'row' }], testIds: ['a', 'b'] });
  });

  it('R-AS2: of equal copies only the surplus probe-copies are volatile', () => {
    const copy = (testId: string): NodeSpec => leaf('listitem', 'row', { testId });
    const after = makeObs([copy('a')]);
    const probe = makeObs([copy('p'), copy('q'), copy('r')]);
    expect(computeVolatileNodes(after, probe).testIds).toEqual(['q', 'r']);
  });

  it('R-AS2: keys are ordered by role then name (code-unit order), whatever the order of the nodes', () => {
    const specs = [
      leaf('status', 'b'), leaf('alert', 'z'), leaf('status', 'a'), leaf('button', 'B'), leaf('alert', 'a'), leaf('button', 'a'), leaf('status', 'B'), leaf('alert', 'Z'),
    ];
    const expected = [
      { role: 'alert', name: 'Z' }, { role: 'alert', name: 'a' }, { role: 'alert', name: 'z' },
      { role: 'button', name: 'B' }, { role: 'button', name: 'a' },
      { role: 'status', name: 'B' }, { role: 'status', name: 'a' }, { role: 'status', name: 'b' },
    ];
    const empty = makeObs([]);
    const orders: NodeSpec[][] = [specs, [...specs].reverse()];
    for (let r = 1; r < specs.length; r += 1) orders.push([...specs.slice(r), ...specs.slice(0, r)]);
    for (const order of orders) {
      expect(computeVolatileNodes(empty, makeObs(order)).keys).toEqual(expected);
      expect(computeVolatileNodes(makeObs(order), empty).keys).toEqual(expected);
    }
  });

  it('R-AS2: the roles of equal-role keys are ordered by name even when they arrive in descending name order', () => {
    const empty = makeObs([]);
    expect(computeVolatileNodes(empty, makeObs([leaf('x', 'c'), leaf('x', 'b'), leaf('x', 'a')])).keys.map((k) => k.name)).toEqual(['a', 'b', 'c']);
    expect(computeVolatileNodes(empty, makeObs([leaf('y', 'a'), leaf('x', 'c'), leaf('x', 'b')])).keys).toEqual([
      { role: 'x', name: 'b' }, { role: 'x', name: 'c' }, { role: 'y', name: 'a' },
    ]);
  });

  it('R-AS2: the key comparator is a consistent total order: antisymmetric, 0 only for the same key, role before name', () => {
    const after = makeObs([]);
    const probe = makeObs([leaf('status', 'a'), leaf('status', 'b')]);
    const original = Array.prototype.sort;
    const comparators: ((a: NodeKey, b: NodeKey) => number)[] = [];
    const spy = vi.spyOn(Array.prototype, 'sort').mockImplementation(function (this: unknown[], compare?: (a: never, b: never) => number) {
      if (compare) comparators.push(compare as unknown as (a: NodeKey, b: NodeKey) => number);
      return original.call(this, compare as (a: unknown, b: unknown) => number);
    });
    try {
      computeVolatileNodes(after, probe);
    } finally {
      spy.mockRestore();
    }
    expect(comparators).toHaveLength(1);
    const cmp = comparators[0]!;
    const keys: NodeKey[] = [
      { role: 'alert', name: 'z' }, { role: 'status', name: 'a' }, { role: 'status', name: 'b' }, { role: 'status', name: 'B' }, { role: 'button', name: '' },
    ];
    for (const x of keys) {
      expect(cmp(x, { ...x })).toBe(0);
      for (const y of keys) {
        if (x === y) continue;
        expect(cmp(x, y)).toBe(-cmp(y, x));
        expect(Math.abs(cmp(x, y))).toBe(1);
      }
    }
    // a smaller role wins whatever the names are; equal roles fall back to the name
    expect(cmp({ role: 'alert', name: 'z' }, { role: 'status', name: 'a' })).toBe(-1);
    expect(cmp({ role: 'status', name: 'a' }, { role: 'alert', name: 'z' })).toBe(1);
    expect(cmp({ role: 'status', name: 'a' }, { role: 'status', name: 'b' })).toBe(-1);
    expect(cmp({ role: 'status', name: 'b' }, { role: 'status', name: 'a' })).toBe(1);
    expect(cmp({ role: 'status', name: 'B' }, { role: 'status', name: 'a' })).toBe(-1);
  });

  it('R-AS2: test ids are reported sorted and without duplicates', () => {
    const probe = makeObs([
      leaf('status', 'one', { testId: 't3' }), leaf('status', 'two', { testId: 't1' }), leaf('status', 'three', { testId: 't2' }), leaf('status', 'four', { testId: 't1' }),
      leaf('status', 'five'),
    ]);
    expect(computeVolatileNodes(makeObs([]), probe).testIds).toEqual(['t1', 't2', 't3']);
  });

  it('R-AS2: a node that is volatile twice under the same role and name gives one key', () => {
    const probe = makeObs([leaf('status', 'tick', { text: '1' }), leaf('status', 'tick', { text: '2' })]);
    expect(computeVolatileNodes(makeObs([]), probe).keys).toEqual([{ role: 'status', name: 'tick' }]);
  });
});
