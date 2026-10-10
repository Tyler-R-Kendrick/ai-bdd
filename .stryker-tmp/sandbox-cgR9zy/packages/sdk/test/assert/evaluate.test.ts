// @ts-nocheck
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CheckProgram, JsonValue, NodeStates, Predicate } from '../../src/contracts/index.ts';
import { createAsserter, evaluatePredicates } from '../../src/assert/index.ts';
import { CONFIG, fakeRedactor, leaf, makeObs, scriptedModel, type NodeSpec } from './helpers.ts';

const TREE: NodeSpec[] = [
  {
    role: 'document', name: 'Acme', children: [
      { role: 'navigation', name: 'Main', children: [leaf('link', 'Home', { url: '/' }), leaf('link', 'Billing', { url: '/billing' })] },
      {
        role: 'main', name: 'Content', children: [
          leaf('heading', 'Billing'),
          {
            role: 'region', name: 'Plan', children: [
              leaf('heading', 'Current plan'),
              leaf('status', 'Plan badge', { text: 'Pro plan' }),
              leaf('button', 'Upgrade to Pro', { states: { disabled: true } }),
              leaf('button', 'Pay', { testId: 'plan-pay' }),
              { role: 'group', name: 'Deep', children: [{ role: 'group', name: 'Deeper', children: [leaf('button', 'Nested action')] }] },
            ],
          },
          {
            role: 'region', name: 'Invoices', children: [
              { role: 'list', name: 'Invoice list', children: [leaf('listitem', 'Invoice #1 (paid)'), leaf('listitem', 'Invoice #2'), leaf('listitem', 'Invoice #3')] },
              leaf('button', 'Pay', { testId: 'invoice-pay' }),
            ],
          },
          leaf('textbox', 'Email', { value: 'ada@example.com' }),
          leaf('textbox', 'Cafe', { value: 'Café' }),
          leaf('checkbox', 'Accept terms', { states: { checked: true } }),
          leaf('checkbox', 'Newsletter'),
          leaf('checkbox', 'Partial', { states: { checked: 'mixed' } }),
          leaf('checkbox', 'Opted out', { states: { checked: false } }),
          leaf('status', 'Saved'),
          leaf('alert', 'Payment failed'),
          leaf('paragraph', '', { text: 'Thanks   for your order' }),
        ],
      },
    ],
  },
];

const obs = makeObs(TREE, '/billing?tab=plan');

const exists = (query: Extract<Predicate, { op: 'exists' }>['query'], negate?: boolean): Predicate =>
  negate === undefined ? { op: 'exists', query } : { op: 'exists', query, negate };
const count = (query: Extract<Predicate, { op: 'count' }>['query'], cmp: 'eq' | 'gte' | 'lte', value: number): Predicate => ({ op: 'count', query, cmp, value });
const text = (query: Extract<Predicate, { op: 'text' }>['query'], match: 'equals' | 'contains', value: { literal: string } | { param: string }): Predicate => ({ op: 'text', query, match, value });
const state = (query: Extract<Predicate, { op: 'state' }>['query'], st: keyof NodeStates, value: boolean): Predicate => ({ op: 'state', query, state: st, value });
const route = (match: 'equals' | 'prefix', value: string): Predicate => ({ op: 'route', match, value });

interface Case { name: string; p: Predicate; ok: boolean | 'unknown'; actual?: JsonValue; params?: Record<string, string> }

