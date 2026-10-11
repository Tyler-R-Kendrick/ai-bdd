import { describe, expect, it } from 'vitest';
import type { JsonValue, ObservedNode, Predicate } from '../../src/contracts/index.ts';
import { evaluatePredicates } from '../../src/assert/index.ts';
import { leaf, makeObs, type NodeSpec } from './helpers.ts';

type Query = Extract<Predicate, { op: 'exists' }>['query'];

const exists = (query: Query, negate?: boolean): Predicate =>
  negate === undefined ? { op: 'exists', query } : { op: 'exists', query, negate };
const count = (query: Query, cmp: 'eq' | 'gte' | 'lte', value: number): Predicate => ({ op: 'count', query, cmp, value });
const textEq = (query: Query, literal: string): Predicate => ({ op: 'text', query, match: 'equals', value: { literal } });
const run = (p: Predicate, specs: NodeSpec[], params: Record<string, string> = {}, route = '/') =>
  evaluatePredicates([p], makeObs(specs, route), params)[0];

/** A node list without parentRef: parents are derived from depth alone. */
function flatNodes(rows: readonly [role: string, name: string, depth: number][]): ObservedNode[] {
  return rows.map(([role, name, depth], i) => ({ ref: `e${i + 1}`, role, name, states: {}, depth }));
}

describe('evaluator folding and clipping (R-AS3)', () => {
  it('R-AS3: names are folded to lower case, not upper case', () => {
    // "ß" upper-cases to "SS" but lower-cases to itself, so only lower-case folding keeps these two names apart.
    const specs = [leaf('button', 'ß'), leaf('button', 'ss')];
    expect(run(exists({ role: 'button', name: 'SS' }), specs)?.actual).toEqual({ matches: 1 });
    expect(run(exists({ role: 'button', name: 'ß' }), specs)?.actual).toEqual({ matches: 1 });
    expect(run(exists({ role: 'button', name: 'ss' }, true), [leaf('button', 'ß')])?.satisfied).toBe(true);
  });

  it('R-AS3: expected text is folded to lower case, not upper case', () => {
    expect(run(textEq({ role: 'heading' }, 'ss'), [leaf('heading', 'ß')])?.satisfied).toBe(false);
    expect(run(textEq({ role: 'heading' }, 'ß'), [leaf('heading', 'ß')])?.satisfied).toBe(true);
  });

  it.each([
    [0, 0], [1, 1], [299, 299], [300, 300], [301, 303], [302, 303], [1000, 303],
  ])('R-AS3: node text of %i characters is reported with %i characters', (length, reported) => {
    const long = 'a'.repeat(length);
    const r = run(textEq({ role: 'heading' }, 'x'), [leaf('heading', long)]);
    const expected = length > 300 ? `${'a'.repeat(300)}...` : long;
    expect(r?.actual).toEqual({ matches: 1, text: expected });
    const actual = r?.actual as { text: string };
    expect(actual.text.length).toBe(reported);
  });

  it('R-AS3: a value is clipped like a text', () => {
    const at = 'v'.repeat(300);
    const over = 'v'.repeat(301);
    expect(run(textEq({ role: 'textbox' }, 'x'), [leaf('textbox', 'T', { value: at })])?.actual).toEqual({ matches: 1, text: 'T', value: at });
    expect(run(textEq({ role: 'textbox' }, 'x'), [leaf('textbox', 'T', { value: over })])?.actual).toEqual({
      matches: 1, text: 'T', value: `${'v'.repeat(300)}...`,
    });
  });

  it('R-AS3: a route is clipped like a text', () => {
    const at = `/${'r'.repeat(299)}`;
    const over = `/${'r'.repeat(300)}`;
    expect(run({ op: 'route', match: 'equals', value: 'x' }, [leaf('a', 'a')], {}, at)?.actual).toEqual({ route: at });
    expect(run({ op: 'route', match: 'equals', value: 'x' }, [leaf('a', 'a')], {}, over)?.actual).toEqual({ route: `${over.slice(0, 300)}...` });
  });

  it('R-AS3: a missing parameter name is clipped like a text', () => {
    const name = 'p'.repeat(301);
    const r = run({ op: 'text', query: { role: 'heading' }, match: 'equals', value: { param: name } }, [leaf('heading', 'H')]);
    expect(r?.actual).toEqual({ matches: 1, missingParam: `${'p'.repeat(300)}...` });
  });
});

