/**
 * Model contract kit, shared by every `ModelSet` implementation (the AI SDK adapter, the rule-based fake
 * models, any future provider package). It is vitest-compatible like the driver conformance kit: call
 * `runModelContract(name, makeModelSet, options)` at module level of a test file and it declares one `describe`.
 *
 * The kit talks to a model set through the public contract only (`ModelSet` -> `ChatModel.generate`). Because a
 * real adapter needs a provider behind it, the factory receives a {@link ModelScript} describing what the
 * "provider" should do for the next request (answer with text, with a structured object, with a tool call, hang
 * until aborted, or fail in one of the {@link FailureKind} ways) and returns a `ModelSet` that behaves so. The
 * kit puts `{ contractCase: <caseId> }` into every request `context`, so a rule-driven fake can key its rules on
 * it (adapters never read `context`, see the contract).
 *
 * What is specified (each item is one or more `it` blocks, see {@link modelContractCases}):
 *
 *   - every purpose has a non-empty `id` that never changes;
 *   - a response is plain JSON data: integer, non-negative token counts, a `finishReason` of the declared union,
 *     `modelId` equal to the answering model's `id`, `toolCalls` always an array of `{id, name, args}`;
 *   - `output` yields `object` equal to what the provider produced; `tools` + `toolChoice: 'required'` yields the
 *     provider's tool calls, whose names are among the offered tools;
 *   - the request is never mutated (it is deep-frozen for the call);
 *   - an aborted `signal` rejects with `AiBddError` `ABORTED`, before or during the call, and a live signal does
 *     not disturb a normal call;
 *   - failures surface as `AiBddError` with a declared code, `retryable` only on codes of `RETRYABLE_CODES`, and
 *     the codes of {@link FAILURE_EXPECTATIONS};
 *   - where the implementation claims determinism, the same request twice gives the same response.
 *
 * No test depends on wall-clock time: "promptly" is counted in event-loop turns, not milliseconds.
 */
import { describe, expect, it } from 'vitest';
import {
  AiBddError,
  ERROR_CODES,
  RETRYABLE_CODES,
  type ChatModel,
  type ErrorCode,
  type JsonObject,
  type ModelPurpose,
  type ModelRequest,
  type ModelResponse,
  type ModelSet,
  type ToolSpec,
} from '../../src/contracts/index.ts';

// ───────────────────────── what the factory is asked to script

/** The ways a provider can fail that every real adapter has to classify. */
export type FailureKind =
  /** The provider answered 429 / overloaded: retrying later may help. */
  | 'rate-limit'
  /** Credentials, unknown model, bad request: retrying cannot help. */
  | 'permanent'
  /** The provider (not the caller) timed out: the caller's signal is NOT aborted. */
  | 'timeout'
  /** The provider answered with text that is not the JSON the request's `output` schema asked for. */
  | 'malformed-json'
  /** The provider refused (content filter) and produced no content. */
  | 'refusal'
  /** The implementation has no answer for this request at all (rule-driven fakes). */
  | 'unscripted';

export type ModelScript =
  | { kind: 'text'; text: string }
  | { kind: 'structured'; object: JsonObject }
  | { kind: 'tool-call'; toolName: string; args: JsonObject }
  /** The provider never answers on its own; it only ends when the caller aborts. */
  | { kind: 'hang' }
  | { kind: 'failure'; failure: FailureKind };

/** `caseId` is also sent as `context.contractCase` in every request the kit makes for that script. */
export type MakeModelSet = (script: ModelScript, caseId: string) => ModelSet | Promise<ModelSet>;

export interface ModelContractOptions {
  /** The failure kinds the factory can script. Default: none (the failure tests are not declared). */
  failures?: readonly FailureKind[];
  /** The implementation claims identical responses for identical requests. Default false. */
  deterministic?: boolean;
  /** `hang` can be scripted, so abort-during-the-call is testable. Default true. */
  abortInFlight?: boolean;
  /** The implementation rejects tool calls for tools the request did not offer. Default true. */
  validatesToolNames?: boolean;
  /** The exact usage the provider reports for a `text` script, when the factory controls it. */
  textUsage?: { inputTokens: number; outputTokens: number };
}

