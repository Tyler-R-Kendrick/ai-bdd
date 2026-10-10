import { describe, expect, it } from 'vitest';
import { AiBddError } from '@ai-bdd/sdk/contracts';
import { aiSdkModels, createModelSet } from '../src/index.ts';
import { mockModel, textResult } from './helpers.ts';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AiBddError);
    return (e as AiBddError).code;
  }
  throw new Error('expected throw');
}

describe('createModelSet', () => {
  it('builds a ModelSet from string ids', () => {
    const set = createModelSet({ extract: 'p/a', act: 'p/b', checkgen: 'p/c', judge: 'p/d', maxRetries: 4 });
    expect([set.extract.id, set.act.id, set.checkgen.id, set.judge.id]).toEqual(['p/a', 'p/b', 'p/c', 'p/d']);
  });

  it('rejects unknown keys, missing purposes and non-string values with CONFIG_INVALID', () => {
    const ok = { extract: 'a', act: 'b', checkgen: 'c', judge: 'd' };
    expect(codeOf(() => createModelSet({ ...ok, bogus: 'x' }))).toBe('CONFIG_INVALID');
    expect(codeOf(() => createModelSet({ extract: 'a', act: 'b', checkgen: 'c' }))).toBe('CONFIG_INVALID');
    expect(codeOf(() => createModelSet({ ...ok, judge: 5 }))).toBe('CONFIG_INVALID');
    expect(codeOf(() => createModelSet({ ...ok, act: '' }))).toBe('CONFIG_INVALID');
    expect(codeOf(() => createModelSet({ ...ok, maxRetries: -1 }))).toBe('CONFIG_INVALID');
  });
});

describe('aiSdkModels', () => {
  it('rejects a missing purpose', () => {
    const m = mockModel(textResult('x'));
    expect(codeOf(() => aiSdkModels({ extract: m, act: m, checkgen: m } as never))).toBe('CONFIG_INVALID');
  });
});
