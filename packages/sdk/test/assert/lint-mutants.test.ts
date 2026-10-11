import { describe, expect, it } from 'vitest';
import type { CheckProgram, NodeKey, Predicate } from '../../src/contracts/index.ts';
import { lintCheckProgram, lintDetailed, literalsOf, type LintContext } from '../../src/assert/lint.ts';

/*
 * Exact-value tests for the lint rules: every message, the volatile / vacuous flags of every finding, the truncation boundary of
 * quoted content and the literal inventory (`literalsOf`). lint.test.ts covers the same rules through substring checks.
 */

const baseCtx: LintContext = {
  stepText: 'the confirmation shows the prorated charge', params: {}, volatileNodeKeys: [], actionPreceded: true, maxPredicates: 8,
};

const prog = (predicates: Predicate[], classification: CheckProgram['classification'] = 'change'): CheckProgram => ({
  classification, predicates,
  generatedBy: { modelId: 'm', promptVersion: 'checkgen-v1' },
  verified: { afterTrue: true, probeTrue: true, beforeFalse: classification === 'change' ? true : null, judgePassed: false },
});

const ex = (query: Extract<Predicate, { op: 'exists' }>['query']): Predicate => ({ op: 'exists', query });
const text = (query: Extract<Predicate, { op: 'text' }>['query'], literal: string, match: 'equals' | 'contains' = 'contains'): Predicate => ({ op: 'text', query, match, value: { literal } });
const key = (role: string, name: string): NodeKey => ({ role, name });
const lint = (predicates: Predicate[], ctx: Partial<LintContext> = {}, classification: CheckProgram['classification'] = 'change') =>
  lintDetailed(prog(predicates, classification), { ...baseCtx, ...ctx });
const messages = (predicates: Predicate[], ctx: Partial<LintContext> = {}) => lint(predicates, ctx).map((i) => i.message);

const VOLATILE_TAIL = 'that does not appear in the step text or params; do not assert on values that change between runs';