describe('evaluator error reporting (R-AS3)', () => {
  const specs = [leaf('heading', 'Billing')];

  it('R-AS3: a text predicate without literal and param reports why it is unknown', () => {
    const p = { op: 'text', query: { role: 'heading' }, match: 'equals', value: {} } as unknown as Predicate;
    expect(run(p, specs)).toEqual({ predicate: p, satisfied: 'unknown', actual: { error: 'text value has neither literal nor param' } });
  });

  it('R-AS3: an unsupported operator reports why it is unknown', () => {
    const p = { op: 'nope' } as unknown as Predicate;
    expect(run(p, specs)).toEqual({ predicate: p, satisfied: 'unknown', actual: { error: 'unsupported predicate' } });
  });

  it('R-AS3: a predicate that throws reports the error message', () => {
    const p = { op: 'exists', get query(): Query { throw new Error('boom'); } } as unknown as Predicate;
    const r = run(p, specs);
    expect(r?.satisfied).toBe('unknown');
    expect(r?.actual).toEqual({ error: 'boom' });
    expect(r?.predicate).toBe(p);
  });

  it('R-AS3: a thrown non-error is reported as its string form', () => {
    const p = { op: 'exists', get query(): Query { throw 'plain failure'; } } as unknown as Predicate;
    expect(run(p, specs)?.actual).toEqual({ error: 'plain failure' });
  });

  it('R-AS3: a long error message is clipped', () => {
    const p = { op: 'exists', get query(): Query { throw new Error('e'.repeat(305)); } } as unknown as Predicate;
    expect(run(p, specs)?.actual).toEqual({ error: `${'e'.repeat(300)}...` });
  });

  it('R-AS3: a malformed query is reported with the engine message and does not stop the other predicates', () => {
    const bad = { op: 'exists' } as unknown as Predicate;
    const good = exists({ role: 'heading' });
    const results = evaluatePredicates([bad, good], makeObs(specs), {});
    expect(results.map((r) => r.satisfied)).toEqual(['unknown', true]);
    const failure = results[0]?.actual as { error: unknown };
    expect(typeof failure.error).toBe('string');
    expect(results[1]?.actual).toEqual({ matches: 1 });
  });
});

describe('evaluator count predicates with non-numeric values (R-AS3)', () => {
  const specs = [leaf('listitem', 'a'), leaf('listitem', 'b'), leaf('listitem', 'c')];
  const withValue = (cmp: string, value: unknown): Predicate =>
    ({ op: 'count', query: { role: 'listitem' }, cmp, value }) as unknown as Predicate;

  it.each(['eq', 'gte', 'lte', 'ne', 'lt'])('R-AS3: a string value with cmp %s is false, not coerced', (cmp) => {
    expect(run(withValue(cmp, '3'), specs)).toMatchObject({ satisfied: false, actual: { matches: 3 } });
    expect(run(withValue(cmp, '2'), specs)).toMatchObject({ satisfied: false, actual: { matches: 3 } });
    expect(run(withValue(cmp, '4'), specs)).toMatchObject({ satisfied: false, actual: { matches: 3 } });
  });

  it('R-AS3: null and boolean values are false', () => {
    expect(run(withValue('gte', null), specs)?.satisfied).toBe(false);
    expect(run(withValue('lte', true), specs)?.satisfied).toBe(false);
  });

  it('R-AS3: an unknown comparator with a numeric value is unknown', () => {
    expect(run(withValue('ne', 3), specs)).toMatchObject({ satisfied: 'unknown', actual: { matches: 3 } });
  });
});

