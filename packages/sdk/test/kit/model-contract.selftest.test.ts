import { describe, expect, it } from 'vitest';
import {
  AiBddError,
  type ChatModel,
  type ModelPurpose,
  type ModelRequest,
  type ModelResponse,
  type ModelSet,
} from '../../src/contracts/index.ts';
import {
  FAILURE_EXPECTATIONS,
  PURPOSES,
  modelContractCases,
  runModelContract,
  type FailureKind,
  type MakeModelSet,
  type ModelContractOptions,
  type ModelScript,
} from './model-contract.ts';

/**
 * A correct in-memory `ModelSet`, plus named mutations of it. The kit is only worth something if it fails for the
 * mutants: each mutation below flips exactly one property of the contract, and the test names the kit cases that
 * must catch it.
 */
type Mutation =
  | 'none'
  | 'mutates-request'
  | 'fractional-usage'
  | 'negative-usage'
  | 'wrong-model-id'
  | 'empty-id'
  | 'unstable-id'
  | 'ignores-pre-abort'
  | 'abort-wrong-code'
  | 'never-aborts'
  | 'raw-type-error'
  | 'retryable-on-wrong-code'
  | 'wrong-failure-code'
  | 'unoffered-tool'
  | 'tool-calls-undefined'
  | 'drops-object'
  | 'drops-tool-args'
  | 'duplicate-tool-ids'
  | 'nondeterministic'
  | 'shared-state'
  | 'refusal-as-stop'
  | 'timeout-as-abort'
  | 'not-json';

function reference(script: ModelScript, mutation: Mutation): ModelSet {
  let calls = 0;
  let last: ModelResponse | undefined;
  const make = (purpose: ModelPurpose): ChatModel => {
    const model: ChatModel = {
      get id(): string {
        if (mutation === 'empty-id') return '';
        if (mutation === 'unstable-id') return `ref:${purpose}:${calls}`;
        return `ref:${purpose}`;
      },
      async generate(req: ModelRequest): Promise<ModelResponse> {
        calls += 1;
        if (mutation === 'mutates-request') req.messages.push({ role: 'user', content: [{ type: 'text', text: 'injected' }] });
        if (req.signal?.aborted === true && mutation !== 'ignores-pre-abort') {
          throw new AiBddError(mutation === 'abort-wrong-code' ? 'MODEL_UNAVAILABLE' : 'ABORTED', 'aborted');
        }
        const base = (): ModelResponse => ({
          toolCalls: [],
          usage: { inputTokens: req.system.length, outputTokens: 1 },
          finishReason: 'stop',
          modelId: mutation === 'wrong-model-id' ? 'other' : model.id,
        });
        let res: ModelResponse;
        switch (script.kind) {
          case 'text':
            res = { ...base(), text: script.text };
            break;
          case 'structured':
            res = req.output === undefined ? { ...base(), text: JSON.stringify(script.object) } : (mutation === 'drops-object' ? base() : { ...base(), object: script.object });
            if (mutation === 'not-json') res = { ...base(), object: { bad: undefined, fn: () => 1 } as never };
            break;
          case 'tool-call': {
            if (!(req.tools ?? []).some((t) => t.name === script.toolName) && mutation !== 'unoffered-tool') {
              throw new AiBddError('MODEL_OUTPUT_INVALID', `unknown tool ${script.toolName}`);
            }
            const id = mutation === 'nondeterministic' ? `call-${calls}` : 'call-1';
            res = {
              ...base(),
              toolCalls: [{ id, name: script.toolName, args: mutation === 'drops-tool-args' ? {} : script.args }],
              finishReason: 'tool-calls',
            };
            if (mutation === 'duplicate-tool-ids') res.toolCalls.push({ id, name: script.toolName, args: script.args });
            if (mutation === 'tool-calls-undefined') delete (res as { toolCalls?: unknown }).toolCalls;
            break;
          }
          case 'hang':
            if (mutation === 'never-aborts') return await new Promise<ModelResponse>(() => undefined);
            return await new Promise<ModelResponse>((_resolve, reject) => {
              req.signal?.addEventListener('abort', () => reject(new AiBddError('ABORTED', 'aborted')), { once: true });
            });
          case 'failure': {
            const failure = script.failure as FailureKind;
            if (mutation === 'raw-type-error') throw new TypeError('fetch failed');
            if (failure === 'refusal' && mutation === 'refusal-as-stop' && req.output === undefined) return { ...base(), text: 'I cannot help with that' };
            if (failure === 'timeout' && mutation === 'timeout-as-abort') throw new AiBddError('ABORTED', 'timed out');
            const expected = FAILURE_EXPECTATIONS[failure];
            if (mutation === 'retryable-on-wrong-code' && !expected.retryable) throw new AiBddError(expected.code, 'failed', { retryable: true });
            if (mutation === 'wrong-failure-code') throw new AiBddError('INTERNAL', 'failed');
            throw new AiBddError(expected.code, 'failed', { retryable: expected.retryable });
          }
        }
        if (mutation === 'fractional-usage') res.usage = { inputTokens: 1.5, outputTokens: 1 };
        if (mutation === 'negative-usage') res.usage = { inputTokens: 1, outputTokens: -1 };
        if (mutation === 'shared-state') {
          const previous = last;
          last = res;
          if (previous !== undefined) res = { ...res, modelId: previous.modelId };
        }
        return res;
      },
    };
    return model;
  };
  return Object.fromEntries(PURPOSES.map((p) => [p, make(p)])) as unknown as ModelSet;
}

