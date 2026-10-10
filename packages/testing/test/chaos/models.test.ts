import { describe, expect, it } from 'vitest';
import { AiBddError, type JsonObject, type ModelPurpose, type ModelSet } from '@ai-bdd/sdk/contracts';
import { chaosModels, createFakeModels, type ChaosModelSet, type ModelRule } from '@ai-bdd/testing';
import { NODES, req } from '../fake-model/helpers.ts';

const OBJECT = { verdict: 'holds', probability: 0.9, explanation: 'looks right', observed: 'the page', nested: { items: ['a', 'b'] } };

function inner(): ModelSet {
  return createFakeModels({
    rules: [
      {
        rules: [
          { id: 'extract', purpose: 'extract', respond: { object: OBJECT } },
          { id: 'judge', purpose: 'judge', respond: { object: OBJECT } },
          { id: 'checkgen', purpose: 'checkgen', respond: { text: '{"predicates":[]}' } },
          { id: 'act', purpose: 'act', respond: { script: [{ tool: 'click', args: { target: { role: 'button', name: 'Upgrade to Pro' } } }] } },
        ],
      },
    ],
  });
}

const make = (rules: ModelRule[], seed: number | string = 'm', options?: Parameters<typeof chaosModels>[2]): ChaosModelSet => chaosModels(inner(), { seed, rules }, options);
const ask = (purpose: ModelPurpose, signal?: AbortSignal) =>
  req(purpose, { turn: 0, nodes: NODES, scenarioId: 's', stepKey: 'k', stepText: 'x', route: '/', attempt: 1 }, signal === undefined ? {} : { signal });
const fails = async (p: Promise<unknown>): Promise<unknown> => p.then(() => undefined, (e: unknown) => e);

describe('chaosModels passthrough', () => {
  it('without rules each purpose answers exactly like the wrapped model and keeps its id', async () => {
    const chaos = make([]);
    const plain = inner();
    expect(chaos.judge.id).toBe('fake:judge');
    for (const p of ['extract', 'act', 'checkgen', 'judge'] as const) {
      expect(await chaos[p].generate(ask(p))).toEqual(await plain[p].generate(ask(p)));
    }
    expect(chaos.stats.calls).toEqual({ extract: 1, act: 1, checkgen: 1, judge: 1 });
    expect(chaos.stats.faults).toEqual({ extract: 0, act: 0, checkgen: 0, judge: 0 });
    expect(chaos.events).toEqual([]);
    expect(chaos.seed).toBe('m');
  });

  it('rejects an invalid plan at construction', () => {
    expect(() => chaosModels(inner(), { seed: 1, rules: [{ at: 'act', fault: { kind: 'melt' } } as unknown as ModelRule] })).toThrow(/unknown fault kind "melt"/);
  });
});