const CASES: Case[] = [
  // exists
  { name: 'exists: role present', p: exists({ role: 'button' }), ok: true, actual: { matches: 4 } },
  { name: 'exists: role absent', p: exists({ role: 'tab' }), ok: false, actual: { matches: 0 } },
  { name: 'exists: exact name', p: exists({ role: 'button', name: 'Upgrade to Pro' }), ok: true, actual: { matches: 1 } },
  { name: 'exists: exact name is case-insensitive', p: exists({ role: 'button', name: 'UPGRADE TO PRO' }), ok: true },
  { name: 'exists: exact name normalizes whitespace', p: exists({ role: 'button', name: '  upgrade   to\tpro ' }), ok: true },
  { name: 'exists: exact name rejects a substring', p: exists({ role: 'button', name: 'Upgrade' }), ok: false },
  { name: 'exists: explicit exact nameMatch', p: exists({ role: 'button', name: 'Pay', nameMatch: 'exact' }), ok: true, actual: { matches: 2 } },
  { name: 'exists: contains name', p: exists({ role: 'button', name: 'upgrade', nameMatch: 'contains' }), ok: true },
  { name: 'exists: contains name no match', p: exists({ role: 'button', name: 'zzz', nameMatch: 'contains' }), ok: false },
  { name: 'exists: contains empty name matches every node of the role', p: exists({ role: 'listitem', name: '', nameMatch: 'contains' }), ok: true, actual: { matches: 3 } },
  { name: 'exists: exact empty name matches the unnamed paragraph', p: exists({ role: 'paragraph', name: '' }), ok: true, actual: { matches: 1 } },
  { name: 'exists: testId', p: exists({ testId: 'plan-pay' }), ok: true, actual: { matches: 1 } },
  { name: 'exists: unknown testId', p: exists({ testId: 'nope' }), ok: false },
  { name: 'exists: role and testId must both match', p: exists({ role: 'link', testId: 'plan-pay' }), ok: false },
  { name: 'exists: role differs in case does not match (roles are exact)', p: exists({ role: 'Button' }), ok: false },
  { name: 'exists: within region Plan', p: exists({ role: 'button', name: 'Pay', within: { role: 'region', name: 'Plan' } }), ok: true, actual: { matches: 1 } },
  { name: 'exists: within is case-insensitive', p: exists({ role: 'button', name: 'Pay', within: { role: 'region', name: 'PLAN' } }), ok: true },
  { name: 'exists: within accepts a distant ancestor', p: exists({ role: 'button', name: 'Nested action', within: { role: 'region', name: 'Plan' } }), ok: true },
  { name: 'exists: within wrong ancestor name', p: exists({ role: 'button', name: 'Upgrade to Pro', within: { role: 'region', name: 'Invoices' } }), ok: false },
  { name: 'exists: within wrong ancestor role', p: exists({ role: 'button', name: 'Upgrade to Pro', within: { role: 'group', name: 'Plan' } }), ok: false },
  { name: 'exists: within a sibling is not an ancestor', p: exists({ role: 'button', name: 'Pay', within: { role: 'list', name: 'Invoice list' } }), ok: false },
  { name: 'exists: a node is not its own ancestor', p: exists({ role: 'region', name: 'Plan', within: { role: 'region', name: 'Plan' } }), ok: false },
  { name: 'exists: negate with no match is satisfied', p: exists({ role: 'tab' }, true), ok: true, actual: { matches: 0 } },
  { name: 'exists: negate with a match is not satisfied', p: exists({ role: 'alert' }, true), ok: false, actual: { matches: 1 } },
  { name: 'exists: negate=false behaves like absent', p: exists({ role: 'alert' }, false), ok: true },
  { name: 'exists: regex metacharacters are literal in names', p: exists({ role: 'listitem', name: '.*', nameMatch: 'contains' }), ok: false },
  { name: 'exists: literal parentheses and hash in names', p: exists({ role: 'listitem', name: 'Invoice #1 (paid)' }), ok: true },
  { name: 'exists: a dot does not act as wildcard', p: exists({ role: 'listitem', name: 'Invoice #.' }), ok: false },
  // count
  { name: 'count: eq 3 list items', p: count({ role: 'listitem' }, 'eq', 3), ok: true, actual: { matches: 3 } },
  { name: 'count: eq mismatch', p: count({ role: 'listitem' }, 'eq', 2), ok: false, actual: { matches: 3 } },
  { name: 'count: eq 0 on absent role', p: count({ role: 'tab' }, 'eq', 0), ok: true },
  { name: 'count: gte boundary', p: count({ role: 'listitem' }, 'gte', 3), ok: true },
  { name: 'count: gte exceeded', p: count({ role: 'listitem' }, 'gte', 4), ok: false },
  { name: 'count: lte boundary', p: count({ role: 'listitem' }, 'lte', 3), ok: true },
  { name: 'count: lte exceeded', p: count({ role: 'listitem' }, 'lte', 2), ok: false },
  { name: 'count: within scope', p: count({ role: 'button', within: { role: 'region', name: 'Invoices' } }, 'eq', 1), ok: true },
  { name: 'count: name contains', p: count({ role: 'listitem', name: 'invoice #', nameMatch: 'contains' }, 'eq', 3), ok: true },
  { name: 'count: unsupported comparator is unknown', p: { op: 'count', query: { role: 'listitem' }, cmp: 'ne' as 'eq', value: 3 }, ok: 'unknown', actual: { matches: 3 } },
  { name: 'count: non-numeric value is false', p: { op: 'count', query: { role: 'listitem' }, cmp: 'eq', value: '3' as unknown as number }, ok: false },
  // text
  { name: 'text: equals on name when no text field', p: text({ role: 'heading', name: 'Billing' }, 'equals', { literal: 'billing' }), ok: true, actual: { matches: 1, text: 'Billing' } },
  { name: 'text: equals prefers text over name', p: text({ role: 'status', name: 'Plan badge' }, 'equals', { literal: 'Pro plan' }), ok: true },
  { name: 'text: equals does not fall back to name when text exists', p: text({ role: 'status', name: 'Plan badge' }, 'equals', { literal: 'Plan badge' }), ok: false },
  { name: 'text: contains', p: text({ role: 'status', name: 'Plan badge' }, 'contains', { literal: 'PRO' }), ok: true },
  { name: 'text: contains miss', p: text({ role: 'status', name: 'Plan badge' }, 'contains', { literal: 'free' }), ok: false },
  { name: 'text: whitespace in the node text is normalized', p: text({ role: 'paragraph' }, 'equals', { literal: 'thanks for your order' }), ok: true },
  { name: 'text: whitespace in the literal is normalized', p: text({ role: 'paragraph' }, 'equals', { literal: '  Thanks  for   your order ' }), ok: true },
  { name: 'text: zero matches', p: text({ role: 'tab' }, 'equals', { literal: 'x' }), ok: false, actual: { matches: 0 } },
  { name: 'text: two matches are ambiguous', p: text({ role: 'button', name: 'Pay' }, 'equals', { literal: 'Pay' }), ok: false, actual: { matches: 2 } },
  { name: 'text: value equals', p: text({ role: 'textbox', name: 'Email' }, 'equals', { literal: 'ADA@example.com' }), ok: true, actual: { matches: 1, text: 'Email', value: 'ada@example.com' } },
  { name: 'text: value contains', p: text({ role: 'textbox', name: 'Email' }, 'contains', { literal: '@example' }), ok: true },
  { name: 'text: name also satisfies when a value exists', p: text({ role: 'textbox', name: 'Email' }, 'equals', { literal: 'email' }), ok: true },
  { name: 'text: value mismatch', p: text({ role: 'textbox', name: 'Email' }, 'equals', { literal: 'bob@example.com' }), ok: false },
  { name: 'text: param literal resolved', p: text({ role: 'textbox', name: 'Email' }, 'equals', { param: 'email' }), ok: true, params: { email: 'ada@example.com' } },
  { name: 'text: param resolved but different', p: text({ role: 'textbox', name: 'Email' }, 'equals', { param: 'email' }), ok: false, params: { email: 'x@y.z' } },
  { name: 'text: missing param is unsatisfied', p: text({ role: 'textbox', name: 'Email' }, 'equals', { param: 'email' }), ok: false, actual: { matches: 1, missingParam: 'email' } },
  { name: 'text: prototype-named param is missing', p: text({ role: 'textbox', name: 'Email' }, 'contains', { param: 'constructor' }), ok: false, actual: { matches: 1, missingParam: 'constructor' } },
  { name: 'text: empty param value equals only empty text', p: text({ role: 'textbox', name: 'Email' }, 'equals', { param: 'e' }), ok: false, params: { e: '' } },
  { name: 'text: NFC normalization of composed and decomposed forms', p: text({ role: 'textbox', name: 'Cafe' }, 'equals', { literal: 'Café' }), ok: true },
  { name: 'text: malformed value (neither literal nor param) is unknown', p: { op: 'text', query: { role: 'heading', name: 'Billing' }, match: 'equals', value: {} as { literal: string } }, ok: 'unknown' },
  { name: 'text: invalid match mode is unknown', p: { op: 'text', query: { role: 'heading', name: 'Billing' }, match: 'regex' as 'equals', value: { literal: 'a' } }, ok: 'unknown' },
  // state
  { name: 'state: checked true', p: state({ role: 'checkbox', name: 'Accept terms' }, 'checked', true), ok: true, actual: { matches: 1, state: true } },
  { name: 'state: checked expected false but true', p: state({ role: 'checkbox', name: 'Accept terms' }, 'checked', false), ok: false },
  { name: 'state: undefined counts as false (expect false)', p: state({ role: 'checkbox', name: 'Newsletter' }, 'checked', false), ok: true, actual: { matches: 1, state: false } },
  { name: 'state: undefined counts as false (expect true)', p: state({ role: 'checkbox', name: 'Newsletter' }, 'checked', true), ok: false },
  { name: 'state: explicit false', p: state({ role: 'checkbox', name: 'Opted out' }, 'checked', false), ok: true },
  { name: 'state: mixed is not true', p: state({ role: 'checkbox', name: 'Partial' }, 'checked', true), ok: false, actual: { matches: 1, state: 'mixed' } },
  { name: 'state: mixed is not false', p: state({ role: 'checkbox', name: 'Partial' }, 'checked', false), ok: false },
  { name: 'state: disabled button', p: state({ role: 'button', name: 'Upgrade to Pro' }, 'disabled', true), ok: true },
  { name: 'state: enabled button has undefined disabled', p: state({ role: 'button', name: 'Nested action' }, 'disabled', false), ok: true },
  { name: 'state: two matches', p: state({ role: 'button', name: 'Pay' }, 'disabled', false), ok: false, actual: { matches: 2 } },
  { name: 'state: zero matches', p: state({ role: 'tab' }, 'selected', true), ok: false, actual: { matches: 0 } },
  { name: 'state: within disambiguates', p: state({ role: 'button', name: 'Pay', within: { role: 'region', name: 'Plan' } }, 'disabled', false), ok: true },
  { name: 'state: prototype-named state key is treated as unset', p: state({ role: 'checkbox', name: 'Newsletter' }, 'constructor' as 'checked', false), ok: true },
  // route
  { name: 'route: equals exact', p: route('equals', '/billing?tab=plan'), ok: true, actual: { route: '/billing?tab=plan' } },
  { name: 'route: equals differs by query', p: route('equals', '/billing'), ok: false },
  { name: 'route: prefix', p: route('prefix', '/billing'), ok: true },
  { name: 'route: prefix miss', p: route('prefix', '/settings'), ok: false },
  { name: 'route: prefix of empty string', p: route('prefix', ''), ok: true },
  { name: 'route: comparison is case-sensitive', p: route('equals', '/Billing?tab=plan'), ok: false },
  { name: 'route: unknown match mode is unknown', p: { op: 'route', match: 'regex' as 'equals', value: '.*' }, ok: 'unknown' },
  // malformed predicates never throw
  { name: 'malformed: unknown op is unknown', p: { op: 'nope' } as unknown as Predicate, ok: 'unknown' },
  { name: 'malformed: missing query is unknown (no throw)', p: { op: 'exists' } as unknown as Predicate, ok: 'unknown' },
];

