// @ts-nocheck
import { describe, expect, it } from 'vitest';
import type { CheckProgram, NodeKey, Predicate } from '../../src/contracts/index.ts';
import { lintCheckProgram } from '../../src/assert/index.ts';

type Ctx = Parameters<typeof lintCheckProgram>[1];

const baseCtx: Ctx = {
  stepText: 'the confirmation shows the prorated charge', params: {}, volatileNodeKeys: [], actionPreceded: true, maxPredicates: 8,
};

const prog = (predicates: Predicate[], classification: CheckProgram['classification'] = 'change'): CheckProgram => ({
  classification, predicates,
  generatedBy: { modelId: 'm', promptVersion: 'checkgen-v1' },
  verified: { afterTrue: true, probeTrue: true, beforeFalse: classification === 'change' ? true : null, judgePassed: false },
});

const ex = (query: Extract<Predicate, { op: 'exists' }>['query']): Predicate => ({ op: 'exists', query });
const heading: Predicate = ex({ role: 'heading', name: 'Plan' });

interface Case { name: string; program: CheckProgram; ctx?: Partial<Ctx>; expect: string[] | 'clean' }

const key = (role: string, name: string): NodeKey => ({ role, name });

const CASES: Case[] = [
  // structure
  { name: 'a valid single predicate is clean', program: prog([heading]), expect: 'clean' },
  { name: 'a valid program with every op is clean', program: prog([
    ex({ role: 'status', name: 'Saved' }),
    { op: 'count', query: { role: 'listitem' }, cmp: 'gte', value: 1 },
    { op: 'text', query: { role: 'heading' }, match: 'contains', value: { literal: 'Plan' } },
    { op: 'state', query: { role: 'checkbox', name: 'Terms' }, state: 'checked', value: true },
    { op: 'route', match: 'prefix', value: '/billing' },
  ]), expect: 'clean' },
  { name: 'an empty predicate list is rejected', program: prog([]), expect: ['no predicates'] },
  { name: 'more predicates than the maximum is rejected', program: prog(Array.from({ length: 9 }, () => heading)), expect: ['9 predicates', 'maximum is 8'] },
  { name: 'exactly the maximum is accepted', program: prog(Array.from({ length: 8 }, () => heading)), expect: 'clean' },
  { name: 'a lower configured maximum is honored', program: prog([heading, heading, heading]), ctx: { maxPredicates: 2 }, expect: ['maximum is 2'] },
  { name: 'a query with neither role nor testId is rejected', program: prog([ex({ name: 'Plan' })]), expect: ['role or a testId'] },
  { name: 'an empty query is rejected', program: prog([ex({})]), expect: ['role or a testId'] },
  { name: 'empty-string role without testId is rejected', program: prog([ex({ role: '', name: 'Plan' })]), expect: ['role or a testId'] },
  { name: 'a testId alone is enough', program: prog([ex({ testId: 'plan-badge' })]), expect: 'clean' },
  { name: 'count with a bare name is rejected', program: prog([{ op: 'count', query: { name: 'x' }, cmp: 'eq', value: 1 }]), expect: ['role or a testId'] },
  { name: 'text with a bare name is rejected', program: prog([{ op: 'text', query: { name: 'x' }, match: 'equals', value: { literal: 'a' } }]), expect: ['role or a testId'] },
  { name: 'state with no role is rejected', program: prog([{ op: 'state', query: {}, state: 'checked', value: true }]), expect: ['role or a testId'] },
  { name: 'a non-route predicate without a query is rejected', program: prog([{ op: 'exists' } as unknown as Predicate]), expect: ['no query'] },
  { name: 'a route predicate needs no query', program: prog([{ op: 'route', match: 'equals', value: '/billing' }]), expect: 'clean' },
  { name: 'only the offending predicate index is reported', program: prog([heading, ex({ name: 'x' })]), expect: ['predicates[1]'] },
  { name: 'a negative count is rejected', program: prog([{ op: 'count', query: { role: 'listitem' }, cmp: 'eq', value: -1 }]), expect: ['non-negative integer'] },
  { name: 'a fractional count is rejected', program: prog([{ op: 'count', query: { role: 'listitem' }, cmp: 'eq', value: 1.5 }]), expect: ['non-negative integer'] },
  { name: 'a vacuous contains on an empty literal is rejected', program: prog([{ op: 'text', query: { role: 'heading' }, match: 'contains', value: { literal: '' } }]), expect: ['vacuous'] },
  { name: 'a vacuous empty route prefix is rejected', program: prog([{ op: 'route', match: 'prefix', value: '' }]), expect: ['vacuous'] },
  { name: 'an unknown classification is rejected', program: { ...prog([heading]), classification: 'maybe' as 'change' }, ctx: { actionPreceded: true }, expect: ['classification'] },
  // action window
  { name: 'change without a preceding action is rejected', program: prog([heading], 'change'), ctx: { actionPreceded: false }, expect: ['invariant'] },
  { name: 'invariant without a preceding action is accepted', program: prog([heading], 'invariant'), ctx: { actionPreceded: false }, expect: 'clean' },
  { name: 'invariant after an action is accepted', program: prog([heading], 'invariant'), expect: 'clean' },
  { name: 'change after an action is accepted', program: prog([heading], 'change'), ctx: { actionPreceded: true }, expect: 'clean' },
  // volatile literals
  { name: 'a time in a text literal is volatile', program: prog([{ op: 'text', query: { role: 'status' }, match: 'contains', value: { literal: 'Saved at 12:30' } }]), expect: ['volatile content', 'time'] },
  { name: 'a time with seconds in a name is volatile', program: prog([ex({ role: 'status', name: 'Updated 09:41:07' })]), expect: ['volatile content', 'query name'] },
  { name: 'an ISO date is volatile', program: prog([{ op: 'text', query: { role: 'status' }, match: 'equals', value: { literal: '2026-10-09' } }]), expect: ['date'] },
  { name: 'a slash date is volatile', program: prog([{ op: 'text', query: { role: 'status' }, match: 'equals', value: { literal: '10/9/26' } }]), expect: ['date'] },
  { name: 'a UUID in a route is volatile', program: prog([{ op: 'route', match: 'equals', value: '/orders/550e8400-e29b-41d4-a716-446655440000' }]), expect: ['uuid'] },
  { name: 'a hex id in a testId is volatile', program: prog([ex({ testId: 'row-3fa85f64' })]), expect: ['hex-id'] },
  { name: 'a long number in a route is volatile', program: prog([{ op: 'route', match: 'equals', value: '/invoices/123456' }]), expect: ['long-number'] },
  { name: 'a relative time is volatile', program: prog([ex({ role: 'status', name: '5 minutes ago' })]), expect: ['relative-time'] },
  { name: 'just now is volatile', program: prog([ex({ role: 'status', name: 'Synced just now' })]), expect: ['relative-time'] },
  { name: 'a volatile within-name is rejected', program: prog([ex({ role: 'button', within: { role: 'region', name: 'Order 123456' } })]), expect: ['within name'] },
  { name: 'a volatile literal that is quoted in the step text is accepted', program: prog([{ op: 'text', query: { role: 'status' }, match: 'contains', value: { literal: '12:30' } }]), ctx: { stepText: 'the status reads 12:30 sharp' }, expect: 'clean' },
  { name: 'step-text quoting is normalized (case, whitespace)', program: prog([{ op: 'text', query: { role: 'status' }, match: 'contains', value: { literal: 'Invoice 123456' } }]), ctx: { stepText: 'the page shows  INVOICE   123456' }, expect: 'clean' },
  { name: 'a volatile literal equal to a param value is accepted', program: prog([{ op: 'text', query: { role: 'status' }, match: 'equals', value: { literal: '2026-10-09' } }]), ctx: { params: { date: '2026-10-09' } }, expect: 'clean' },
  { name: 'a volatile literal not in the params is still rejected', program: prog([{ op: 'text', query: { role: 'status' }, match: 'equals', value: { literal: '2026-10-10' } }]), ctx: { params: { date: '2026-10-09' } }, expect: ['date'] },
  { name: 'a param reference (not a literal) is never volatile', program: prog([{ op: 'text', query: { role: 'status' }, match: 'equals', value: { param: 'date' } }]), ctx: { params: { date: '2026-10-09' } }, expect: 'clean' },
  { name: 'ordinary numbers and words are not volatile', program: prog([ex({ role: 'status', name: 'Invoice 42 of 1,234 is deadbeef' })]), expect: 'clean' },
  { name: 'a pure-letter hex-looking word is not volatile', program: prog([ex({ role: 'status', name: 'facade' }), ex({ role: 'status', name: 'decadedd' })]), expect: 'clean' },
  // volatile node keys
  { name: 'a query matching a volatile node by role and name is rejected', program: prog([ex({ role: 'status', name: 'Last sync' })]), ctx: { volatileNodeKeys: [key('status', 'Last sync')] }, expect: ['changed between'] },
  { name: 'volatile key matching is case-insensitive', program: prog([ex({ role: 'status', name: 'LAST SYNC' })]), ctx: { volatileNodeKeys: [key('status', 'last sync')] }, expect: ['changed between'] },
  { name: 'a contains query matching a volatile name is rejected', program: prog([ex({ role: 'status', name: 'sync', nameMatch: 'contains' })]), ctx: { volatileNodeKeys: [key('status', 'Synced at tick 7')] }, expect: ['changed between'] },
  { name: 'a different role does not match a volatile key', program: prog([ex({ role: 'heading', name: 'Last sync' })]), ctx: { volatileNodeKeys: [key('status', 'Last sync')] }, expect: 'clean' },
  { name: 'a different name does not match a volatile key', program: prog([ex({ role: 'status', name: 'Saved' })]), ctx: { volatileNodeKeys: [key('status', 'Last sync')] }, expect: 'clean' },
  { name: 'a name-less text query on a volatile role is rejected', program: prog([{ op: 'text', query: { role: 'status' }, match: 'contains', value: { literal: 'sync' } }]), ctx: { volatileNodeKeys: [key('status', 'Last sync')] }, expect: ['changed between'] },
  { name: 'a name-less exists query on a volatile role is allowed (presence is stable)', program: prog([ex({ role: 'status' })]), ctx: { volatileNodeKeys: [key('status', 'Last sync')] }, expect: 'clean' },
  { name: 'a testId query is not matched against name keys', program: prog([ex({ testId: 'sync' })]), ctx: { volatileNodeKeys: [key('status', 'Last sync')] }, expect: 'clean' },
  { name: 'with no volatile keys nothing is volatile', program: prog([ex({ role: 'status', name: 'Last sync' })]), expect: 'clean' },
  // multiple findings
  { name: 'multiple problems are all reported', program: prog([ex({ name: '12:30' })]), ctx: { actionPreceded: false }, expect: ['invariant', 'role or a testId', 'volatile content'] },
];

describe('lintCheckProgram table (R-AS2)', () => {
  it('R-AS2: the table has at least 30 cases', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(30);
  });

  it.each(CASES)('R-AS2: $name', ({ program, ctx, expect: want }) => {
    const out = lintCheckProgram(program, { ...baseCtx, ...ctx });
    if (want === 'clean') {
      expect(out).toEqual([]);
    } else {
      expect(out.length).toBeGreaterThan(0);
      for (const w of want) expect(out.join('\n')).toContain(w);
    }
  });
});
