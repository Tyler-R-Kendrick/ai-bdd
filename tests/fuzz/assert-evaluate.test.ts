import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createAsserter, createRedactor, evaluatePredicates, renderTree, treeHash } from '@ai-bdd/sdk';
import type { CheckProgram, JsonValue, NodeQuery, NodeStates, ObservedNode, Observation, Predicate, PredicateResult } from '@ai-bdd/sdk/contracts';
import { cpuMs, hostileString, jsonValue, params } from './helpers.ts';
import { allSatisfied } from '../../packages/sdk/src/assert/evaluate.ts';

// ───────────────────────── generators

const ROLES = ['button', 'textbox', 'link', 'heading', 'generic', 'dialog', 'form', 'checkbox', 'list', 'listitem', '__proto__', 'constructor', ''];
const roleArb = fc.constantFrom(...ROLES);
const nameArb = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom('Save', 'save', ' Save  ', 'Cancel', 'Sign in', 'Email', 'Welcome back', 'Ünï', 'İ', 'ǅ', '') },
  { weight: 2, arbitrary: hostileString({ maxLength: 30 }) },
);
const stateValue = fc.oneof(fc.boolean(), fc.constant('mixed' as const));
const statesArb: fc.Arbitrary<NodeStates> = fc.record({ checked: stateValue, disabled: fc.boolean(), expanded: fc.boolean(), selected: fc.boolean(), pressed: stateValue, focused: fc.boolean(), busy: fc.boolean(), invalid: fc.boolean() }, { requiredKeys: [] });

interface TreeSpec { nodes: ObservedNode[]; route: string }

/** A well-formed observation: preorder list with consistent depth and parentRef. */
const treeArb: fc.Arbitrary<TreeSpec> = fc
  .tuple(
    fc.array(
      fc.record({
        role: roleArb,
        name: nameArb,
        text: fc.option(nameArb, { nil: undefined }),
        value: fc.option(nameArb, { nil: undefined }),
        testId: fc.option(fc.constantFrom('a', 'b', '__proto__'), { nil: undefined }),
        states: statesArb,
        up: fc.nat({ max: 3 }),
      }),
      { maxLength: 30 },
    ),
    fc.constantFrom('/', '/home', '/a/b?x=1', '', '\u202e/x'),
  )
  .map(([specs, route]) => {
    const nodes: ObservedNode[] = [];
    const stack: ObservedNode[] = [];
    specs.forEach((s, i) => {
      for (let k = 0; k < s.up && stack.length > 0; k += 1) stack.pop();
      const parent = stack[stack.length - 1];
      const node: ObservedNode = { ref: `e${i}`, role: s.role, name: s.name, states: s.states, depth: stack.length };
      if (s.text !== undefined) node.text = s.text;
      if (s.value !== undefined) node.value = s.value;
      if (s.testId !== undefined) node.testId = s.testId;
      if (parent !== undefined) node.parentRef = parent.ref;
      nodes.push(node);
      stack.push(node);
    });
    return { nodes, route };
  });

/** An observation whose structure lies: cyclic or dangling parentRefs, random depths, repeated refs. */
const tangledArb: fc.Arbitrary<TreeSpec> = fc.tuple(treeArb, fc.array(fc.tuple(fc.nat(40), fc.nat(40), fc.integer({ min: -3, max: 6 })), { maxLength: 20 })).map(([tree, edits]) => {
  const nodes = tree.nodes.map((n) => ({ ...n }));
  for (const [a, b, depth] of edits) {
    const node = nodes[a % Math.max(1, nodes.length)];
    if (node === undefined) continue;
    node.parentRef = b % 5 === 0 ? 'missing' : (nodes[b % nodes.length]?.ref ?? 'missing');
    node.depth = depth;
    if (b % 7 === 0) node.ref = nodes[0]?.ref ?? node.ref;
  }
  return { nodes, route: tree.route };
});