/** What each failure must look like at the contract level (code and the `retryable` flag). */
export const FAILURE_EXPECTATIONS: Readonly<Record<FailureKind, { code: ErrorCode; retryable: boolean }>> = {
  'rate-limit': { code: 'MODEL_UNAVAILABLE', retryable: true },
  permanent: { code: 'MODEL_UNAVAILABLE', retryable: false },
  timeout: { code: 'MODEL_UNAVAILABLE', retryable: true },
  'malformed-json': { code: 'MODEL_OUTPUT_INVALID', retryable: false },
  refusal: { code: 'MODEL_OUTPUT_INVALID', retryable: false },
  unscripted: { code: 'MODEL_NO_RULE', retryable: false },
};

export const PURPOSES: readonly ModelPurpose[] = ['extract', 'act', 'checkgen', 'judge'];
const FINISH_REASONS: readonly ModelResponse['finishReason'][] = ['stop', 'tool-calls', 'length', 'error', 'other'];

export const CONTRACT_TOOLS: ToolSpec[] = [
  {
    name: 'click',
    description: 'Click an element',
    inputSchema: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] },
  },
  { name: 'complete_step', description: 'Finish the step', inputSchema: { type: 'object', properties: {} } },
];

export const CONTRACT_OUTPUT = {
  name: 'verdict',
  schema: {
    type: 'object',
    properties: { verdict: { type: 'string' }, n: { type: 'integer' } },
    required: ['verdict'],
    additionalProperties: false,
  } as JsonObject,
};

export const STRUCTURED_OBJECT: JsonObject = { verdict: 'holds', n: 3 };
export const TEXT_ANSWER = 'The contract answer.';
const TOOL_ARGS: JsonObject = { ref: 'e7' };

// ───────────────────────── helpers

export function contractRequest(purpose: ModelPurpose, caseId: string, extra: Partial<ModelRequest> = {}): ModelRequest {
  return {
    purpose,
    system: 'You are a contract test.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    context: { contractCase: caseId },
    ...extra,
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !ArrayBuffer.isView(value) && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  }
  return value;
}

type Settled<T> = { state: 'resolved'; value: T } | { state: 'rejected'; error: unknown } | { state: 'pending' };

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Waits at most `maxTurns` event-loop turns for `promise`; never uses timers, so it is independent of machine speed. */
async function settle<T>(promise: Promise<T>, maxTurns = 400): Promise<Settled<T>> {
  let result: Settled<T> = { state: 'pending' };
  promise.then(
    (value) => {
      result = { state: 'resolved', value };
    },
    (error: unknown) => {
      result = { state: 'rejected', error };
    },
  );
  for (let i = 0; i < maxTurns && result.state === 'pending'; i += 1) await turn();
  return result;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  const s = await settle(promise);
  if (s.state === 'pending') throw new Error('generate() was still pending after 400 event-loop turns');
  if (s.state === 'resolved') throw new Error(`generate() resolved but was expected to reject: ${JSON.stringify(s.value)}`);
  return s.error;
}

async function resolution<T>(promise: Promise<T>): Promise<T> {
  const s = await settle(promise);
  if (s.state === 'pending') throw new Error('generate() was still pending after 400 event-loop turns');
  if (s.state === 'rejected') throw s.error;
  return s.value;
}

/** The invariants every error from a model must satisfy, whatever the cause. */
export function expectModelError(error: unknown): AiBddError {
  expect(error, `expected an AiBddError, got ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`).toBeInstanceOf(AiBddError);
  const err = error as AiBddError;
  expect(ERROR_CODES as readonly string[]).toContain(err.code);
  expect(typeof err.message).toBe('string');
  expect(err.message.length).toBeGreaterThan(0);
  expect(typeof err.retryable).toBe('boolean');
  if (err.retryable) expect(RETRYABLE_CODES.has(err.code), `retryable=true on non-retryable code ${err.code}`).toBe(true);
  return err;
}