describe('evaluatePredicates truth table (R-AS3)', () => {
  it('R-AS3: the table has at least 60 cases', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(60);
  });

  it.each(CASES)('R-AS3: $name', ({ p, ok, actual, params }) => {
    const [r] = evaluatePredicates([p], obs, params ?? {});
    expect(r?.satisfied).toBe(ok);
    if (actual !== undefined) expect(r?.actual).toMatchObject(actual as object);
    expect(r?.predicate).toBe(p);
  });
});

describe('evaluatePredicates structure (R-AS3)', () => {
  it('R-AS3: returns one result per predicate in order', () => {
    const preds = [exists({ role: 'alert' }), exists({ role: 'tab' }), route('prefix', '/b')];
    expect(evaluatePredicates(preds, obs, {}).map((r) => r.satisfied)).toEqual([true, false, true]);
  });

  it('R-AS3: empty predicate list yields no results', () => {
    expect(evaluatePredicates([], obs, {})).toEqual([]);
  });

  it('R-AS3: nodes without parentRef use depth to find ancestors', () => {
    const flat = makeObs(TREE).nodes.map((n) => {
      const { parentRef: _p, ...rest } = n;
      return rest;
    });
    const o = makeObs(flat);
    const [r] = evaluatePredicates([exists({ role: 'button', name: 'Nested action', within: { role: 'region', name: 'Plan' } })], o, {});
    expect(r?.satisfied).toBe(true);
  });

  it('R-AS3: a cyclic parentRef graph terminates', () => {
    const nodes = makeObs([leaf('group', 'A'), leaf('group', 'B'), leaf('button', 'X')]).nodes.map((n, i) => ({
      ...n, parentRef: ['e2', 'e1', 'e1'][i] as string,
    }));
    const [r] = evaluatePredicates([exists({ role: 'button', within: { role: 'group', name: 'Nope' } })], makeObs(nodes), {});
    expect(r?.satisfied).toBe(false);
  });

  it('R-AS3: a self-referencing parentRef is not its own ancestor', () => {
    const nodes = makeObs([leaf('group', 'A')]).nodes.map((n) => ({ ...n, parentRef: n.ref }));
    const [r] = evaluatePredicates([exists({ role: 'group', within: { role: 'group', name: 'A' } })], makeObs(nodes), {});
    expect(r?.satisfied).toBe(false);
  });

  it('R-AS3: the evaluator contains no regular expressions', () => {
    const src = readFileSync(new URL('../../src/assert/evaluate.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/RegExp/);
    expect(src).not.toMatch(/\.(match|matchAll|test|search|replace|replaceAll)\(/);
    expect(src).not.toMatch(/= \/[^/*\s]/);
  });
});

describe('asserter.evaluate program verdicts (R-AS3)', () => {
  const asserter = createAsserter({ model: scriptedModel([{}]), redactor: fakeRedactor({ pw: 'hunter2-secret' }), config: CONFIG });
  const program = (predicates: Predicate[]): CheckProgram => ({
    classification: 'change', predicates,
    generatedBy: { modelId: 'm', promptVersion: 'checkgen-v1' },
    verified: { afterTrue: true, probeTrue: true, beforeFalse: true, judgePassed: true },
  });

  it('R-AS3: passes only if every predicate is satisfied', () => {
    expect(asserter.evaluate(program([exists({ role: 'alert' }), route('prefix', '/billing')]), obs, {}).passed).toBe(true);
    expect(asserter.evaluate(program([exists({ role: 'alert' }), exists({ role: 'tab' })]), obs, {}).passed).toBe(false);
  });

  it('R-AS3: an unknown result counts as failure', () => {
    const ev = asserter.evaluate(program([exists({ role: 'alert' }), route('equals', '/x'), { op: 'nope' } as unknown as Predicate]), obs, {});
    expect(ev.passed).toBe(false);
    expect(ev.results.map((r) => r.satisfied)).toEqual([true, false, 'unknown']);
  });

  it('R-AS3: an empty program never passes vacuously', () => {
    expect(asserter.evaluate(program([]), obs, {}).passed).toBe(false);
  });

  it('R-AS3: actuals are redacted', () => {
    const o = makeObs([leaf('textbox', 'Token', { value: 'hunter2-secret' })]);
    const ev = asserter.evaluate(program([text({ role: 'textbox', name: 'Token' }, 'equals', { literal: 'x' })]), o, {});
    expect(JSON.stringify(ev.results)).not.toContain('hunter2-secret');
    expect(JSON.stringify(ev.results)).toContain('[REDACTED:pw]');
  });
});