describe('evaluator parameters (R-AS3)', () => {
  const p: Predicate = { op: 'text', query: { role: 'textbox', name: 'Email' }, match: 'equals', value: { param: 'email' } };
  const specs = [leaf('textbox', 'Email', { value: 'ada@example.com' })];

  it('R-AS3: an own parameter that is not a string is missing', () => {
    for (const bad of [5, undefined, null, true, {}]) {
      const r = run(p, specs, { email: bad as unknown as string });
      expect(r?.satisfied).toBe(false);
      expect(r?.actual).toEqual({ matches: 1, missingParam: 'email' });
    }
  });

  it('R-AS3: an inherited string parameter is missing', () => {
    const params = Object.create({ email: 'ada@example.com' }) as Record<string, string>;
    const r = run(p, specs, params);
    expect(r?.satisfied).toBe(false);
    expect(r?.actual).toEqual({ matches: 1, missingParam: 'email' });
  });

  it('R-AS3: an own string parameter is used', () => {
    const r = run(p, specs, { email: 'ada@example.com' });
    expect(r?.satisfied).toBe(true);
    expect(r?.actual).toEqual({ matches: 1, text: 'Email', value: 'ada@example.com' });
  });
});

describe('evaluator within queries (R-AS3)', () => {
  it('R-AS3: a null or undefined within does not restrict the match', () => {
    const specs = [leaf('button', 'A'), { role: 'group', name: 'G', children: [leaf('button', 'B')] }];
    const q = (within: unknown): Query => ({ role: 'button', within }) as unknown as Query;
    expect(run(exists(q(null)), specs)?.actual).toEqual({ matches: 2 });
    expect(run(exists(q(undefined)), specs)?.actual).toEqual({ matches: 2 });
    expect(run(exists(q({ role: 'group', name: 'G' })), specs)?.actual).toEqual({ matches: 1 });
  });

  it('R-AS3: the first node of the observation can be an ancestor (parentRef)', () => {
    const specs: NodeSpec[] = [{ role: 'group', name: 'Root', children: [leaf('button', 'Child'), { role: 'group', name: 'Inner', children: [leaf('button', 'Deep')] }] }];
    const r = run(count({ role: 'button', within: { role: 'group', name: 'Root' } }, 'eq', 2), specs);
    expect(r?.satisfied).toBe(true);
    expect(r?.actual).toEqual({ matches: 2 });
    expect(run(exists({ role: 'group', name: 'Inner', within: { role: 'group', name: 'Root' } }), specs)?.actual).toEqual({ matches: 1 });
  });

  it('R-AS3: the first node of the observation can be an ancestor (depth only)', () => {
    const nodes = flatNodes([['group', 'Root', 0], ['button', 'Child', 1], ['group', 'Inner', 1], ['button', 'Deep', 2]]);
    const [r] = evaluatePredicates([count({ role: 'button', within: { role: 'group', name: 'Root' } }, 'eq', 2)], makeObs(nodes), {});
    expect(r?.actual).toEqual({ matches: 2 });
  });

  it('R-AS3: ancestors are told apart by their key within one evaluation', () => {
    const specs: NodeSpec[] = [
      { role: 'region', name: 'Plan', children: [leaf('button', 'Upgrade'), leaf('button', 'Cancel'), leaf('button', 'Pause')] },
      { role: 'region', name: 'Invoices', children: [leaf('button', 'Pay')] },
      { role: 'dialog', name: 'Plan', children: [leaf('button', 'Close'), leaf('button', 'Dismiss')] },
    ];
    const results = evaluatePredicates([
      exists({ role: 'button', within: { role: 'region', name: 'Plan' } }),
      exists({ role: 'button', within: { role: 'region', name: 'Invoices' } }),
      exists({ role: 'button', within: { role: 'dialog', name: 'Plan' } }),
      exists({ role: 'button', within: { role: 'region', name: 'Plan' } }),
      exists({ role: 'button', within: { role: 'region', name: 'Nowhere' } }),
    ], makeObs(specs), {});
    expect(results.map((r) => r.actual)).toEqual([{ matches: 3 }, { matches: 1 }, { matches: 2 }, { matches: 3 }, { matches: 0 }]);
  });
});