/** The invariants every successful response must satisfy. */
export function expectResponseShape(res: ModelResponse, model: ChatModel, offeredTools: readonly string[] | undefined): void {
  expect(Object.keys(res).sort().every((k) => ['text', 'object', 'toolCalls', 'usage', 'finishReason', 'modelId'].includes(k)), `unexpected keys ${Object.keys(res).join(',')}`).toBe(true);
  expect(Number.isInteger(res.usage.inputTokens) && res.usage.inputTokens >= 0, `inputTokens ${String(res.usage.inputTokens)}`).toBe(true);
  expect(Number.isInteger(res.usage.outputTokens) && res.usage.outputTokens >= 0, `outputTokens ${String(res.usage.outputTokens)}`).toBe(true);
  expect(FINISH_REASONS).toContain(res.finishReason);
  expect(typeof res.modelId).toBe('string');
  expect(res.modelId.length).toBeGreaterThan(0);
  expect(res.modelId).toBe(model.id);
  expect(Array.isArray(res.toolCalls)).toBe(true);
  const ids = new Set<string>();
  for (const call of res.toolCalls) {
    expect(typeof call.id === 'string' && call.id.length > 0, 'tool call id').toBe(true);
    expect(ids.has(call.id), `duplicate tool call id ${call.id}`).toBe(false);
    ids.add(call.id);
    expect(typeof call.name === 'string' && call.name.length > 0, 'tool call name').toBe(true);
    expect(call.args !== null && typeof call.args === 'object' && !Array.isArray(call.args), 'tool call args is an object').toBe(true);
    if (offeredTools !== undefined) expect(offeredTools, `tool call to a tool that was not offered: ${call.name}`).toContain(call.name);
  }
  if (res.text !== undefined) expect(typeof res.text).toBe('string');
  // Plain JSON data: nothing that dies in a round trip through the evidence store or the wire.
  expect(JSON.parse(JSON.stringify(res)) as unknown).toEqual(res);
}

// ───────────────────────── the cases

export interface ModelContractCase {
  name: string;
  run(): Promise<void>;
}