describe('lintDetailed: structural findings are exact and not flagged volatile or vacuous (R-AS2)', () => {
  it('R-AS2: an empty program', () => {
    expect(lint([])).toStrictEqual([{ message: 'program has no predicates', volatile: false }]);
  });

  it('R-AS2: too many predicates, with the count and the limit', () => {
    const nine = Array.from({ length: 9 }, () => ex({ role: 'heading' }));
    expect(lint(nine)).toStrictEqual([{ message: 'program has 9 predicates; the maximum is 8', volatile: false }]);
    expect(lint(nine, { maxPredicates: 9 })).toStrictEqual([]);
  });

  it('R-AS2: an unknown classification is quoted as JSON', () => {
    expect(lintDetailed({ ...prog([ex({ role: 'heading' })]), classification: 'maybe' as 'change' }, baseCtx)).toStrictEqual([
      { message: 'classification must be "change" or "invariant", got "maybe"', volatile: false },
    ]);
    expect(lintDetailed({ ...prog([ex({ role: 'heading' })]), classification: undefined as unknown as 'change' }, baseCtx)).toStrictEqual([
      { message: 'classification must be "change" or "invariant", got undefined', volatile: false },
    ]);
  });

  it('R-AS2: a "change" with no preceding action', () => {
    expect(lint([ex({ role: 'heading' })], { actionPreceded: false })).toStrictEqual([
      { message: 'no action preceded this check, so the classification must be "invariant", not "change"', volatile: false },
    ]);
    expect(lint([ex({ role: 'heading' })], { actionPreceded: false }, 'invariant')).toStrictEqual([]);
  });

  it('R-AS2: a query with neither role nor testId, by predicate index', () => {
    expect(lint([ex({ role: 'heading' }), ex({ name: 'x' })])).toStrictEqual([
      { message: 'predicates[1]: query must specify a role or a testId', volatile: false },
    ]);
  });

  it('R-AS2: a non-route predicate without a usable query is "no query" and gets no other query finding', () => {
    for (const bad of [undefined, null, 'heading', 0, false, '']) {
      const p = { op: 'exists', query: bad } as unknown as Predicate;
      expect(lint([p]), JSON.stringify(bad) ?? 'undefined').toStrictEqual([{ message: 'predicates[0]: exists predicate has no query', volatile: false }]);
    }
    expect(lint([{ op: 'count', cmp: 'eq', value: 1 } as unknown as Predicate])).toStrictEqual([
      { message: 'predicates[0]: count predicate has no query', volatile: false },
    ]);
  });

  it('R-AS2: a query that is an array is not rejected as "no query"', () => {
    const p = { op: 'exists', query: [] } as unknown as Predicate;
    expect(lint([p]).map((i) => i.message)).toEqual(['predicates[0]: query must specify a role or a testId']);
  });

  it('R-AS2: count values must be non-negative integers; zero is allowed', () => {
    const count = (value: unknown): Predicate => ({ op: 'count', query: { role: 'listitem' }, cmp: 'eq', value: value as number });
    const msg = 'predicates[0]: count value must be a non-negative integer';
    expect(lint([count(-1)])).toStrictEqual([{ message: msg, volatile: false }]);
    expect(lint([count(1.5)])).toStrictEqual([{ message: msg, volatile: false }]);
    expect(lint([count('3')])).toStrictEqual([{ message: msg, volatile: false }]);
    expect(lint([count(undefined)])).toStrictEqual([{ message: msg, volatile: false }]);
    expect(lint([count(Number.NaN)])).toStrictEqual([{ message: msg, volatile: false }]);
    expect(lint([count(0)])).toStrictEqual([]);
    expect(lint([count(1)])).toStrictEqual([]);
    expect(lint([count(7)])).toStrictEqual([]);
  });

  it('R-AS2: the findings of one predicate come in rule order, those of several predicates in index order', () => {
    expect(lint([ex({ name: 'x' }), { op: 'count', query: { name: 'y' }, cmp: 'eq', value: -1 }], { actionPreceded: false })).toStrictEqual([
      { message: 'no action preceded this check, so the classification must be "invariant", not "change"', volatile: false },
      { message: 'predicates[0]: query must specify a role or a testId', volatile: false },
      { message: 'predicates[1]: query must specify a role or a testId', volatile: false },
      { message: 'predicates[1]: count value must be a non-negative integer', volatile: false },
    ]);
  });

  it('R-AS2: lintCheckProgram returns just the messages of lintDetailed', () => {
    const p = prog([ex({ name: 'x' })]);
    expect(lintCheckProgram(p, baseCtx)).toEqual(['predicates[0]: query must specify a role or a testId']);
  });
});

