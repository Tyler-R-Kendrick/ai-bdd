import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  AiBddError,
  ERROR_CODES,
  bindingHash,
  bindingSetHash,
  canonicalJson,
  gaugeTemplateToRegExp,
  hashJson,
  judgeCacheKey,
  normalizeStepText,
  renderTemplate,
  sha256Hex,
  slug,
  toJsonValue,
  uuidv7,
  withHash,
  ZERO_HASH,
  type BindingDescriptor,
  type JsonValue,
} from '../../src/index.js';

describe('normalizeStepText (P5)', () => {
  it('NFC-normalizes, trims, collapses whitespace and strips one trailing period', () => {
    expect(normalizeStepText('  Seed   a  workspace "Acme"  ')).toBe('Seed a workspace "Acme"');
    expect(normalizeStepText('The plan badge reads "Pro".')).toBe('The plan badge reads "Pro"');
    expect(normalizeStepText('Trailing..')).toBe('Trailing.');
    expect(normalizeStepText('e\u0301tude')).toBe('\u00e9tude');
  });
});

describe('canonicalJson (RFC 8785)', () => {
  it('sorts keys by UTF-16 code units at every level', () => {
    expect(canonicalJson({ b: 1, a: { d: 4, c: [3, 2] } })).toBe('{"a":{"c":[3,2],"d":4},"b":1}');
  });

  it('matches the RFC 8785 number formatting vectors', () => {
    expect(canonicalJson(1e21)).toBe('1e+21');
    expect(canonicalJson(-0)).toBe('0');
    expect(canonicalJson(0.1)).toBe('0.1');
    expect(canonicalJson(1 / 3)).toBe('0.3333333333333333');
  });

  it('escapes strings the same way JSON.stringify does', () => {
    expect(canonicalJson('a"b\\c\n')).toBe('"a\\"b\\\\c\\n"');
  });

  it('is idempotent and order independent', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (record) => {
        const a = canonicalJson(toJsonValue(record));
        const b = canonicalJson(toJsonValue({ ...record }));
        expect(canonicalJson(JSON.parse(a) as JsonValue)).toBe(a);
        expect(a).toBe(b);
      }),
      { numRuns: 200 },
    );
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });
});