describe('failing faults', () => {
  it('unavailable is a retryable MODEL_UNAVAILABLE unless permanent', async () => {
    const err = (await fails(make([{ at: 'judge', fault: { kind: 'unavailable' } }]).judge.generate(ask('judge')))) as AiBddError;
    expect([err.code, err.retryable]).toEqual(['MODEL_UNAVAILABLE', true]);
    const perm = (await fails(make([{ at: 'judge', fault: { kind: 'unavailable', permanent: true, message: 'key revoked' } }]).judge.generate(ask('judge')))) as AiBddError;
    expect([perm.code, perm.retryable, perm.message]).toEqual(['MODEL_UNAVAILABLE', false, 'key revoked']);
  });

  it('rate-limit is a retryable MODEL_UNAVAILABLE with status 429 and the retry-after hint', async () => {
    const err = (await fails(make([{ at: '*', fault: { kind: 'rate-limit', retryAfterMs: 1500 } }]).act.generate(ask('act')))) as AiBddError;
    expect(err.code).toBe('MODEL_UNAVAILABLE');
    expect(err.retryable).toBe(true);
    expect(err.details).toMatchObject({ statusCode: 429, retryAfterMs: 1500, chaos: true, purpose: 'act' });
  });

  it('N consecutive failures, then success', async () => {
    const chaos = make([{ at: 'extract', from: 1, times: 2, fault: { kind: 'rate-limit' } }]);
    const outcomes: string[] = [];
    for (let i = 0; i < 4; i += 1) outcomes.push(await chaos.extract.generate(ask('extract')).then(() => 'ok', (e: AiBddError) => e.code));
    expect(outcomes).toEqual(['MODEL_UNAVAILABLE', 'MODEL_UNAVAILABLE', 'ok', 'ok']);
    expect(chaos.stats.faults.extract).toBe(2);
    expect(chaos.stats.calls.extract).toBe(4);
  });

  it('timeout waits on the injected sleep (virtually), then fails with a retryable MODEL_UNAVAILABLE', async () => {
    const chaos = make([{ at: 'judge', fault: { kind: 'timeout', ms: 90_000 } }]);
    const t0 = Date.now();
    const err = (await fails(chaos.judge.generate(ask('judge')))) as AiBddError;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(err.code).toBe('MODEL_UNAVAILABLE');
    expect(err.retryable).toBe(true);
    expect(err.message).toContain('timed out');
    expect(chaos.stats.virtualDelayMs()).toBe(90_000);
    const dflt = make([{ at: 'judge', fault: { kind: 'timeout' } }]);
    await fails(dflt.judge.generate(ask('judge')));
    expect(dflt.stats.virtualDelayMs()).toBe(30_000);
  });

  it('throw carries any supported code; throw-raw is a plain Error', async () => {
    const e1 = (await fails(make([{ at: 'act', fault: { kind: 'throw', code: 'MODEL_OUTPUT_INVALID', message: 'bad' } }]).act.generate(ask('act')))) as AiBddError;
    expect([e1.code, e1.retryable, e1.message]).toEqual(['MODEL_OUTPUT_INVALID', false, 'bad']);
    const e2 = (await fails(make([{ at: 'act', fault: { kind: 'throw', code: 'MODEL_UNAVAILABLE', retryable: false } }]).act.generate(ask('act')))) as AiBddError;
    expect(e2.retryable).toBe(false);
    const e3 = await fails(make([{ at: 'act', fault: { kind: 'throw-raw', message: 'oops' } }]).act.generate(ask('act')));
    expect(e3).toBeInstanceOf(Error);
    expect(e3).not.toBeInstanceOf(AiBddError);
  });

  it('latency is virtual and still returns the real answer', async () => {
    const waits: number[] = [];
    const chaos = make([{ at: 'extract', fault: { kind: 'latency', ms: 400 } }], 'm', { sleep: async (ms) => void waits.push(ms) });
    expect((await chaos.extract.generate(ask('extract'))).object).toEqual(OBJECT);
    expect(waits).toEqual([400]);
  });

  it('hang never settles, but rejects with ABORTED when the request signal fires (unless ignoreSignal)', async () => {
    const chaos = make([{ at: 'judge', fault: { kind: 'hang' } }]);
    const pending = await Promise.race([chaos.judge.generate(ask('judge')).then(() => 'settled', () => 'rejected'), new Promise<string>((r) => setTimeout(() => r('pending'), 30))]);
    expect(pending).toBe('pending');

    const ac = new AbortController();
    const p = fails(make([{ at: 'judge', fault: { kind: 'hang' } }]).judge.generate(ask('judge', ac.signal)));
    ac.abort();
    expect(((await p) as AiBddError).code).toBe('ABORTED');
    const already = AbortSignal.abort();
    expect(((await fails(make([{ at: 'judge', fault: { kind: 'hang' } }]).judge.generate(ask('judge', already)))) as AiBddError).code).toBe('ABORTED');

    const stubborn = make([{ at: 'judge', fault: { kind: 'hang', ignoreSignal: true } }]);
    const ac2 = new AbortController();
    const q = stubborn.judge.generate(ask('judge', ac2.signal)).then(() => 'settled', () => 'rejected');
    ac2.abort();
    expect(await Promise.race([q, new Promise<string>((r) => setTimeout(() => r('pending'), 30))])).toBe('pending');
  });
});

