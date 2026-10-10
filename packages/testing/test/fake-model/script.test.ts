import { describe, expect, it } from 'vitest';
import type { JsonObject } from '@ai-bdd/sdk/contracts';
import { createFakeModels, type FakeRuleFile } from '@ai-bdd/testing';
import { NODES, req } from './helpers.ts';

const script: FakeRuleFile = {
  rules: [
    {
      id: 'upgrade',
      purpose: 'act',
      when: { stepText: { contains: 'upgrade' } },
      respond: {
        script: [
          { tool: 'click', args: { target: { role: 'button', name: 'Upgrade to Pro', within: 'Plan' } } },
          { tool: 'fill', args: { target: { role: 'textbox', name: 'Street' }, text: 'Main St' } },
          { tool: 'navigate', args: { url: 'http://localhost/x' } },
          { tool: 'complete_step', args: { status: 'done', summary: 'explicit' } },
        ],
      },
    },
  ],
};
const ctx = (turn: number) => ({ scenarioId: 's', stepKey: 'k', stepText: 'the user clicks upgrade', turn, route: '/settings/billing', nodes: NODES });

describe('fake-model act scripts', () => {
  it('picks script[context.turn] and resolves target to ref, removing target from args', async () => {
    const m = createFakeModels({ rules: [script] });
    const r0 = await m.act.generate(req('act', ctx(0)));
    expect(r0.toolCalls).toHaveLength(1);
    expect(r0.toolCalls[0]).toMatchObject({ name: 'click', args: { ref: 'e4' } });
    expect(r0.toolCalls[0]?.args).not.toHaveProperty('target');
    expect(r0.finishReason).toBe('tool-calls');
    const r1 = await m.act.generate(req('act', ctx(1)));
    expect(r1.toolCalls[0]).toMatchObject({ name: 'fill', args: { ref: 'e5', text: 'Main St' } });
    const r2 = await m.act.generate(req('act', ctx(2)));
    expect(r2.toolCalls[0]).toMatchObject({ name: 'navigate', args: { url: 'http://localhost/x' } });
    expect(r2.toolCalls[0]?.args).not.toHaveProperty('ref');
  });

  it('script past the end emits complete_step {status: done, summary}', async () => {
    const m = createFakeModels({ rules: [script] });
    for (const turn of [4, 5, 99]) {
      const r = await m.act.generate(req('act', ctx(turn)));
      expect(r.toolCalls).toHaveLength(1);
      expect(r.toolCalls[0]?.name).toBe('complete_step');
      expect(r.toolCalls[0]?.args).toMatchObject({ status: 'done' });
      expect(typeof r.toolCalls[0]?.args['summary']).toBe('string');
      expect(r.finishReason).toBe('tool-calls');
    }
  });

  it('an explicit complete_step script entry is passed through unchanged', async () => {
    const m = createFakeModels({ rules: [script] });
    const r = await m.act.generate(req('act', ctx(3)));
    expect(r.toolCalls[0]).toMatchObject({ name: 'complete_step', args: { status: 'done', summary: 'explicit' } });
  });

  it('missing/invalid turn defaults to 0', async () => {
    const m = createFakeModels({ rules: [script] });
    const { turn: _t, ...noTurn } = ctx(0);
    expect((await m.act.generate(req('act', noTurn))).toolCalls[0]?.name).toBe('click');
  });

  it('tool call ids are deterministic and differ per turn', async () => {
    const a = createFakeModels({ rules: [script] });
    const b = createFakeModels({ rules: [script] });
    const ids = async (m: typeof a) => [(await m.act.generate(req('act', ctx(0)))).toolCalls[0]?.id, (await m.act.generate(req('act', ctx(1)))).toolCalls[0]?.id];
    const ia = await ids(a);
    expect(ia).toEqual(await ids(b));
    expect(ia[0]).not.toBe(ia[1]);
    expect(ia[0]).toMatch(/^call_[0-9a-f]{12}$/);
  });
});

describe('fake-model target resolution (within)', () => {
  const rule = (target: JsonObject): FakeRuleFile => ({ rules: [{ id: 'r', purpose: 'act', respond: { script: [{ tool: 'click', args: { target } }] } }] });
  const run = async (target: JsonObject, nodes = NODES) => {
    const m = createFakeModels({ rules: [rule(target)] });
    return (await m.act.generate(req('act', { turn: 0, nodes }))).toolCalls[0];
  };

  it('without within the first role+name match in document order wins (ambiguity is for the actor to detect)', async () => {
    expect((await run({ role: 'button', name: 'Submit' }))?.args['ref']).toBe('e2');
  });
  it('within selects among nodes whose ancestors include the name', async () => {
    expect((await run({ role: 'button', name: 'Submit', within: 'Shipping' }))?.args['ref']).toBe('e2');
    expect((await run({ role: 'button', name: 'Submit', within: 'Billing address' }))?.args['ref']).toBe('e3');
  });
  it('within that no candidate has resolves to nothing -> MODEL_NO_RULE', async () => {
    await expect(run({ role: 'button', name: 'Submit', within: 'Plan' })).rejects.toMatchObject({ code: 'MODEL_NO_RULE' });
  });
  it('within must be an ancestor, not the node itself or a name elsewhere', async () => {
    await expect(run({ role: 'navigation', name: 'Primary', within: 'Primary' })).rejects.toMatchObject({ code: 'MODEL_NO_RULE' });
  });
  it('role must match as well as name', async () => {
    await expect(run({ role: 'link', name: 'Submit' })).rejects.toMatchObject({ code: 'MODEL_NO_RULE' });
  });
  it('names compare after whitespace normalization', async () => {
    const nodes = [{ ref: 'n9', role: 'button', name: 'Go   Pro ', ancestors: ['Plan  '] }];
    expect((await run({ role: 'button', name: 'Go Pro', within: 'Plan' }, nodes))?.args['ref']).toBe('n9');
  });
  it('target without name matches on role only', async () => {
    expect((await run({ role: 'textbox' }))?.args['ref']).toBe('e5');
  });
  it('nodes absent from context -> MODEL_NO_RULE with the context in details', async () => {
    const m = createFakeModels({ rules: [rule({ role: 'button', name: 'X' })] });
    const err = await m.act.generate(req('act', { turn: 0 })).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'MODEL_NO_RULE', details: { purpose: 'act', context: { turn: 0 } } });
  });
});