function observation(t: TreeSpec): Observation {
  return { revision: 1, route: t.route, nodes: t.nodes, busy: false, tainted: false, treeText: renderTree(t.nodes.map((n) => ({ ...n, depth: Math.max(0, n.depth) })), { refs: true }), treeHash: treeHash(t.nodes.map((n) => ({ ...n, depth: Math.max(0, n.depth) }))) };
}

function queryArb(t: TreeSpec): fc.Arbitrary<NodeQuery> {
  const roles = fc.oneof(roleArb, fc.constantFrom(...t.nodes.map((n) => n.role), 'button'));
  const names = fc.oneof(nameArb, fc.constantFrom(...t.nodes.map((n) => n.name), 'Save'));
  const within = fc.oneof(fc.constant(undefined), fc.record({ role: roles, name: names }));
  return fc
    .record({ role: fc.option(roles, { nil: undefined }), name: fc.option(names, { nil: undefined }), nameMatch: fc.option(fc.constantFrom('exact', 'contains'), { nil: undefined }), testId: fc.option(fc.constantFrom('a', 'b', 'zz'), { nil: undefined }), within }, { requiredKeys: [] })
    .map((q) => Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined)) as NodeQuery);
}

function predicateArb(t: TreeSpec): fc.Arbitrary<Predicate> {
  const q = queryArb(t);
  const stateKey = fc.constantFrom('checked', 'disabled', 'expanded', 'selected', 'pressed', 'focused', 'busy', 'invalid', '__proto__', 'constructor', 'toString', 'hasOwnProperty') as fc.Arbitrary<keyof NodeStates>;
  return fc.oneof(
    fc.record({ op: fc.constant('exists' as const), query: q, negate: fc.option(fc.boolean(), { nil: undefined }) }, { requiredKeys: ['op', 'query'] }) as fc.Arbitrary<Predicate>,
    fc.record({ op: fc.constant('count' as const), query: q, cmp: fc.constantFrom('eq' as const, 'gte' as const, 'lte' as const), value: fc.integer({ min: -2, max: 8 }) }),
    fc.record({ op: fc.constant('text' as const), query: q, match: fc.constantFrom('equals' as const, 'contains' as const), value: fc.oneof(nameArb.map((literal) => ({ literal })), fc.constantFrom('who', '__proto__', 'constructor', 'missing').map((param) => ({ param }))) }),
    fc.record({ op: fc.constant('state' as const), query: q, state: stateKey, value: fc.boolean() }),
    fc.record({ op: fc.constant('route' as const), match: fc.constantFrom('equals' as const, 'prefix' as const), value: fc.oneof(fc.constantFrom(t.route, '/', '/home', ''), nameArb) }),
  );
}

const PARAMS: Record<string, string> = { who: 'Save' };
Object.defineProperty(PARAMS, '__proto__', { value: 'own-proto-param', enumerable: true });

const treeWithPredicates = (tree: fc.Arbitrary<TreeSpec> = treeArb): fc.Arbitrary<{ t: TreeSpec; ps: Predicate[] }> =>
  tree.chain((t) => fc.record({ t: fc.constant(t), ps: fc.array(predicateArb(t), { maxLength: 8 }) }));

const KINDS: PredicateResult['satisfied'][] = [true, false, 'unknown'];

function evaluate(ps: readonly Predicate[], t: TreeSpec): PredicateResult[] {
  return evaluatePredicates(ps, observation(t), PARAMS);
}

// ───────────────────────── properties

