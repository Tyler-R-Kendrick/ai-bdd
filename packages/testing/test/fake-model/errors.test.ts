import { describe, expect, it } from 'vitest';
import { AiBddError } from '@ai-bdd/sdk/contracts';
import { createFakeModels } from '@ai-bdd/testing';
import { NODES, req } from './helpers.ts';

describe('fake-model MODEL_NO_RULE', () => {
  it('throws AiBddError MODEL_NO_RULE with details {purpose, context} when nothing matches', async () => {
    const m = createFakeModels({ rules: [{ rules: [{ id: 'x', purpose: 'extract', when: { docUri: 'a' }, respond: { text: 't' } }] }] });
    const context = { docUri: 'b', sectionId: 's1', attempt: 1 };
    const err = await m.extract.generate(req('extract', context)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiBddError);
    const e = err as AiBddError;
    expect(e.code).toBe('MODEL_NO_RULE');
    expect(e.retryable).toBe(false);
    expect(e.details).toEqual({ purpose: 'extract', context });
    expect(e.message).toContain('extract');
  });

  it('throws with no rules at all, for every purpose', async () => {
    const m = createFakeModels({});
    for (const p of ['extract', 'act', 'checkgen', 'judge'] as const) {
      await expect(m[p].generate(req(p, { k: 'v' }))).rejects.toMatchObject({ code: 'MODEL_NO_RULE', details: { purpose: p, context: { k: 'v' } } });
    }
    expect(m.calls).toEqual([]);
  });

  it('a script target that matches zero nodes throws MODEL_NO_RULE (not a silent pass)', async () => {
    const m = createFakeModels({
      rules: [{ rules: [{ id: 'act1', purpose: 'act', respond: { script: [{ tool: 'click', args: { target: { role: 'button', name: 'Nope' } } }] } }] }],
    });
    const err = (await m.act.generate(req('act', { turn: 0, nodes: NODES })).catch((e: unknown) => e)) as AiBddError;
    expect(err.code).toBe('MODEL_NO_RULE');
    expect(err.details).toMatchObject({ purpose: 'act', rule: 'act1', target: { role: 'button', name: 'Nope' } });
    expect(m.calls).toHaveLength(0);
  });

  it('an aborted signal rejects with ABORTED', async () => {
    const m = createFakeModels({ rules: [{ rules: [{ id: 'x', purpose: 'extract', respond: { text: 't' } }] }] });
    const ac = new AbortController();
    ac.abort();
    await expect(m.extract.generate(req('extract', {}, { signal: ac.signal }))).rejects.toMatchObject({ code: 'ABORTED' });
  });
});