describe('damaged answers (derived from the real answer)', () => {
  it('malformed-json: unparsable text, no object, no tool calls', async () => {
    const res = await make([{ at: 'extract', fault: { kind: 'malformed-json' } }]).extract.generate(ask('extract'));
    expect(res.object).toBeUndefined();
    expect(res.toolCalls).toEqual([]);
    expect(res.finishReason).toBe('stop');
    expect(() => JSON.parse(res.text ?? '')).toThrow();
    expect(res.text?.startsWith('{"')).toBe(true);
    expect(res.text).toContain('"verdict"');
  });

  it('malformed-json on a tool-calling answer replaces the calls with garbage text', async () => {
    const res = await make([{ at: 'act', fault: { kind: 'malformed-json' } }]).act.generate(ask('act'));
    expect(res.toolCalls).toEqual([]);
    expect(() => JSON.parse(res.text ?? '')).toThrow();
  });

  it('schema-invalid: valid JSON that no object schema accepts, and reproducible by seed', async () => {
    const variants = new Set<string>();
    for (let s = 0; s < 12; s += 1) {
      const res = await make([{ at: 'judge', fault: { kind: 'schema-invalid' } }], s).judge.generate(ask('judge'));
      const o = res.object;
      expect(JSON.stringify(o)).not.toBe(JSON.stringify(OBJECT));
      const rootArray = Array.isArray(o);
      const rootNumber = typeof o === 'number';
      const poisoned = !rootArray && !rootNumber && JSON.stringify(o).includes('"chaos":true');
      expect(rootArray || rootNumber || poisoned).toBe(true);
      variants.add(rootArray ? 'array' : rootNumber ? 'number' : 'poisoned');
    }
    expect(variants.size).toBeGreaterThan(1);
    const a = await make([{ at: 'judge', fault: { kind: 'schema-invalid' } }], 5).judge.generate(ask('judge'));
    const b = await make([{ at: 'judge', fault: { kind: 'schema-invalid' } }], 5).judge.generate(ask('judge'));
    expect(a).toEqual(b);
  });

  it('schema-invalid on tool calls corrupts the arguments; on a text-only answer it adds a foreign object', async () => {
    const act = await make([{ at: 'act', fault: { kind: 'schema-invalid' } }]).act.generate(ask('act'));
    expect(act.toolCalls[0]?.name).toBe('click');
    expect(act.toolCalls[0]?.args).toEqual({ ref: 12345, value: { chaos: true }, url: null });
    const text = await make([{ at: 'checkgen', fault: { kind: 'schema-invalid' } }]).checkgen.generate(ask('checkgen'));
    expect(text.object).toEqual({ chaos: true });
  });

  it('empty: no text, no object, no tool calls', async () => {
    const res = await make([{ at: 'act', fault: { kind: 'empty' } }]).act.generate(ask('act'));
    expect(res.text).toBeUndefined();
    expect(res.object).toBeUndefined();
    expect(res.toolCalls).toEqual([]);
    expect(res.finishReason).toBe('stop');
  });

  it('bad-tool-call: unknown tool, bad arguments, an extra unknown call after the real one', async () => {
    const unknown = await make([{ at: 'act', fault: { kind: 'bad-tool-call', mode: 'unknown-tool' } }]).act.generate(ask('act'));
    expect(unknown.toolCalls).toEqual([{ id: 'chaos-unknown', name: 'format_disk', args: { target: '/' } }]);
    expect(unknown.finishReason).toBe('tool-calls');
    const bad = await make([{ at: 'act', fault: { kind: 'bad-tool-call', mode: 'bad-args' } }]).act.generate(ask('act'));
    expect(bad.toolCalls).toHaveLength(1);
    expect(bad.toolCalls[0]?.name).toBe('click');
    expect(bad.toolCalls[0]?.args['ref']).toBe(12345);
    const extra = await make([{ at: 'act', fault: { kind: 'bad-tool-call', mode: 'extra-unknown' } }]).act.generate(ask('act'));
    expect(extra.toolCalls.map((c) => c.name)).toEqual(['click', 'format_disk']);
    const none = await make([{ at: 'judge', fault: { kind: 'bad-tool-call', mode: 'bad-args' } }]).judge.generate(ask('judge'));
    expect(none.toolCalls.map((c) => c.name)).toEqual(['click']);
  });

  it('oversized pads the first string of the object (everything else stays valid), or the text', async () => {
    const res = await make([{ at: 'judge', fault: { kind: 'oversized', chars: 5000 } }]).judge.generate(ask('judge'));
    const o = res.object as JsonObject;
    expect(Object.keys(o).sort()).toEqual(Object.keys(OBJECT).sort());
    expect((o['verdict'] as string).length).toBe('holds'.length + 5000);
    expect(o['probability']).toBe(0.9);
    expect(res.usage.outputTokens).toBeGreaterThanOrEqual(1250);

    const text = await make([{ at: 'checkgen', fault: { kind: 'oversized', chars: 3000 } }]).checkgen.generate(ask('checkgen'));
    expect(text.text?.length).toBe('{"predicates":[]}'.length + 3000);

    const forced = await make([{ at: 'judge', fault: { kind: 'oversized', chars: 100, where: 'text' } }]).judge.generate(ask('judge'));
    expect(forced.text?.length).toBe(100);
    expect(forced.object).toEqual(OBJECT);
    const dflt = await make([{ at: 'judge', fault: { kind: 'oversized' } }]).judge.generate(ask('judge'));
    expect(((dflt.object as JsonObject)['verdict'] as string).length).toBe('holds'.length + 1_000_000);
  });

  it('oversized reaches strings nested in arrays and falls back to a padding key', async () => {
    const nested = createFakeModels({ rules: [{ rules: [{ id: 'n', purpose: 'judge', respond: { object: { list: [1, { deep: ['x'] }] } } }, { id: 'e', purpose: 'extract', respond: { object: { n: 1, flags: [true] } } }] }] });
    const chaos = chaosModels(nested, { seed: 1, rules: [{ at: '*', fault: { kind: 'oversized', chars: 10 } }] });
    const a = await chaos.judge.generate(ask('judge'));
    expect(JSON.stringify(a.object)).toContain(`x${'x'.repeat(10)}`);
    const b = await chaos.extract.generate(ask('extract'));
    expect((b.object as JsonObject)['chaosPadding']).toBe('x'.repeat(10));
  });

  it('truncated cuts the real answer in half and reports finishReason length', async () => {
    const res = await make([{ at: 'judge', fault: { kind: 'truncated' } }]).judge.generate(ask('judge'));
    expect(res.finishReason).toBe('length');
    expect(res.object).toBeUndefined();
    const full = JSON.stringify(OBJECT);
    expect(res.text).toBe(full.slice(0, Math.floor(full.length / 2)));
    expect(res.toolCalls).toEqual([]);
  });

  it('finish-reason keeps the content and only changes the reason', async () => {
    const res = await make([{ at: 'judge', fault: { kind: 'finish-reason', reason: 'error' } }]).judge.generate(ask('judge'));
    expect(res.finishReason).toBe('error');
    expect(res.object).toEqual(OBJECT);
  });
});