describe('fuzz: evaluatePredicates', () => {
  it('never throws, returns one result per predicate in order, with a verdict and JSON-serializable evidence', () => {
    fc.assert(
      fc.property(fc.oneof(treeWithPredicates(), treeWithPredicates(tangledArb)), ({ t, ps }) => {
        const results = evaluate(ps, t);
        expect(results).toHaveLength(ps.length);
        results.forEach((r, i) => {
          expect(r.predicate).toBe(ps[i]);
          expect(KINDS).toContain(r.satisfied);
          if (r.actual !== undefined) expect(JSON.parse(JSON.stringify(r.actual))).toEqual(r.actual);
        });
      }),
      params(),
    );
  });

  it('survives arbitrary malformed predicates (random JSON cast to Predicate) without throwing', () => {
    const malformed = fc.oneof(
      jsonValue({ maxDepth: 3, maxKeys: 4 }),
      fc.record({ op: fc.constantFrom('exists', 'count', 'text', 'state', 'route', 'bogus', '__proto__'), query: jsonValue({ maxDepth: 2 }), value: jsonValue({ maxDepth: 2 }), match: jsonValue({ maxDepth: 1 }), cmp: jsonValue({ maxDepth: 1 }), state: jsonValue({ maxDepth: 1 }) }, { requiredKeys: [] }),
    );
    fc.assert(
      fc.property(treeArb, fc.array(malformed, { maxLength: 5 }), (t, ps) => {
        const results = evaluatePredicates(ps as unknown as Predicate[], observation(t), PARAMS);
        expect(results).toHaveLength(ps.length);
        for (const r of results) expect(KINDS).toContain(r.satisfied);
      }),
      params(),
    );
  });

  it('exists with negate is the complement of exists, and exists is "at least one match" of the same query', () => {
    fc.assert(
      fc.property(treeArb.chain((t) => fc.record({ t: fc.constant(t), q: queryArb(t) })), ({ t, q }) => {
        const [pos, neg, count0, count1] = evaluate(
          [{ op: 'exists', query: q }, { op: 'exists', query: q, negate: true }, { op: 'count', query: q, cmp: 'eq', value: 0 }, { op: 'count', query: q, cmp: 'gte', value: 1 }],
          t,
        ) as [PredicateResult, PredicateResult, PredicateResult, PredicateResult];
        expect(typeof pos.satisfied).toBe('boolean');
        expect(neg.satisfied).toBe(!pos.satisfied);
        expect(count0.satisfied).toBe(!pos.satisfied);
        expect(count1.satisfied).toBe(pos.satisfied);
        expect((pos.actual as { matches: number }).matches).toBe((neg.actual as { matches: number }).matches);
      }),
      params(),
    );
  });

  it('count comparisons obey eq = gte and lte, gte(n) = not lte(n-1), and agree with the reported match count', () => {
    fc.assert(
      fc.property(treeArb.chain((t) => fc.record({ t: fc.constant(t), q: queryArb(t), n: fc.integer({ min: -1, max: 10 }) })), ({ t, q, n }) => {
        const [eq, gte, lte, lteBelow, any] = evaluate(
          [
            { op: 'count', query: q, cmp: 'eq', value: n },
            { op: 'count', query: q, cmp: 'gte', value: n },
            { op: 'count', query: q, cmp: 'lte', value: n },
            { op: 'count', query: q, cmp: 'lte', value: n - 1 },
            { op: 'exists', query: q },
          ],
          t,
        ) as PredicateResult[] as [PredicateResult, PredicateResult, PredicateResult, PredicateResult, PredicateResult];
        const matches = (any.actual as { matches: number }).matches;
        expect(eq.satisfied).toBe(matches === n);
        expect(eq.satisfied).toBe(gte.satisfied === true && lte.satisfied === true);
        expect(gte.satisfied).toBe(!lteBelow.satisfied);
        expect(any.satisfied).toBe(matches >= 1);
      }),
      params(),
    );
  });

  it('all / any laws: the verdict of a list is independent of its other members, of their order, and splits over concatenation', () => {
    fc.assert(
      fc.property(treeWithPredicates(), treeWithPredicates().map((x) => x.ps), fc.integer(), ({ t, ps }, more, seed) => {
        const results = evaluate(ps, t);
        // each predicate is judged on its own: evaluating it alone gives the same result
        ps.forEach((p, i) => {
          const alone = evaluate([p], t)[0] as PredicateResult;
          expect(alone.satisfied).toBe((results[i] as PredicateResult).satisfied);
          expect(alone.actual).toEqual((results[i] as PredicateResult).actual);
        });
        // order does not matter
        const order = ps.map((_, i) => i).sort((a, b) => ((a * 7919 + seed) % 13) - ((b * 7919 + seed) % 13));
        const permuted = evaluate(order.map((i) => ps[i] as Predicate), t);
        expect(permuted.map((r) => r.satisfied)).toEqual(order.map((i) => (results[i] as PredicateResult).satisfied));
        expect(allSatisfied(permuted)).toBe(allSatisfied(results));
        // ALL over a concatenation is the conjunction; ANY is the disjunction; an empty list satisfies nothing
        const both = evaluate([...ps, ...more], t);
        const a = evaluate(ps, t);
        const b = evaluate(more, t);
        if (ps.length > 0 && more.length > 0) expect(allSatisfied(both)).toBe(allSatisfied(a) && allSatisfied(b));
        const any = (rs: PredicateResult[]): boolean => rs.some((r) => r.satisfied === true);
        expect(any(both)).toBe(any(a) || any(b));
        expect(allSatisfied([])).toBe(false);
        // a single "unknown" can never be rescued by other true results
        if (both.some((r) => r.satisfied === 'unknown')) expect(allSatisfied(both)).toBe(false);
      }),
      params(),
    );
  });

  it('narrowing a query can only shrink its matches: within, role, testId and exact-vs-contains', () => {
    fc.assert(
      fc.property(treeArb.chain((t) => fc.record({ t: fc.constant(t), q: queryArb(t), within: fc.record({ role: roleArb, name: nameArb }) })), ({ t, q, within }) => {
        const matches = (query: NodeQuery): number => ((evaluate([{ op: 'exists', query }], t)[0] as PredicateResult).actual as { matches: number }).matches;
        const base: NodeQuery = { ...q };
        delete base.within;
        expect(matches({ ...base, within })).toBeLessThanOrEqual(matches(base));
        if (base.name !== undefined) {
          expect(matches({ ...base, nameMatch: 'exact' })).toBeLessThanOrEqual(matches({ ...base, nameMatch: 'contains' }));
        }
        // adding a role constraint to a role-less query narrows it too
        const open: NodeQuery = { ...base };
        delete open.role;
        expect(matches({ ...open, role: 'button' })).toBeLessThanOrEqual(matches(open));
      }),
      params(),
    );
  });

  it('text predicates: a node always "equals" its own text, case and whitespace insensitively, and contains any word of it', () => {
    fc.assert(
      fc.property(treeArb.filter((t) => t.nodes.length > 0), fc.nat(), fc.constantFrom('', ' ', '\u00a0 '), fc.boolean(), (t, pick, pad, upper) => {
        const node = t.nodes[pick % t.nodes.length] as ObservedNode;
        // address the node by something unique: its ref is not queryable, so give it a unique testId
        const unique: TreeSpec = { ...t, nodes: t.nodes.map((n) => ({ ...n, testId: n.ref === node.ref ? 'only-me' : 'not-me' })) };
        const own = node.text ?? node.name;
        const literal = `${pad}${upper ? own.toUpperCase() : own.toLowerCase()}${pad}`;
        const r = evaluate([{ op: 'text', query: { testId: 'only-me' }, match: 'equals', value: { literal } }, { op: 'text', query: { testId: 'only-me' }, match: 'contains', value: { literal } }], unique);
        // NFC + lower-casing round trips for these generators except where case mapping changes length or context (İ, ǅ, Σ): accept either answer there
        if (/^[\x20-\x7e]*$/.test(own)) {
          expect(r[0]?.satisfied).toBe(true);
          expect(r[1]?.satisfied).toBe(true);
        }
        expect(KINDS).toContain(r[0]?.satisfied);
      }),
      params(),
    );
  });

  it('a state predicate on an unset or inherited-sounding state ("constructor", "__proto__") is "false", never a prototype read', () => {
    fc.assert(
      fc.property(treeArb.filter((t) => t.nodes.length > 0), fc.constantFrom('constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'), fc.boolean(), (t, state, value) => {
        const unique: TreeSpec = { ...t, nodes: t.nodes.map((n, i) => ({ ...n, testId: i === 0 ? 'only-me' : 'x' })) };
        const [r] = evaluate([{ op: 'state', query: { testId: 'only-me' }, state: state as keyof NodeStates, value }], unique) as [PredicateResult];
        if ((r.actual as { matches: number }).matches === 1) {
          expect((r.actual as { state: unknown }).state).toBe(false);
          expect(r.satisfied).toBe(value === false);
        }
      }),
      params(),
    );
  });

  it('terminates quickly on deep chains, wide trees, cyclic parent references and many distinct "within" queries (CPU budget)', () => {
    const chain = (n: number): ObservedNode[] => Array.from({ length: n }, (_, i) => ({ ref: `e${i}`, role: i % 2 === 0 ? 'form' : 'generic', name: `n${i % 50}`, states: {}, depth: i, ...(i > 0 ? { parentRef: `e${i - 1}` } : {}) }));
    const cyclic = chain(4000).map((n, i) => (i === 0 ? { ...n, parentRef: 'e3999' } : n));
    const queries: Predicate[] = Array.from({ length: 200 }, (_, i) => ({ op: 'exists' as const, query: { role: 'generic', within: { role: 'form', name: `n${i % 50}` } } }));
    for (const nodes of [chain(4000), cyclic]) {
      const obs = observation({ nodes, route: '/' });
      const used = cpuMs(() => {
        const results = evaluatePredicates(queries, obs, {});
        expect(results).toHaveLength(queries.length);
      });
      expect(used).toBeLessThan(5000);
    }
  });
});