describe('lintDetailed: vacuous predicates (R-AS1)', () => {
  it('R-AS1: a contains match on an empty literal is vacuous and flagged as such, but an equals match is not', () => {
    expect(lint([text({ role: 'heading' }, '')])).toStrictEqual([
      { message: 'predicates[0]: a contains match on an empty literal is vacuous', volatile: false, vacuous: true },
    ]);
    expect(lint([text({ role: 'heading' }, '', 'equals')])).toStrictEqual([]);
    expect(lint([text({ role: 'heading' }, ' ')])).toStrictEqual([]);
  });

  it('R-AS1: a text predicate whose value is a param or missing never trips the empty-literal rule', () => {
    expect(lint([{ op: 'text', query: { role: 'heading' }, match: 'contains', value: { param: 'p' } }])).toStrictEqual([]);
    expect(lint([{ op: 'text', query: { role: 'heading' }, match: 'contains' } as unknown as Predicate])).toStrictEqual([]);
    expect(lint([{ op: 'text', query: { role: 'heading' }, match: 'contains', value: null } as unknown as Predicate])).toStrictEqual([]);
  });

  it('R-AS1: a route prefix of "" or "/" matches every route and is vacuous; other prefixes and the equals match are not', () => {
    expect(lint([{ op: 'route', match: 'prefix', value: '' }])).toStrictEqual([
      { message: 'predicates[0]: a route prefix of "" matches every route, so it is vacuous', volatile: false, vacuous: true },
    ]);
    expect(lint([{ op: 'route', match: 'prefix', value: '/' }])).toStrictEqual([
      { message: 'predicates[0]: a route prefix of "/" matches every route, so it is vacuous', volatile: false, vacuous: true },
    ]);
    expect(lint([{ op: 'route', match: 'prefix', value: '/billing' }])).toStrictEqual([]);
    expect(lint([{ op: 'route', match: 'prefix', value: '//' }])).toStrictEqual([]);
    expect(lint([{ op: 'route', match: 'equals', value: '/' }])).toStrictEqual([]);
    expect(lint([{ op: 'route', match: 'equals', value: '' }])).toStrictEqual([]);
  });

  it('R-AS1: count >= 0 is always true and vacuous; other comparisons of 0 and other bounds are not', () => {
    const count = (cmp: 'eq' | 'gte' | 'lte', value: number): Predicate => ({ op: 'count', query: { role: 'listitem' }, cmp, value });
    expect(lint([count('gte', 0)])).toStrictEqual([
      { message: 'predicates[0]: count >= 0 is always true, so it is vacuous', volatile: false, vacuous: true },
    ]);
    expect(lint([count('gte', 1)])).toStrictEqual([]);
    expect(lint([count('eq', 0)])).toStrictEqual([]);
    expect(lint([count('lte', 0)])).toStrictEqual([]);
  });

  it('R-AS1: vacuous findings carry the predicate index', () => {
    expect(messages([ex({ role: 'heading' }), { op: 'route', match: 'prefix', value: '/' }])).toEqual([
      'predicates[1]: a route prefix of "/" matches every route, so it is vacuous',
    ]);
  });
});