const OPTIONS: ModelContractOptions = {
  failures: ['rate-limit', 'permanent', 'timeout', 'malformed-json', 'refusal', 'unscripted'],
  deterministic: true,
};

const makeFor = (mutation: Mutation): MakeModelSet => (script) => reference(script, mutation);

async function failingCases(mutation: Mutation): Promise<string[]> {
  const failed: string[] = [];
  for (const c of modelContractCases(makeFor(mutation), OPTIONS)) {
    try {
      await c.run();
    } catch {
      failed.push(c.name);
    }
  }
  return failed;
}

// The unmutated reference passes the whole kit.
runModelContract('reference model set (kit self-test)', makeFor('none'), OPTIONS);

describe('fault injection against the reference model set (what each contract case guards)', () => {
  const expectCaught: Array<[Mutation, RegExp]> = [
    ['mutates-request', /deep-frozen/],
    ['fractional-usage', /text answer is a well-formed response/],
    ['negative-usage', /text answer is a well-formed response/],
    ['wrong-model-id', /text answer is a well-formed response/],
    ['empty-id', /non-empty id/],
    ['unstable-id', /never changes/],
    ['ignores-pre-abort', /already aborted signal/],
    ['abort-wrong-code', /already aborted signal/],
    ['never-aborts', /aborting while the provider is still working/],
    ['raw-type-error', /failure 'rate-limit' surfaces as AiBddError/],
    ['retryable-on-wrong-code', /failure 'permanent' surfaces as AiBddError/],
    ['wrong-failure-code', /failure 'malformed-json' surfaces as AiBddError/],
    ['unoffered-tool', /tool that was not offered/],
    ['tool-calls-undefined', /tools with toolChoice 'required'/],
    ['drops-object', /request with `output` yields the structured object/],
    ['drops-tool-args', /tools with toolChoice 'required'/],
    ['duplicate-tool-ids', /tools with toolChoice 'required'/],
    ['nondeterministic', /same request twice|independently built/],
    ['shared-state', /concurrent calls/],
    ['refusal-as-stop', /refusal without a structured request/],
    ['timeout-as-abort', /provider timeout is not reported as ABORTED/],
    ['not-json', /request with `output` yields the structured object/],
  ];

  it('the reference passes every case', async () => {
    expect(await failingCases('none')).toEqual([]);
  });

  it.each(expectCaught)('%s is caught', async (mutation, expected) => {
    const failed = await failingCases(mutation);
    expect(failed.length, `${mutation} slipped through the kit`).toBeGreaterThan(0);
    expect(failed.some((name) => expected.test(name)), `${mutation} failed ${JSON.stringify(failed.slice(0, 4))} but not ${String(expected)}`).toBe(true);
  });

  it('an option turns a case off without turning the others off', () => {
    const names = (o: ModelContractOptions): string[] => modelContractCases(makeFor('none'), o).map((c) => c.name);
    const all = names(OPTIONS);
    expect(all.filter((n) => !names({ ...OPTIONS, abortInFlight: false }).includes(n))).toEqual([
      'aborting while the provider is still working rejects with ABORTED',
      'a call that has not been aborted keeps waiting for the provider',
    ]);
    expect(all.filter((n) => !names({ ...OPTIONS, validatesToolNames: false }).includes(n))).toEqual(['a tool call for a tool that was not offered is never returned']);
    expect(names({ ...OPTIONS, failures: [] }).some((n) => n.includes("failure '"))).toBe(false);
    expect(names({ ...OPTIONS, deterministic: false }).some((n) => n.includes('byte-identical'))).toBe(false);
  });
});
