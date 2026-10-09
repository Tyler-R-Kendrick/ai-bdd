import { describe, expect, it } from 'vitest';
import { withHash, type BindingDescriptor } from '@ai-bdd/contracts';
import { buildExtractionSchema, validateParams } from '../../src/index.js';

function binding(overrides: Partial<BindingDescriptor> & Pick<BindingDescriptor, 'id' | 'pattern'>) {
  return withHash({ provider: 'ts:local', patternKind: 'cucumber-expression', kind: 'any', ...overrides });
}

describe('buildExtractionSchema', () => {
  it('maps ParamDecl types to JSON Schema', () => {
    const schema = buildExtractionSchema([
      { name: 'count', type: 'int' },
      { name: 'weight', type: 'float' },
      { name: 'plan', type: 'enum', enumValues: ['free', 'pro'] },
      { name: 'name', type: 'string' },
      { name: 'note', type: 'word', optional: true },
    ]);
    expect(schema).toEqual({
      type: 'object',
      properties: {
        count: { type: 'number' },
        weight: { type: 'number' },
        plan: { type: 'string', enum: ['free', 'pro'] },
        name: { type: 'string' },
        note: { type: 'string' },
      },
      required: ['count', 'weight', 'plan', 'name'],
      additionalProperties: false,
    });
  });
});

describe('validateParams (R-K5d)', () => {
  it('accepts verbatim string and word values and returns them typed', () => {
    const b = binding({ id: 'b', pattern: 'seed a workspace {string} as {word}', params: [
      { name: 'company', type: 'string' },
      { name: 'plan', type: 'word' },
    ] });
    const result = validateParams({ text: 'seed a workspace "Acme" as pro' }, b, { company: 'Acme', plan: 'pro' });
    expect(result).toEqual({ ok: true, params: { company: 'Acme', plan: 'pro' } });
  });

  it('rejects a string value that does not occur verbatim', () => {
    const b = binding({ id: 'b', pattern: 'seed a workspace {string}', params: [{ name: 'company', type: 'string' }] });
    const result = validateParams({ text: 'seed a workspace "Acme"' }, b, { company: 'Globex' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('verbatim');
  });

  it('relaxes the verbatim rule when derived:true', () => {
    const b = binding({ id: 'b', pattern: 'seed a workspace {string}', params: [{ name: 'company', type: 'string', derived: true }] });
    expect(validateParams({ text: 'seed a workspace Acme' }, b, { company: 'ACME' }).ok).toBe(true);
  });

  it('requires int/float to parse from a numeric literal in the text', () => {
    const b = binding({ id: 'b', pattern: 'I have {int} items', params: [{ name: 'count', type: 'int' }] });
    expect(validateParams({ text: 'I have 3 items' }, b, { count: 3 })).toEqual({ ok: true, params: { count: 3 } });
    const bad = validateParams({ text: 'I have three items' }, b, { count: 3 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain('numeric literal');
  });

  it('parses float values', () => {
    const b = binding({ id: 'b', pattern: 'weighs {float} kg', params: [{ name: 'weight', type: 'float' }] });
    expect(validateParams({ text: 'weighs 2.5 kg' }, b, { weight: '2.5' })).toEqual({ ok: true, params: { weight: 2.5 } });
  });

  it('requires enum values to be members of enumValues', () => {
    const b = binding({ id: 'b', pattern: 'the plan is {word}', params: [{ name: 'plan', type: 'enum', enumValues: ['free', 'pro'] }] });
    expect(validateParams({ text: 'the plan is pro' }, b, { plan: 'pro' }).ok).toBe(true);
    const bad = validateParams({ text: 'the plan is pro' }, b, { plan: 'enterprise' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain('enum');
  });

  it('fails when a required parameter is missing and skips optional ones', () => {
    const b = binding({ id: 'b', pattern: 'x {string} y {string}', params: [
      { name: 'required', type: 'string' },
      { name: 'optional', type: 'string', optional: true },
    ] });
    const missing = validateParams({ text: 'x a y b' }, b, { optional: 'b' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toContain('required');
    expect(validateParams({ text: 'x a y b' }, b, { required: 'a' })).toEqual({ ok: true, params: { required: 'a' } });
  });
});