describe('sha256Hex and uuidv7', () => {
  it('hashes the empty string', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('produces a version 7 uuid', () => {
    const id = uuidv7(1_700_000_000_000);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });

  it('exposes a 64-zero first chain hash', () => {
    expect(ZERO_HASH).toHaveLength(64);

    expect(new Set(ZERO_HASH)).toEqual(new Set(['0']));
  });
});

describe('gauge templates (8.1.2)', () => {
  it('matches and recovers parameters', () => {
    const matcher = gaugeTemplateToRegExp('Seed a workspace <name> on the <plan> plan');
    const match = matcher.match('Seed a workspace "Acme" on the "free" plan');
    expect(match?.params).toEqual({ name: 'Acme', plan: 'free' });
    expect(matcher.parameters).toEqual(['name', 'plan']);
  });
  it('round-trips generated values', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9]{1,12}$/u),
        fc.stringMatching(/^[A-Za-z0-9]{1,8}$/u),
        (name, plan) => {
          const rendered = renderTemplate('Seed a workspace <name> on the <plan> plan', { name, plan });
          const match = gaugeTemplateToRegExp('Seed a workspace <name> on the <plan> plan').match(rendered);
          expect(match?.params).toEqual({ name: normalizeStepText(name), plan });
        },
      ),
      { numRuns: 200 },
    );
  });

  it('round-trips multi-word values through the quoted form', () => {
    const matcher = gaugeTemplateToRegExp('Seed a workspace <name> on the <plan> plan');
    const match = matcher.match('Seed a workspace \"Acme West\" on the \"pro tier\" plan');
    expect(match?.params).toEqual({ name: 'Acme West', plan: 'pro tier' });
  });
  it('does not treat special parameters as wildcards', () => {
    const matcher = gaugeTemplateToRegExp('Sign in as <secret:adminPassword>');
    expect(matcher.parameters).toEqual([]);
    expect(matcher.match('Sign in as <secret:adminPassword>')).not.toBeNull();
    expect(matcher.match('Sign in as anything')).toBeNull();
  });
});
describe('binding hashing (R-K6)', () => {
  const descriptor: BindingDescriptor = {
    id: 'ts:local#seed-workspace',
    provider: 'ts:local',
    pattern: 'Seed a workspace {string} on the {string} plan',
    patternKind: 'cucumber-expression',
    kind: 'setup',
    description: 'Seeds a workspace with the given name and plan.',
    examples: ['Seed a workspace "Acme" on the "free" plan'],
    counterExamples: ['Seed an empty workspace'],
    params: [
      { name: 'name', type: 'string' },
      { name: 'plan', type: 'enum', enumValues: ['free', 'pro'] },
    ],
  };
  it('is stable across key order and reflects semantic changes', () => {
    const reordered: BindingDescriptor = {
      kind: descriptor.kind,
      pattern: descriptor.pattern,
      patternKind: descriptor.patternKind,
      provider: descriptor.provider,
      id: descriptor.id,
      params: descriptor.params,
      counterExamples: descriptor.counterExamples,
      examples: descriptor.examples,
      description: descriptor.description,
    };
    expect(bindingHash(reordered)).toBe(bindingHash(descriptor));
    expect(bindingHash({ ...descriptor, description: 'other' })).not.toBe(bindingHash(descriptor));
  });
  it('derives binding texts from pattern, description and examples', () => {
    const binding = withHash(descriptor);
    expect(binding.bindingTexts[0]).toBe('Seed a workspace <string> on the <string> plan');
    expect(binding.bindingTexts).toContain('Seeds a workspace with the given name and plan');
  });
  it('hashes a binding set independently of order', () => {
    const a = withHash(descriptor);
    const b = withHash({ ...descriptor, id: 'ts:local#reset', pattern: 'Reset test data', params: [] });
    expect(bindingSetHash([a, b])).toBe(bindingSetHash([b, a]));
  });
});
describe('judge cache key (R-K19)', () => {
  it('is order independent and sensitive to the prompt version', () => {
    const base = {
      criterion: 'The plan badge reads "Pro"',
      beforeShas: ['b1'],
      afterShas: ['a1', 'a2'],
      treeShas: ['t1'],
      modelId: 'fake:judge',
      promptVersion: 'judge-1',
    };
    expect(judgeCacheKey(base)).toBe(judgeCacheKey({ ...base, afterShas: ['a2', 'a1'] }));
    expect(judgeCacheKey(base)).not.toBe(judgeCacheKey({ ...base, promptVersion: 'judge-2' }));
  });
});
describe('errors and slugs', () => {
  it('marks only infrastructure groups retryable', () => {
    const retryable = Object.entries(ERROR_CODES)
      .filter(([, info]) => info.retryable)
      .map(([code]) => code);
    expect(retryable.sort()).toEqual(['DRIVER_UNAVAILABLE', 'MODEL_UNAVAILABLE', 'RESOURCE_LOCKED', 'SESSION_LIMIT']);
  });
  it('serializes to a payload', () => {
    const payload = AiBddError.payload(new AiBddError('STEP_AMBIGUOUS', 'two bindings match'));
    expect(payload).toMatchObject({ code: 'STEP_AMBIGUOUS', retryable: false, group: 'resolution' });
  });
  it('slugifies scenario names stably', () => {
    expect(slug('Member upgrades to Pro!')).toBe('member-upgrades-to-pro');
  });
  it('hashes JSON deterministically', () => {
    expect(hashJson({ a: 1, b: [true, null] })).toBe(hashJson({ b: [true, null], a: 1 }));
  });
});
