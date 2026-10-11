import { describe, expect, it } from 'vitest';
import { AiBddError } from '@ai-bdd/sdk/contracts';
import { validateFakeRuleFile } from '@ai-bdd/testing';

/** The problems validateFakeRuleFile reports for `value` (and checks the error shape on the way). */
function problems(value: unknown, source?: string): string[] {
  let err: unknown;
  try {
    validateFakeRuleFile(value, source);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(AiBddError);
  const e = err as AiBddError;
  expect(e.code).toBe('CONFIG_INVALID');
  const list = (e.details as { problems: string[] }).problems;
  expect(e.message).toBe(`Invalid fake model ${source ?? 'rule file'}:\n  - ${list.join('\n  - ')}`);
  expect((e.details as { source: string }).source).toBe(source ?? 'rule file');
  return list;
}
const rule = (over: Record<string, unknown>): { rules: unknown[] } => ({ rules: [{ id: 'r', purpose: 'act', respond: { text: 't' }, ...over }] });
const P = '$.rules[0](r)';

describe('fake rule file: the file itself', () => {
  it('must be an object with a rules array, and may only carry rules and $schema', () => {
    for (const value of [null, 'rules', 42, [], undefined]) expect(problems(value)).toEqual(['$: must be an object {"rules": [...]}']);
    expect(problems({})).toEqual(['$.rules: must be an array of rules']);
    expect(problems({ rules: {} })).toEqual(['$.rules: must be an array of rules']);
    expect(problems({ rules: [], extra: 1, more: 2 }, 'my.json')).toEqual(['$.extra: unknown key (allowed: rules)', '$.more: unknown key (allowed: rules)']);
  });

  it('returns exactly the rules of a valid file (the $schema hint is dropped) and accepts an empty list', () => {
    const rules = [{ id: 'a', purpose: 'act' as const, respond: { text: 'x' } }];
    const out = validateFakeRuleFile({ $schema: 'x', rules });
    expect(out).toEqual({ rules });
    expect(out.rules).toBe(rules);
    expect(validateFakeRuleFile({ rules: [] })).toEqual({ rules: [] });
  });

  it('rules that are not objects are reported by position; a rule with an id is labelled with it', () => {
    expect(problems({ rules: ['x', null, [], 3] })).toEqual([
      '$.rules[0]: rule must be an object', '$.rules[1]: rule must be an object', '$.rules[2]: rule must be an object', '$.rules[3]: rule must be an object',
    ]);
    expect(problems({ rules: [{ id: 'named', purpose: 'bogus', respond: { text: 't' } }, { id: 5, purpose: 'act', respond: { text: 't' } }] })).toEqual([
      '$.rules[0](named).purpose: must be one of extract, act, checkgen, judge',
      '$.rules[1].id: must be a non-empty string',
    ]);
  });
});

describe('fake rule file: rules', () => {
  it('need a non-empty string id, a known purpose and a respond; unknown keys are named', () => {
    expect(problems({ rules: [{ id: '', purpose: 5, wat: 1 }] })).toEqual([
      '$.rules[0]().id: must be a non-empty string', // an empty id still labels the rule, with empty parentheses
      '$.rules[0]().purpose: must be one of extract, act, checkgen, judge',
      '$.rules[0]().wat: unknown rule key',
      '$.rules[0]().respond: is required',
    ]);
  });

  it('`when` must be an object of matchers', () => {
    expect(problems(rule({ when: [] }))).toEqual([`${P}.when: must be an object of dotted path -> matcher`]);
    expect(problems(rule({ when: 'x' }))).toEqual([`${P}.when: must be an object of dotted path -> matcher`]);
    expect(problems(rule({ when: null }))).toEqual([`${P}.when: must be an object of dotted path -> matcher`]);
  });

  it('matchers: strings, contains, notContains and in are fine; everything else says what is allowed', () => {
    const allowed = 'matcher must be a string (equals), {"contains": string}, {"notContains": string} or {"in": string[]}';
    expect(problems(rule({ when: { a: 5, b: null, c: [], d: {}, e: { other: 'x' }, f: { contains: 'x', notContains: 'y' } } }))).toEqual([
      `${P}.when["a"]: ${allowed}`, `${P}.when["b"]: ${allowed}`, `${P}.when["c"]: ${allowed}`, `${P}.when["d"]: ${allowed}`, `${P}.when["e"]: ${allowed}`, `${P}.when["f"]: ${allowed}`,
    ]);
    expect(problems(rule({ when: { a: { in: 'x' }, b: { in: [1] }, c: { contains: 1 }, d: { notContains: null } } }))).toEqual([
      `${P}.when["a"]: "in" must be an array of strings`,
      `${P}.when["b"]: "in" must be an array of strings`,
      `${P}.when["c"]: "contains" must be a string`,
      `${P}.when["d"]: "notContains" must be a string`,
    ]);
    expect(() => validateFakeRuleFile(rule({ when: { a: '', b: { in: [] }, c: { contains: '' }, 'd.e[0]': { notContains: 'x' } } }))).not.toThrow();
  });
});

describe('fake rule file: respond', () => {
  it('must be an object with exactly one known key', () => {
    const shape = 'respond must be an object with exactly one of: object, text, script, samples, byAttempt';
    for (const respond of ['t', 5, null, [], [{ text: 'x' }]]) expect(problems(rule({ respond }))).toEqual([`${P}.respond: ${shape}`]);
    expect(problems(rule({ respond: {} }))).toEqual([`${P}.respond: respond must have exactly one of object, text, script, samples, byAttempt (found: none)`]);
    expect(problems(rule({ respond: { text: 'a', object: {} } }))).toEqual([`${P}.respond: respond must have exactly one of object, text, script, samples, byAttempt (found: text, object)`]);
    expect(problems(rule({ respond: { wat: 1 } }))).toEqual([`${P}.respond: respond must have exactly one of object, text, script, samples, byAttempt (found: wat)`]);
  });

  it('object and samples must be finite JSON; text must be a string', () => {
    expect(problems(rule({ respond: { object: { n: Number.NaN } } }))).toEqual([`${P}.respond.object: must be JSON`]);
    expect(problems(rule({ respond: { object: { deep: [{ x: Number.POSITIVE_INFINITY }] } } }))).toEqual([`${P}.respond.object: must be JSON`]);
    expect(problems(rule({ respond: { object: { f: () => 1 } } }))).toEqual([`${P}.respond.object: must be JSON`]);
    expect(problems(rule({ respond: { object: undefined } }))).toEqual([`${P}.respond.object: must be JSON`]);
    expect(problems(rule({ respond: { object: { u: undefined } } }))).toEqual([`${P}.respond.object: must be JSON`]);
    expect(problems(rule({ respond: { text: 5 } }))).toEqual([`${P}.respond.text: must be a string`]);
    expect(problems(rule({ respond: { samples: 'x' } }))).toEqual([`${P}.respond.samples: must be a non-empty array`]);
    expect(problems(rule({ respond: { samples: [] } }))).toEqual([`${P}.respond.samples: must be a non-empty array`]);
    expect(problems(rule({ respond: { samples: [{ ok: true }, { bad: Number.NaN }] } }))).toEqual([`${P}.respond.samples: must be JSON`]);
    expect(() => validateFakeRuleFile(rule({ respond: { object: { a: [1, 'two', null, true, { b: {} }] } } }))).not.toThrow();
    expect(() => validateFakeRuleFile(rule({ respond: { object: null } }))).not.toThrow();
    expect(() => validateFakeRuleFile(rule({ respond: { samples: [0, null, 'x'] } }))).not.toThrow();
  });

  it('script must be an array of steps {tool, args?}', () => {
    expect(problems(rule({ respond: { script: 'click' } }))).toEqual([`${P}.respond.script: must be an array`]);
    expect(() => validateFakeRuleFile(rule({ respond: { script: [] } }))).not.toThrow(); // an empty script is a valid "do nothing"
  });

  it('script steps: object shape, tool, unknown keys and args', () => {
    const at = `${P}.respond.script`;
    expect(problems(rule({ respond: { script: ['click', null, 5] } }))).toEqual([
      `${at}[0]: script step must be an object {tool, args?}`, `${at}[1]: script step must be an object {tool, args?}`, `${at}[2]: script step must be an object {tool, args?}`,
    ]);
    expect(problems(rule({ respond: { script: [{}, { tool: '' }, { tool: 3 }, { tool: 'a', wat: 1, also: 2 }] } }))).toEqual([
      `${at}[0].tool: must be a non-empty string`,
      `${at}[1].tool: must be a non-empty string`,
      `${at}[2].tool: must be a non-empty string`,
      `${at}[3].wat: unknown script step key (allowed: tool, args)`,
      `${at}[3].also: unknown script step key (allowed: tool, args)`,
    ]);
    expect(problems(rule({ respond: { script: [{ tool: 'a', args: [] }, { tool: 'b', args: 'x' }, { tool: 'c', args: null }, { tool: 'd', args: { n: Number.NaN } }, { tool: 'e', args: { f: () => 1 } }] } }))).toEqual([
      `${at}[0].args: must be a JSON object`, `${at}[1].args: must be a JSON object`, `${at}[2].args: must be a JSON object`, `${at}[3].args: must be a JSON object`, `${at}[4].args: must be a JSON object`,
    ]);
    expect(() => validateFakeRuleFile(rule({ respond: { script: [{ tool: 'a' }, { tool: 'b', args: {} }, { tool: 'c', args: { text: 'x', n: 1, list: [1] } }] } }))).not.toThrow();
  });

  it('script targets: role is required, name and within are strings, nothing else is allowed', () => {
    const at = `${P}.respond.script[0].args.target`;
    const target = (t: unknown) => rule({ respond: { script: [{ tool: 'click', args: { target: t } }] } });
    for (const t of ['button', 5, null, []]) expect(problems(target(t))).toEqual([`${at}: target must be an object {role, name?, within?}`]);
    expect(problems(target({}))).toEqual([`${at}.role: must be a non-empty string`]);
    expect(problems(target({ role: '' }))).toEqual([`${at}.role: must be a non-empty string`]);
    expect(problems(target({ role: 5, name: 1, within: false }))).toEqual([`${at}.role: must be a non-empty string`, `${at}.name: must be a string`, `${at}.within: must be a string`]);
    expect(problems(target({ role: 'button', nth: 2, text: 'x' }))).toEqual([`${at}.nth: unknown target key (allowed: role, name, within)`, `${at}.text: unknown target key (allowed: role, name, within)`]);
    expect(() => validateFakeRuleFile(target({ role: 'button', name: '', within: '' }))).not.toThrow();
  });

  it('byAttempt must be a non-empty array of responds, nested at most four levels deep', () => {
    expect(problems(rule({ respond: { byAttempt: 'x' } }))).toEqual([`${P}.respond.byAttempt: must be a non-empty array`]);
    expect(problems(rule({ respond: { byAttempt: [] } }))).toEqual([`${P}.respond.byAttempt: must be a non-empty array`]);
    expect(problems(rule({ respond: { byAttempt: [{ text: 'ok' }, { text: 5 }, 'x'] } }))).toEqual([
      `${P}.respond.byAttempt[1].text: must be a string`,
      `${P}.respond.byAttempt[2]: respond must be an object with exactly one of: object, text, script, samples, byAttempt`,
    ]);
    const nest = (levels: number): unknown => (levels === 0 ? { text: 'leaf' } : { byAttempt: [nest(levels - 1)] });
    expect(() => validateFakeRuleFile(rule({ respond: nest(4) }))).not.toThrow(); // four byAttempt levels
    expect(problems(rule({ respond: nest(5) }))).toEqual([`${P}.respond.byAttempt[0].byAttempt[0].byAttempt[0].byAttempt[0].byAttempt: nested too deeply`]);
  });

  it('every problem of a file is reported, in document order', () => {
    expect(problems({
      rules: [
        { id: 'a', purpose: 'act', when: { x: 1 }, respond: { text: 1 } },
        { id: 'b', purpose: 'nope', respond: { script: [{ tool: '' }] } },
      ],
      extra: true,
    }, 'multi.json')).toEqual([
      '$.extra: unknown key (allowed: rules)',
      '$.rules[0](a).when["x"]: matcher must be a string (equals), {"contains": string}, {"notContains": string} or {"in": string[]}',
      '$.rules[0](a).respond.text: must be a string',
      '$.rules[1](b).purpose: must be one of extract, act, checkgen, judge',
      '$.rules[1](b).respond.script[0].tool: must be a non-empty string',
    ]);
  });
});
