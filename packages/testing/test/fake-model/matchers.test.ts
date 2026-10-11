import { describe, expect, it } from 'vitest';
import { AiBddError, type JsonObject } from '@ai-bdd/sdk/contracts';
import { createFakeModels, type FakeMatcher } from '@ai-bdd/testing';
import { req } from './helpers.ts';

async function matches(when: { [path: string]: FakeMatcher }, context: JsonObject): Promise<boolean> {
  const m = createFakeModels({ rules: [{ rules: [{ id: 'r', purpose: 'extract', when, respond: { object: { ok: true } } }] }] });
  try {
    await m.extract.generate(req('extract', context));
    return true;
  } catch (e) {
    if (e instanceof AiBddError && e.code === 'MODEL_NO_RULE') return false;
    throw e;
  }
}

const CTX: JsonObject = {
  docUri: 'docs/billing.md',
  attempt: 2,
  flag: true,
  nested: { deep: { value: 'Upgrading to Pro' } },
  list: ['alpha', 'beta'],
  items: [{ name: 'first' }, { name: 'second' }],
  empty: '',
};

describe('fake-model matcher table', () => {
  const table: [string, { [path: string]: FakeMatcher }, boolean][] = [
    ['equals: exact string', { docUri: 'docs/billing.md' }, true],
    ['equals: different string', { docUri: 'docs/todos.md' }, false],
    ['equals: case sensitive', { docUri: 'DOCS/billing.md' }, false],
    ['equals: number compares by its string form', { attempt: '2' }, true],
    ['equals: boolean compares by its string form', { flag: 'true' }, true],
    ['equals: empty string', { empty: '' }, true],
    ['equals: nested dotted path', { 'nested.deep.value': 'Upgrading to Pro' }, true],
    ['equals: array index in path', { 'items.1.name': 'second' }, true],
    ['equals: array index out of range does not resolve', { 'items.2.name': 'x' }, false],
    ['equals: object value never equals a string', { nested: 'x' }, false],
    ['contains: substring', { docUri: { contains: 'billing' } }, true],
    ['contains: not a substring', { docUri: { contains: 'login' } }, false],
    ['contains: array element', { list: { contains: 'beta' } }, true],
    ['contains: array element must be whole', { list: { contains: 'bet' } }, false],
    ['contains: on number is false', { attempt: { contains: '2' } }, false],
    ['notContains: absent substring', { docUri: { notContains: 'login' } }, true],
    ['notContains: present substring', { docUri: { notContains: 'billing' } }, false],
    ['notContains: array without element', { list: { notContains: 'gamma' } }, true],
    ['notContains: array with element', { list: { notContains: 'alpha' } }, false],
    ['in: member', { docUri: { in: ['a', 'docs/billing.md'] } }, true],
    ['in: not a member', { docUri: { in: ['a', 'b'] } }, false],
    ['in: empty list', { docUri: { in: [] } }, false],
    ['in: number by string form', { attempt: { in: ['1', '2'] } }, true],
    ['missing path: equals fails', { nope: 'x' }, false],
    ['missing path: contains fails', { nope: { contains: 'x' } }, false],
    ['missing path: notContains also fails (unresolved never matches)', { nope: { notContains: 'x' } }, false],
    ['missing path: in fails', { nope: { in: ['x'] } }, false],
    ['missing nested path fails', { 'nested.nope.value': 'x' }, false],
    ['path through a string does not resolve', { 'docUri.length': '15' }, false],
    ['prototype keys do not resolve', { 'nested.constructor': 'x' }, false],
    ['all conditions must hold (and)', { docUri: { contains: 'billing' }, attempt: '3' }, false],
    ['all conditions hold', { docUri: { contains: 'billing' }, attempt: '2' }, true],
    ['empty when always matches', {}, true],
  ];
  it.each(table)('%s', async (_name, when, expected) => {
    expect(await matches(when, CTX)).toBe(expected);
  });

  it('purpose must match: a rule for judge never answers an extract request', async () => {
    const m = createFakeModels({ rules: [{ rules: [{ id: 'j', purpose: 'judge', respond: { object: { v: 1 } } }] }] });
    await expect(m.extract.generate(req('extract', {}))).rejects.toMatchObject({ code: 'MODEL_NO_RULE' });
    await expect(m.judge.generate(req('judge', {}))).resolves.toMatchObject({ object: { v: 1 } });
  });

  it('first match wins, rules in file order then file-internal order', async () => {
    const m = createFakeModels({
      rules: [
        { rules: [{ id: 'a1', purpose: 'extract', when: { docUri: 'nope' }, respond: { object: { who: 'a1' } } }, { id: 'a2', purpose: 'extract', respond: { object: { who: 'a2' } } }] },
        { rules: [{ id: 'b1', purpose: 'extract', respond: { object: { who: 'b1' } } }] },
      ],
    });
    const r = await m.extract.generate(req('extract', { docUri: 'x' }));
    expect(r.object).toEqual({ who: 'a2' });
    expect(m.calls[0]?.ruleId).toBe('a2');
  });
});
