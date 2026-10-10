import { describe, expect, it } from 'vitest';
import { createFakeModels, type FakeRuleFile } from '@ai-bdd/testing';
import { NODES, req } from './helpers.ts';

const file: FakeRuleFile = {
  rules: [
    { id: 'ex', purpose: 'extract', when: { docUri: { contains: 'billing' } }, respond: { byAttempt: [{ object: { features: [{ title: 'Upgrade' }], notTestable: [] } }] } },
    { id: 'act', purpose: 'act', respond: { script: [{ tool: 'click', args: { target: { role: 'button', name: 'Upgrade to Pro', within: 'Plan' } } }] } },
    { id: 'chk', purpose: 'checkgen', respond: { object: { classification: 'change', predicates: [{ kind: 'exists', query: { role: 'status', name: 'Plan: Pro' } }] } } },
    { id: 'jdg', purpose: 'judge', respond: { samples: [{ probability: 0.95, verdict: 'holds', explanation: 'yes', observed: 'Plan: Pro' }, { probability: 0.9, verdict: 'holds', explanation: 'yes', observed: 'Plan: Pro' }] } },
  ],
};

async function session() {
  const m = createFakeModels({ rules: [file] });
  const out = [
    await m.extract.generate(req('extract', { docUri: 'docs/billing.md', attempt: 1 })),
    await m.act.generate(req('act', { turn: 0, nodes: NODES })),
    await m.act.generate(req('act', { turn: 1, nodes: NODES })),
    await m.checkgen.generate(req('checkgen', { criterion: 'plan is Pro' })),
    await m.judge.generate(req('judge', { sample: 0 })),
    await m.judge.generate(req('judge', { sample: 1 })),
    await m.judge.generate(req('judge', { sample: 2 })),
  ];
  return { out, calls: m.calls };
}

describe('fake-model determinism', () => {
  it('same inputs -> byte-identical outputs and logs across independent instances', async () => {
    const a = await session();
    const b = await session();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('determinism snapshot of a full session', async () => {
    const { out } = await session();
    expect(out).toMatchSnapshot();
  });

  it('call order does not change a response (no hidden counters)', async () => {
    const m = createFakeModels({ rules: [file] });
    const first = await m.act.generate(req('act', { turn: 0, nodes: NODES }));
    await m.judge.generate(req('judge', { sample: 1 }));
    await m.act.generate(req('act', { turn: 1, nodes: NODES }));
    const again = await m.act.generate(req('act', { turn: 0, nodes: NODES }));
    expect(again).toEqual(first);
  });

  it('all four models share one rule table and one call log', async () => {
    const a = createFakeModels({ rules: [file] });
    await a.extract.generate(req('extract', { docUri: 'docs/billing.md' }));
    await a.judge.generate(req('judge', {}));
    expect(a.calls.map((c) => c.purpose)).toEqual(['extract', 'judge']);
  });
});