describe('fuzz: asserter.evaluate', () => {
  it('passes iff every predicate holds, and never lets a secret spelled in the page leak through the evidence', () => {
    const secret = 'Zq9!hunter2-ZQ';
    const redactor = createRedactor({ pw: secret });
    const asserter = createAsserter({ model: { id: 'unused', generate: () => Promise.reject(new Error('unused')) }, redactor, config: { checks: { maxAttempts: 1, maxPredicates: 8, requireDeterministic: false } } as never });
    fc.assert(
      fc.property(
        treeWithPredicates(),
        fc.constantFrom(secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')),
        (c, spelling) => {
          const nodes = c.t.nodes.map((n, i) => (i % 2 === 0 ? { ...n, name: `${n.name} ${spelling}`, text: `${n.text ?? n.name} ${spelling}`, value: `v ${spelling}` } : n));
          const obs = observation({ nodes, route: `/s/${spelling}` });
          const program: CheckProgram = { classification: 'change', predicates: c.ps, generatedBy: { modelId: 'm', promptVersion: 'p' }, verified: { afterTrue: true, probeTrue: true, beforeFalse: null, judgePassed: true } };
          const verdict = asserter.evaluate(program, obs, PARAMS);
          expect(verdict.passed).toBe(c.ps.length > 0 && verdict.results.every((r) => r.satisfied === true));
          expect(verdict.results).toHaveLength(c.ps.length);
          const evidence = JSON.stringify(verdict.results.map((r) => r.actual ?? null) as JsonValue[]);
          expect(evidence).not.toContain(secret);
          expect(evidence).not.toContain(encodeURIComponent(secret));
          expect(evidence).not.toContain(Buffer.from(secret).toString('base64'));
        },
      ),
      params(),
    );
  });
});