export function modelContractCases(make: MakeModelSet, options: ModelContractOptions = {}): ModelContractCase[] {
  const failures = options.failures ?? [];
  const cases: ModelContractCase[] = [];
  const add = (name: string, run: () => Promise<void>): void => {
    cases.push({ name, run });
  };
  const build = async (script: ModelScript, caseId: string): Promise<ModelSet> => await make(script, caseId);

  // ── identity
  add('every purpose has a non-empty id that never changes', async () => {
    const set = await build({ kind: 'text', text: TEXT_ANSWER }, 'ids');
    for (const purpose of PURPOSES) {
      const model = set[purpose];
      const before = model.id;
      expect(typeof before, purpose).toBe('string');
      expect(before.length, purpose).toBeGreaterThan(0);
      expect(before.trim(), `${purpose} id must not be blank`).not.toBe('');
      await resolution(model.generate(contractRequest(purpose, 'ids')));
      expect(model.id, `${purpose} id changed after a call`).toBe(before);
      expect(set[purpose].id, `${purpose} id differs between reads`).toBe(before);
    }
  });

  // ── plain answers
  for (const purpose of PURPOSES) {
    add(`${purpose}: a text answer is a well-formed response carrying the text`, async () => {
      const set = await build({ kind: 'text', text: TEXT_ANSWER }, 'text');
      const res = await resolution(set[purpose].generate(contractRequest(purpose, 'text')));
      expectResponseShape(res, set[purpose], undefined);
      expect(res.text).toBe(TEXT_ANSWER);
      expect(res.toolCalls).toEqual([]);
      expect(res.object).toBeUndefined();
      expect(res.finishReason).toBe('stop');
      if (options.textUsage !== undefined) expect(res.usage).toEqual(options.textUsage);
    });
  }

  add('a request may carry every message role, images, an empty system prompt and sampling settings', async () => {
    const set = await build({ kind: 'text', text: TEXT_ANSWER }, 'history');
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const req = contractRequest('act', 'history', {
      system: '',
      temperature: 0,
      seed: 7,
      maxOutputTokens: 256,
      tools: CONTRACT_TOOLS,
      toolChoice: 'auto',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }, { type: 'image', png, sha256: 'a'.repeat(64) }] },
        { role: 'assistant', content: [{ type: 'text', text: 'clicking' }], toolCalls: [{ id: 'c1', name: 'click', args: { ref: 'e1' } }] },
        { role: 'tool', toolCallId: 'c1', toolName: 'click', result: { ok: true, nested: [1, null, 'x'] } },
        { role: 'user', content: [{ type: 'text', text: 'and now?' }] },
      ],
    });
    const res = await resolution(set.act.generate(req));
    expectResponseShape(res, set.act, CONTRACT_TOOLS.map((t) => t.name));
    expect(res.text).toBe(TEXT_ANSWER);
    expect([...png]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  // ── structured output
  for (const purpose of PURPOSES) {
    add(`${purpose}: a request with \`output\` yields the structured object`, async () => {
      const set = await build({ kind: 'structured', object: STRUCTURED_OBJECT }, 'structured');
      const res = await resolution(set[purpose].generate(contractRequest(purpose, 'structured', { output: CONTRACT_OUTPUT })));
      expectResponseShape(res, set[purpose], undefined);
      expect(res.object).toEqual(STRUCTURED_OBJECT);
      expect(res.toolCalls).toEqual([]);
      expect(res.finishReason).toBe('stop');
    });
  }

  // ── tool calls
  for (const purpose of PURPOSES) {
    add(`${purpose}: tools with toolChoice 'required' yield the provider's tool calls as {id, name, args}`, async () => {
      const set = await build({ kind: 'tool-call', toolName: 'click', args: TOOL_ARGS }, 'tools');
      const res = await resolution(set[purpose].generate(contractRequest(purpose, 'tools', { tools: CONTRACT_TOOLS, toolChoice: 'required' })));
      expectResponseShape(res, set[purpose], CONTRACT_TOOLS.map((t) => t.name));
      expect(res.toolCalls).toHaveLength(1);
      expect(res.toolCalls[0]?.name).toBe('click');
      expect(res.toolCalls[0]?.args).toEqual(TOOL_ARGS);
      expect(res.finishReason).toBe('tool-calls');
      expect(res.object).toBeUndefined();
    });
  }

  if (options.validatesToolNames !== false) {
    add('a tool call for a tool that was not offered is never returned', async () => {
      const set = await build({ kind: 'tool-call', toolName: 'teleport', args: {} }, 'unoffered-tool');
      const err = expectModelError(await rejection(set.act.generate(contractRequest('act', 'unoffered-tool', { tools: CONTRACT_TOOLS, toolChoice: 'required' }))));
      expect(err.code).toBe('MODEL_OUTPUT_INVALID');
      expect(err.retryable).toBe(false);
    });
  }

  // ── the request is the caller's
  const mutationScripts: Array<[string, ModelScript, Partial<ModelRequest>]> = [
    ['text', { kind: 'text', text: TEXT_ANSWER }, {}],
    ['structured', { kind: 'structured', object: STRUCTURED_OBJECT }, { output: CONTRACT_OUTPUT }],
    ['tools', { kind: 'tool-call', toolName: 'click', args: TOOL_ARGS }, { tools: CONTRACT_TOOLS, toolChoice: 'required' }],
  ];
  for (const [label, script, extra] of mutationScripts) {
    add(`a deep-frozen ${label} request is accepted and left exactly as it was`, async () => {
      const set = await build(script, label);
      const png = new Uint8Array([1, 2, 3, 4]);
      const make1 = (): ModelRequest =>
        contractRequest('act', label, {
          ...extra,
          temperature: 0,
          seed: 1,
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'one' }, { type: 'image', png: new Uint8Array(png), sha256: 'b'.repeat(64) }] },
            { role: 'assistant', content: [{ type: 'text', text: 'two' }], toolCalls: [{ id: 'c1', name: 'click', args: { ref: 'e1', deep: { list: [1, 2, 3] } } }] },
            { role: 'tool', toolCallId: 'c1', toolName: 'click', result: { ok: true, list: [{ a: 1 }] } },
          ],
          context: { contractCase: label, nested: { list: [1, { two: 2 }] } },
        });
      const frozen = deepFreeze(make1());
      const before = structuredClone(make1());
      for (const purpose of PURPOSES) {
        const outcome = await settle(set[purpose].generate({ ...frozen, purpose }));
        expect(outcome.state).toBe('resolved');
        if (outcome.state === 'rejected') throw outcome.error;
      }
      expect(frozen).toEqual({ ...before, purpose: frozen.purpose });
    });
  }

  // ── abort
  add('an already aborted signal rejects with ABORTED and does not return a response', async () => {
    const set = await build({ kind: 'text', text: TEXT_ANSWER }, 'pre-aborted');
    for (const purpose of PURPOSES) {
      const ac = new AbortController();
      ac.abort();
      const err = expectModelError(await rejection(set[purpose].generate(contractRequest(purpose, 'pre-aborted', { signal: ac.signal }))));
      expect(err.code, purpose).toBe('ABORTED');
      expect(err.retryable, purpose).toBe(false);
    }
  });

  add('an abort reason that is not an AbortError still yields ABORTED', async () => {
    const set = await build({ kind: 'text', text: TEXT_ANSWER }, 'abort-reason');
    const ac = new AbortController();
    ac.abort(new Error('user pressed ctrl-c'));
    const err = expectModelError(await rejection(set.judge.generate(contractRequest('judge', 'abort-reason', { signal: ac.signal }))));
    expect(err.code).toBe('ABORTED');
  });

  add('a live signal that is never aborted does not disturb the call', async () => {
    const set = await build({ kind: 'text', text: TEXT_ANSWER }, 'live-signal');
    const ac = new AbortController();
    const res = await resolution(set.act.generate(contractRequest('act', 'live-signal', { signal: ac.signal })));
    expect(res.text).toBe(TEXT_ANSWER);
    expect(ac.signal.aborted).toBe(false);
  });

  if (options.abortInFlight !== false) {
    add('aborting while the provider is still working rejects with ABORTED', async () => {
      const set = await build({ kind: 'hang' }, 'hang');
      for (const purpose of PURPOSES) {
        const ac = new AbortController();
        const pending = settle(set[purpose].generate(contractRequest(purpose, 'hang', { signal: ac.signal })), 600);
        // let the call get as far as the provider before pulling the plug
        for (let i = 0; i < 20; i += 1) await turn();
        ac.abort();
        const outcome = await pending;
        expect(outcome.state, `${purpose}: generate() must end after abort`).toBe('rejected');
        if (outcome.state === 'rejected') {
          const err = expectModelError(outcome.error);
          expect(err.code, purpose).toBe('ABORTED');
          expect(err.retryable, purpose).toBe(false);
        }
      }
    });

    add('a call that has not been aborted keeps waiting for the provider', async () => {
      const set = await build({ kind: 'hang' }, 'hang-wait');
      const ac = new AbortController();
      const pending = set.act.generate(contractRequest('act', 'hang-wait', { signal: ac.signal }));
      const s = await settle(pending, 60);
      expect(s.state, 'generate() must not give up on its own').toBe('pending');
      ac.abort();
      expectModelError(await rejection(pending));
    });
  }

  // ── failures
  for (const failure of failures) {
    const expected = FAILURE_EXPECTATIONS[failure];
    const withOutput = failure === 'malformed-json' || failure === 'refusal';
    for (const purpose of PURPOSES) {
      add(`${purpose}: failure '${failure}' surfaces as AiBddError ${expected.code} (retryable ${String(expected.retryable)})`, async () => {
        const set = await build({ kind: 'failure', failure }, failure);
        const req = contractRequest(purpose, failure, withOutput ? { output: CONTRACT_OUTPUT } : {});
        const err = expectModelError(await rejection(set[purpose].generate(req)));
        expect(err.code).toBe(expected.code);
        expect(err.retryable).toBe(expected.retryable);
      });
    }
    add(`failure '${failure}' does not mutate a frozen request`, async () => {
      const set = await build({ kind: 'failure', failure }, failure);
      const frozen = deepFreeze(contractRequest('act', failure, withOutput ? { output: CONTRACT_OUTPUT } : {}));
      const before = structuredClone(frozen);
      expectModelError(await rejection(set.act.generate(frozen)));
      expect(frozen).toEqual(before);
    });
  }

  if (failures.includes('refusal')) {
    add("a refusal without a structured request is never reported as a successful 'stop' with content", async () => {
      const set = await build({ kind: 'failure', failure: 'refusal' }, 'refusal');
      const outcome = await settle(set.act.generate(contractRequest('act', 'refusal')));
      expect(outcome.state).not.toBe('pending');
      if (outcome.state === 'rejected') {
        expect(expectModelError(outcome.error).code).toBe('MODEL_OUTPUT_INVALID');
      } else if (outcome.state === 'resolved') {
        expect(outcome.value.finishReason).not.toBe('stop');
        expect(outcome.value.object).toBeUndefined();
        expect(outcome.value.toolCalls).toEqual([]);
      }
    });
  }

  if (failures.includes('timeout')) {
    add('a provider timeout is not reported as ABORTED when the caller did not abort', async () => {
      const set = await build({ kind: 'failure', failure: 'timeout' }, 'timeout');
      const ac = new AbortController();
      const err = expectModelError(await rejection(set.act.generate(contractRequest('act', 'timeout', { signal: ac.signal }))));
      expect(ac.signal.aborted).toBe(false);
      expect(err.code).not.toBe('ABORTED');
      expect(err.code).toBe('MODEL_UNAVAILABLE');
    });
  }

  // ── concurrency and determinism
  add('concurrent calls on all purposes get their own answers (no shared mutable state)', async () => {
    const set = await build({ kind: 'structured', object: STRUCTURED_OBJECT }, 'concurrent');
    const req = (p: ModelPurpose): ModelRequest => contractRequest(p, 'concurrent', { output: CONTRACT_OUTPUT });
    const sequential = new Map<ModelPurpose, ModelResponse>();
    for (const p of PURPOSES) sequential.set(p, await resolution(set[p].generate(req(p))));
    const parallel = await Promise.all([...PURPOSES, ...PURPOSES].map(async (p) => ({ p, res: await resolution(set[p].generate(req(p))) })));
    expect(parallel).toHaveLength(8);
    for (const { p, res } of parallel) {
      expect(res.modelId, p).toBe(set[p].id);
      expect(res.object, p).toEqual(STRUCTURED_OBJECT);
      expect(res, p).toEqual(sequential.get(p));
    }
  });

  if (options.deterministic === true) {
    for (const purpose of PURPOSES) {
      add(`${purpose}: the same request twice gives byte-identical responses, tool call ids included`, async () => {
        const set = await build({ kind: 'tool-call', toolName: 'click', args: TOOL_ARGS }, 'determinism');
        const req = (): ModelRequest => contractRequest(purpose, 'determinism', { tools: CONTRACT_TOOLS, toolChoice: 'required', seed: 42, temperature: 0 });
        const a = await resolution(set[purpose].generate(req()));
        const b = await resolution(set[purpose].generate(req()));
        const otherPurpose = purpose === 'act' ? 'judge' : 'act';
        await resolution(set[otherPurpose].generate(contractRequest(otherPurpose, 'determinism', { tools: CONTRACT_TOOLS, toolChoice: 'required' })));
        const c = await resolution(set[purpose].generate(req()));
        expect(JSON.stringify(b)).toBe(JSON.stringify(a));
        expect(JSON.stringify(c), 'an unrelated call in between changed the answer').toBe(JSON.stringify(a));
      });
    }
    add('two independently built model sets answer the same request identically', async () => {
      const one = await build({ kind: 'tool-call', toolName: 'click', args: TOOL_ARGS }, 'determinism-sets');
      const two = await build({ kind: 'tool-call', toolName: 'click', args: TOOL_ARGS }, 'determinism-sets');
      const req = (): ModelRequest => contractRequest('act', 'determinism-sets', { tools: CONTRACT_TOOLS, toolChoice: 'required', seed: 9 });
      const a = await resolution(one.act.generate(req()));
      const b = await resolution(two.act.generate(req()));
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
      expect(one.act.id).toBe(two.act.id);
    });
  }

  return cases;
}

/** Declares one `describe` with one `it` per contract case. */
export function runModelContract(name: string, make: MakeModelSet, options: ModelContractOptions = {}): void {
  describe(`ModelSet contract: ${name}`, () => {
    for (const c of modelContractCases(make, options)) it(c.name, c.run);
  });
}