describe('lintDetailed: volatile content messages (R-AS2)', () => {
  it('R-AS2: the message names the predicate, where the literal sits, the literal, the kind and the match; the finding is volatile, not vacuous', () => {
    expect(lint([ex({ role: 'status', name: 'Updated 09:41:07' })])).toStrictEqual([{
      message: `predicates[0]: query name "Updated 09:41:07" contains volatile content (time "09:41:07") ${VOLATILE_TAIL}`,
      volatile: true,
    }]);
  });

  it('R-AS2: names every location a literal can sit in', () => {
    const p = { op: 'text', query: { role: 'status', name: '10:00', testId: 'row-3fa85f64', within: { role: 'region', name: '5 minutes ago' } }, match: 'equals', value: { literal: '2026-10-09' } } as Predicate;
    expect(messages([p])).toEqual([
      `predicates[0]: query name "10:00" contains volatile content (time "10:00") ${VOLATILE_TAIL}`,
      `predicates[0]: query testId "row-3fa85f64" contains volatile content (hex-id "3fa85f64") ${VOLATILE_TAIL}`,
      `predicates[0]: within name "5 minutes ago" contains volatile content (relative-time "5 minutes ago") ${VOLATILE_TAIL}`,
      `predicates[0]: text literal "2026-10-09" contains volatile content (date "2026-10-09") ${VOLATILE_TAIL}`,
    ]);
    expect(messages([{ op: 'route', match: 'equals', value: '/invoices/123456' }])).toEqual([
      `predicates[0]: route value "/invoices/123456" contains volatile content (long-number "123456") ${VOLATILE_TAIL}`,
    ]);
  });

  it('R-AS2: every volatile match in one literal is reported', () => {
    expect(messages([ex({ role: 'status', name: 'from 10:00 to 11:30' })])).toEqual([
      `predicates[0]: query name "from 10:00 to 11:30" contains volatile content (time "10:00") ${VOLATILE_TAIL}`,
      `predicates[0]: query name "from 10:00 to 11:30" contains volatile content (time "11:30") ${VOLATILE_TAIL}`,
    ]);
  });

  it('R-AS2: a volatile match is authored when it appears in the step text or in any param, otherwise not', () => {
    const p = ex({ role: 'status', name: 'Due 10:00' });
    expect(messages([p], { stepText: 'it shows Due 10:00' })).toEqual([]);
    expect(messages([p], { params: { a: 'nothing', b: 'at 10:00 sharp' } })).toEqual([]);
    expect(messages([p], { params: { a: 'nothing', b: 'at 11:00 sharp' }, stepText: 'no time here' })).toHaveLength(1);
  });

  it('R-AS2: quoted content up to 60 characters is shown whole and longer content is cut to 60 characters plus "..."', () => {
    const at = (n: number): string => `${'g'.repeat(n - 6)} 12:30`;
    const shown = (name: string): string => messages([ex({ role: 'status', name })])[0]!;
    expect(at(59)).toHaveLength(59);
    expect(shown(at(59))).toBe(`predicates[0]: query name "${at(59)}" contains volatile content (time "12:30") ${VOLATILE_TAIL}`);
    expect(at(60)).toHaveLength(60);
    expect(shown(at(60))).toBe(`predicates[0]: query name "${at(60)}" contains volatile content (time "12:30") ${VOLATILE_TAIL}`);
    expect(at(61)).toHaveLength(61);
    expect(shown(at(61))).toBe(`predicates[0]: query name "${at(61).slice(0, 60)}..." contains volatile content (time "12:30") ${VOLATILE_TAIL}`);
    expect(shown(at(100))).toBe(`predicates[0]: query name "${at(100).slice(0, 60)}..." contains volatile content (time "12:30") ${VOLATILE_TAIL}`);
  });

  it('R-AS2: the matched text is shortened the same way', () => {
    const digits60 = '7'.repeat(60);
    const digits61 = '7'.repeat(61);
    expect(messages([ex({ role: 'status', name: digits60 })])).toEqual([
      `predicates[0]: query name "${digits60}" contains volatile content (long-number "${digits60}") ${VOLATILE_TAIL}`,
    ]);
    expect(messages([ex({ role: 'status', name: digits61 })])).toEqual([
      `predicates[0]: query name "${'7'.repeat(60)}..." contains volatile content (long-number "${'7'.repeat(60)}...") ${VOLATILE_TAIL}`,
    ]);
  });
});