describe('evaluator parents derived from depth (R-AS3)', () => {
  // A(0) > B(1), C(1) > D(2); E(0) > F(1)
  const nodes = flatNodes([
    ['group', 'A', 0], ['group', 'B', 1], ['button', 'C', 1], ['button', 'D', 2], ['group', 'E', 0], ['button', 'F', 1],
  ]);
  const matches = (within: string): unknown => evaluatePredicates([exists({ role: 'button', within: { role: 'group', name: within } })], makeObs(nodes), {})[0]?.actual;

  it('R-AS3: a sibling at the same depth is not a parent', () => {
    expect(matches('B')).toEqual({ matches: 0 });
  });

  it('R-AS3: a deeper node reaches its shallower ancestors', () => {
    expect(matches('A')).toEqual({ matches: 2 });
    expect(matches('E')).toEqual({ matches: 1 });
  });

  it('R-AS3: a later top-level node does not hang below an earlier one', () => {
    expect(evaluatePredicates([exists({ role: 'group', name: 'E', within: { role: 'group', name: 'A' } })], makeObs(nodes), {})[0]?.actual).toEqual({ matches: 0 });
  });

  it('R-AS3: the first top-level node has no ancestor, not even itself', () => {
    expect(evaluatePredicates([exists({ role: 'group', name: 'A', within: { role: 'group', name: 'A' } })], makeObs(nodes), {})[0]?.actual).toEqual({ matches: 0 });
  });

  it('R-AS3: with parentRef absent a top-level node is not inside the previous top-level node', () => {
    const tops = flatNodes([['group', 'X', 0], ['group', 'Y', 0], ['group', 'Z', 0]]);
    const within = (name: string): unknown =>
      evaluatePredicates([count({ role: 'group', within: { role: 'group', name } }, 'eq', 0)], makeObs(tops), {})[0];
    for (const name of ['X', 'Y', 'Z']) expect(within(name)).toMatchObject({ satisfied: true, actual: { matches: 0 } });
  });
});

describe('evaluator ancestor resolution order (R-AS3)', () => {
  /** Nodes listed child-first: node i hangs below node i+1 (parentRef), the last node is the root. */
  function reversedChain(n: number, rootRole: string): ObservedNode[] {
    return Array.from({ length: n }, (_, i): ObservedNode => ({
      ref: `e${i + 1}`, role: i === n - 1 ? rootRole : 'item', name: i === n - 1 ? 'K' : `n${i}`, states: {}, depth: n - 1 - i,
      ...(i === n - 1 ? {} : { parentRef: `e${i + 2}` }),
    }));
  }

  it('R-AS3: a node listed before its ancestors still finds a distant ancestor', () => {
    const nodes = reversedChain(5, 'group');
    const [r] = evaluatePredicates([count({ role: 'item', within: { role: 'group', name: 'K' } }, 'eq', 4)], makeObs(nodes), {});
    expect(r).toMatchObject({ satisfied: true, actual: { matches: 4 } });
  });

  it('R-AS3: every node of a child-first chain below the key is within it', () => {
    const nodes = reversedChain(6, 'group');
    const [r] = evaluatePredicates([exists({ within: { role: 'group', name: 'K' } })], makeObs(nodes), {});
    // the root itself has no ancestor; the other five all do
    expect(r?.actual).toEqual({ matches: 5 });
  });

  it('R-AS3: a child-first chain with no matching key has no node within it', () => {
    const nodes = reversedChain(6, 'region');
    const [r] = evaluatePredicates([exists({ within: { role: 'group', name: 'K' } })], makeObs(nodes), {});
    expect(r?.actual).toEqual({ matches: 0 });
  });

  it('R-AS3: a key in the middle of a child-first chain covers only the nodes below it', () => {
    // e1 > e2 > e3 (key) > e4 > e5 (root); e1 and e2 are within the key, e3 itself and e4, e5 are not
    const nodes = reversedChain(5, 'region');
    nodes[2] = { ...(nodes[2] as ObservedNode), role: 'group', name: 'K' };
    const [r] = evaluatePredicates([count({ within: { role: 'group', name: 'K' } }, 'eq', 2)], makeObs(nodes), {});
    expect(r).toMatchObject({ satisfied: true, actual: { matches: 2 } });
  });
});