describe('rule matching', () => {
  it('context filters select requests by structured context', async () => {
    const chaos = make([{ at: 'extract', context: { attempt: 2 }, fault: { kind: 'unavailable' } }]);
    await chaos.extract.generate(ask('extract'));
    const second = { ...ask('extract'), context: { ...ask('extract').context, attempt: 2 } };
    expect(((await fails(chaos.extract.generate(second))) as AiBddError).code).toBe('MODEL_UNAVAILABLE');
  });

  it('a wrapped model that fails is not masked: faults that need the real answer propagate its error', async () => {
    const throwing: ModelSet = inner();
    const broken = { ...throwing, judge: { id: 'broken', generate: async () => Promise.reject(new AiBddError('MODEL_NO_RULE', 'no rule')) } };
    const chaos = chaosModels(broken, { seed: 1, rules: [{ at: 'judge', fault: { kind: 'truncated' } }] });
    expect(((await fails(chaos.judge.generate(ask('judge')))) as AiBddError).code).toBe('MODEL_NO_RULE');
  });

  it('probabilistic plans are deterministic by seed', async () => {
    const run = async (seed: number | string): Promise<string> => {
      const chaos = make([{ at: 'judge', probability: 0.5, fault: { kind: 'unavailable' } }], seed);
      let out = '';
      for (let i = 0; i < 30; i += 1) out += await chaos.judge.generate(ask('judge')).then(() => '.', () => 'x');
      return out;
    };
    const a = await run('one');
    expect(await run('one')).toBe(a);
    expect(await run('two')).not.toBe(a);
  });

  it('onEvent reports each injection with its rule and purpose', async () => {
    const seen: string[] = [];
    const chaos = make([{ at: 'judge', fault: { kind: 'latency', ms: 5 } }, { at: 'judge', fault: { kind: 'empty' } }], 'm', { onEvent: (e) => seen.push(`${e.at}:${e.rule}:${e.fault}`) });
    await chaos.judge.generate(ask('judge'));
    expect(seen).toEqual(['judge:0:latency', 'judge:1:empty']);
  });
});