describe('lintDetailed: volatile node keys (R-AS2)', () => {
  const MSG = (role: string, name: string): string =>
    `predicates[0]: query matches a node whose content changed between the settled observation and the later probe (role "${role}", name "${name}"); do not assert on volatile nodes`;

  it('R-AS2: the finding is exact, volatile and not vacuous', () => {
    expect(lint([ex({ role: 'status', name: 'Last sync' })], { volatileNodeKeys: [key('status', 'Last sync')] })).toStrictEqual([
      { message: MSG('status', 'Last sync'), volatile: true },
    ]);
  });

  it('R-AS2: the role and name of the key are shortened to 60 characters', () => {
    const name60 = 'n'.repeat(60);
    const name61 = 'n'.repeat(61);
    const role61 = 'r'.repeat(61);
    expect(messages([ex({ role: 'status', name: name60 })], { volatileNodeKeys: [key('status', name60)] })).toEqual([MSG('status', name60)]);
    expect(messages([ex({ role: 'status', name: name61 })], { volatileNodeKeys: [key('status', name61)] })).toEqual([MSG('status', `${name60}...`)]);
    expect(messages([ex({ role: role61, name: 'x' })], { volatileNodeKeys: [key(role61, 'x')] })).toEqual([MSG(`${'r'.repeat(60)}...`, 'x')]);
  });

  it('R-AS2: a predicate is reported once however many keys it matches, and only the first matching key is named', () => {
    const keys = [key('status', 'Last sync'), key('status', 'Last sync again')];
    expect(messages([ex({ role: 'status', name: 'last sync', nameMatch: 'contains' })], { volatileNodeKeys: keys })).toEqual([MSG('status', 'Last sync')]);
    expect(messages([ex({ role: 'status', name: 'last sync', nameMatch: 'contains' })], { volatileNodeKeys: [keys[1]!, keys[0]!] })).toEqual([MSG('status', 'Last sync again')]);
  });

  it('R-AS2: each predicate is checked on its own and reported by index', () => {
    const out = lint([ex({ role: 'heading' }), ex({ role: 'status', name: 'Last sync' }), ex({ role: 'status', name: 'Last sync' })], { volatileNodeKeys: [key('status', 'Last sync')] });
    expect(out.map((i) => i.message)).toEqual([
      MSG('status', 'Last sync').replace('predicates[0]', 'predicates[1]'),
      MSG('status', 'Last sync').replace('predicates[0]', 'predicates[2]'),
    ]);
  });

  it('R-AS2: an exact name match needs the whole name to be equal (after whitespace and case folding)', () => {
    const keys = [key('status', 'Synced at tick 7')];
    expect(messages([ex({ role: 'status', name: 'sync' })], { volatileNodeKeys: keys })).toEqual([]);
    expect(messages([ex({ role: 'status', name: 'Synced at tick' })], { volatileNodeKeys: keys })).toEqual([]);
    expect(messages([ex({ role: 'status', name: '  SYNCED   at tick 7 ' })], { volatileNodeKeys: keys })).toEqual([MSG('status', 'Synced at tick 7')]);
  });

  it('R-AS2: a contains match needs the folded query name to occur in the folded key name, not the other way round', () => {
    const keys = [key('status', 'Synced at tick 7')];
    expect(messages([ex({ role: 'status', name: 'AT   tick', nameMatch: 'contains' })], { volatileNodeKeys: keys })).toEqual([MSG('status', 'Synced at tick 7')]);
    expect(messages([ex({ role: 'status', name: 'Synced at tick 7 and more', nameMatch: 'contains' })], { volatileNodeKeys: keys })).toEqual([]);
    expect(messages([ex({ role: 'status', name: 'sync', nameMatch: 'exact' })], { volatileNodeKeys: keys })).toEqual([]);
  });

  it('R-AS2: a name-less query is only matched for a text predicate that names a role', () => {
    const keys = [key('status', 'Last sync')];
    const textOn = (query: Extract<Predicate, { op: 'text' }>['query']): Predicate => text(query, 'sync');
    expect(messages([textOn({ role: 'status' })], { volatileNodeKeys: keys })).toEqual([MSG('status', 'Last sync')]);
    expect(messages([textOn({ role: 'heading' })], { volatileNodeKeys: keys })).toEqual([]);
    expect(messages([ex({ role: 'status' })], { volatileNodeKeys: keys })).toEqual([]);
    expect(messages([{ op: 'count', query: { role: 'status' }, cmp: 'eq', value: 1 }], { volatileNodeKeys: keys })).toEqual([]);
  });

  it('R-AS2: a query carrying a testId is never matched against name keys, whatever else it says', () => {
    const keys = [key('status', 'Last sync')];
    expect(messages([text({ role: 'status', testId: 'sync' }, 'sync')], { volatileNodeKeys: keys })).toEqual([]);
    expect(messages([text({ role: 'status', name: 'Last sync', testId: 'sync' }, 'sync')], { volatileNodeKeys: keys })).toEqual([]);
    expect(messages([ex({ role: 'status', name: 'Last sync', testId: 'sync' })], { volatileNodeKeys: keys })).toEqual([]);
    expect(messages([ex({ role: 'status', name: 'Last sync', testId: '' })], { volatileNodeKeys: keys })).toEqual([MSG('status', 'Last sync')]);
  });

  it('R-AS2: a route predicate is never matched against volatile node keys', () => {
    expect(messages([{ op: 'route', match: 'equals', value: '/billing' }], { volatileNodeKeys: [key('status', 'Last sync')] })).toEqual([]);
  });

  it('R-AS2: a query whose empty role is ignored still matches a key by name', () => {
    expect(messages([ex({ role: '', testId: 'x', name: 'Last sync' })], { volatileNodeKeys: [key('status', 'Last sync')] })).toEqual([]);
    expect(messages([ex({ role: '', name: 'Last sync' })], { volatileNodeKeys: [key('status', 'Last sync')] })).toEqual([
      'predicates[0]: query must specify a role or a testId',
      MSG('status', 'Last sync'),
    ]);
  });
});