describe('evaluator memoization (R-AS3)', () => {
  /** Nodes that count how often their role / name are read. */
  const N = 40;
  const key = { role: 'group', name: 'K' };

  function build(shape: (i: number) => { parentRef?: string; role: string; name: string }) {
    const roleReads: number[] = new Array<number>(N).fill(0);
    const nameReads: number[] = new Array<number>(N).fill(0);
    const nodes = Array.from({ length: N }, (_, i): ObservedNode => {
      const s = shape(i);
      const node = { ref: `e${i + 1}`, states: {}, depth: 0 } as Record<string, unknown>;
      if (s.parentRef !== undefined) node['parentRef'] = s.parentRef;
      Object.defineProperty(node, 'role', { enumerable: true, get() { roleReads[i] = (roleReads[i] as number) + 1; return s.role; } });
      Object.defineProperty(node, 'name', { enumerable: true, get() { nameReads[i] = (nameReads[i] as number) + 1; return s.name; } });
      return node as unknown as ObservedNode;
    });
    const obs = makeObs(nodes);
    roleReads.fill(0);
    nameReads.fill(0);
    return { obs, roleReads, nameReads };
  }

  /** Node i hangs below node i-1; node 0 is the root. */
  const forwardChain = (rootRole: string) => (i: number) => ({
    role: i === 0 ? rootRole : 'item', name: i === 0 ? 'K' : `n${i}`, ...(i === 0 ? {} : { parentRef: `e${i}` }),
  });
  /** Node i hangs below node i+1; the last node is the root. */
  const reversedChain = (rootRole: string) => (i: number) => ({
    role: i === N - 1 ? rootRole : 'item', name: i === N - 1 ? 'K' : `n${i}`, ...(i === N - 1 ? {} : { parentRef: `e${i + 2}` }),
  });

  it('R-AS3: the folded name of a node is computed once however many predicates read it', () => {
    const { obs, nameReads } = build(forwardChain('group'));
    const predicates = [exists({ name: 'n1' }), exists({ name: 'n2' }), count({ name: 'n', nameMatch: 'contains' }, 'gte', 1)];
    const results = evaluatePredicates(predicates, obs, {});
    expect(results.map((r) => r.actual)).toEqual([{ matches: 1 }, { matches: 1 }, { matches: N - 1 }]);
    expect(nameReads).toEqual(new Array<number>(N).fill(1));
  });

  it.each([
    ['a chain whose key is the root', forwardChain('group'), N - 1],
    ['a chain without the key', forwardChain('region'), 0],
    ['a child-first chain whose key is the root', reversedChain('group'), N - 1],
    ['a child-first chain without the key', reversedChain('region'), 0],
  ])('R-AS3: ancestor lookup reads each node role at most once for %s', (_label, shape, expected) => {
    const { obs, roleReads } = build(shape);
    const [r] = evaluatePredicates([exists({ within: key })], obs, {});
    expect(r?.actual).toEqual({ matches: expected });
    expect(Math.max(...roleReads)).toBeLessThanOrEqual(1);
  });

  it('R-AS3: a repeated within key is resolved once per evaluation', () => {
    const { obs, roleReads } = build(forwardChain('group'));
    const results = evaluatePredicates([exists({ within: key }), exists({ within: key }), count({ within: key }, 'eq', N - 1)], obs, {});
    expect(results.map((r) => r.actual)).toEqual([{ matches: N - 1 }, { matches: N - 1 }, { matches: N - 1 }]);
    expect(Math.max(...roleReads)).toBeLessThanOrEqual(1);
  });
});

describe('evaluator results are plain data (R-AS3)', () => {
  it('R-AS3: whole result objects for one predicate of every kind', () => {
    const specs = [leaf('checkbox', 'Terms', { states: { checked: true } }), leaf('heading', 'Billing')];
    const preds: Predicate[] = [
      exists({ role: 'heading' }),
      count({ role: 'checkbox' }, 'eq', 1),
      textEq({ role: 'heading' }, 'billing'),
      { op: 'state', query: { role: 'checkbox' }, state: 'checked', value: true },
      { op: 'route', match: 'prefix', value: '/b' },
    ];
    const got = evaluatePredicates(preds, makeObs(specs, '/billing'), {}) as { predicate: Predicate; satisfied: unknown; actual: JsonValue }[];
    expect(got.map((r) => ({ satisfied: r.satisfied, actual: r.actual }))).toEqual([
      { satisfied: true, actual: { matches: 1 } },
      { satisfied: true, actual: { matches: 1 } },
      { satisfied: true, actual: { matches: 1, text: 'Billing' } },
      { satisfied: true, actual: { matches: 1, state: true } },
      { satisfied: true, actual: { route: '/billing' } },
    ]);
  });
});