describe('literalsOf (R-AS2, R-SE1)', () => {
  it('R-SE1: lists every literal in a predicate with where it sits, in a fixed order', () => {
    const p = {
      op: 'text', query: { role: 'status', name: 'N', testId: 'T', within: { role: 'region', name: 'W' } }, match: 'equals', value: { literal: 'L' },
    } as Predicate;
    expect(literalsOf(p)).toEqual([
      { where: 'query name', text: 'N' },
      { where: 'query testId', text: 'T' },
      { where: 'within name', text: 'W' },
      { where: 'text literal', text: 'L' },
    ]);
  });

  it('R-SE1: a route predicate contributes its value only', () => {
    expect(literalsOf({ op: 'route', match: 'equals', value: '/x' })).toEqual([{ where: 'route value', text: '/x' }]);
    expect(literalsOf({ op: 'route', match: 'equals', value: 5 } as unknown as Predicate)).toEqual([]);
    expect(literalsOf({ op: 'route', match: 'equals' } as unknown as Predicate)).toEqual([]);
    expect(literalsOf({ op: 'route', match: 'equals', value: '/x', query: { name: 'ignored' } } as unknown as Predicate)).toEqual([{ where: 'route value', text: '/x' }]);
  });

  it('R-SE1: only string members count', () => {
    expect(literalsOf(ex({ role: 'status', name: 5 as unknown as string, testId: null as unknown as string }))).toEqual([]);
    expect(literalsOf(ex({ role: 'status', within: { role: 'region' } as unknown as { role: string; name: string } }))).toEqual([]);
    expect(literalsOf(ex({ role: 'status', within: { role: 'region', name: 'W' } }))).toEqual([{ where: 'within name', text: 'W' }]);
    expect(literalsOf(ex({ role: 'status', name: '', testId: '' }))).toEqual([{ where: 'query name', text: '' }, { where: 'query testId', text: '' }]);
  });

  it('R-SE1: a predicate without a query, a text predicate without a value and a param value all have no extra literals', () => {
    expect(literalsOf({ op: 'exists' } as unknown as Predicate)).toEqual([]);
    expect(literalsOf({ op: 'text', query: { role: 'x' }, match: 'equals' } as unknown as Predicate)).toEqual([]);
    expect(literalsOf({ op: 'text', query: { role: 'x' }, match: 'equals', value: null } as unknown as Predicate)).toEqual([]);
    expect(literalsOf({ op: 'text', query: { role: 'x' }, match: 'equals', value: { param: 'p' } })).toEqual([]);
    expect(literalsOf({ op: 'text', query: { role: 'x' }, match: 'equals', value: { literal: 3 } } as unknown as Predicate)).toEqual([]);
  });

  it('R-SE1: only text predicates have a text literal', () => {
    expect(literalsOf({ op: 'state', query: { role: 'x' }, state: 'checked', value: true })).toEqual([]);
    expect(literalsOf({ op: 'exists', query: { role: 'x' }, value: { literal: 'L' } } as unknown as Predicate)).toEqual([]);
  });
});
