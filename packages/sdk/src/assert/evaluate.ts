import type {
  EvaluatePredicates, JsonObject, JsonValue, NodeKey, NodeQuery, ObservedNode, Observation, Predicate, PredicateResult,
} from '../contracts/index.ts';
import { normalizeText } from '../util/index.ts';

/**
 * Deterministic predicate evaluator (SPEC §10.4, R-AS3). No regular expressions, no model, no I/O.
 * Cost is O(predicates x nodes); `within` ancestor lookups are memoized so they stay linear in the node count.
 */

const ACTUAL_TEXT_MAX = 300;

function fold(s: string): string {
  return normalizeText(s).toLowerCase();
}

function clip(s: string): string {
  return s.length > ACTUAL_TEXT_MAX ? `${s.slice(0, ACTUAL_TEXT_MAX)}...` : s;
}

function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

class EvalContext {
  readonly nodes: readonly ObservedNode[];
  readonly obs: Observation;
  private names: (string | undefined)[];
  private parentIdx: Int32Array | undefined;
  private ancestorCache = new Map<string, Uint8Array>();

  constructor(obs: Observation) {
    this.obs = obs;
    this.nodes = obs.nodes;
    this.names = new Array<string | undefined>(obs.nodes.length);
  }

  foldedName(i: number): string {
    let v = this.names[i];
    if (v === undefined) {
      v = fold((this.nodes[i] as ObservedNode).name);
      this.names[i] = v;
    }
    return v;
  }

  private parents(): Int32Array {
    if (this.parentIdx) return this.parentIdx;
    const n = this.nodes.length;
    const byRef = new Map<string, number>();
    for (let i = 0; i < n; i += 1) byRef.set((this.nodes[i] as ObservedNode).ref, i);
    const out = new Int32Array(n).fill(-1);
    const stack: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const node = this.nodes[i] as ObservedNode;
      while (stack.length > 0 && ((this.nodes[stack[stack.length - 1] as number] as ObservedNode).depth >= node.depth)) stack.pop();
      if (isStr(node.parentRef)) {
        const p = byRef.get(node.parentRef);
        out[i] = p === undefined || p === i ? -1 : p;
      } else {
        out[i] = stack.length > 0 ? (stack[stack.length - 1] as number) : -1;
      }
      stack.push(i);
    }
    this.parentIdx = out;
    return out;
  }

  /** flags[i] === 1 iff some ancestor of node i has the given role and (folded) exact name. */
  ancestorFlags(key: NodeKey): Uint8Array {
    const fk = fold(key.name);
    const cacheKey = `${key.role}\u0000${fk}`;
    const cached = this.ancestorCache.get(cacheKey);
    if (cached) return cached;
    const n = this.nodes.length;
    const parents = this.parents();
    // 0 unknown, 1 has matching ancestor, 2 none, 3 in progress
    const state = new Uint8Array(n);
    const isKey = (i: number): boolean => (this.nodes[i] as ObservedNode).role === key.role && this.foldedName(i) === fk;
    for (let s = 0; s < n; s += 1) {
      if (state[s] !== 0) continue;
      const path: number[] = [];
      let cur = s;
      let result = 2;
      for (;;) {
        const p = parents[cur] as number;
        if (p < 0) { result = 2; break; }
        if (isKey(p)) { result = 1; break; }
        const ps = state[p] as number;
        if (ps === 1) { result = 1; break; }
        if (ps === 2 || ps === 3) { result = 2; break; }
        state[cur] = 3;
        path.push(cur);
        cur = p;
      }
      state[cur] = result;
      for (const x of path) state[x] = result;
    }
    const flags = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) flags[i] = state[i] === 1 ? 1 : 0;
    this.ancestorCache.set(cacheKey, flags);
    return flags;
  }

  /** Indices of nodes matching the query. */
  select(query: NodeQuery): number[] {
    const role = isStr(query.role) ? query.role : undefined;
    const testId = isStr(query.testId) ? query.testId : undefined;
    const name = isStr(query.name) ? fold(query.name) : undefined;
    const contains = query.nameMatch === 'contains';
    const within = query.within !== undefined && query.within !== null ? this.ancestorFlags(query.within) : undefined;
    const out: number[] = [];
    for (let i = 0; i < this.nodes.length; i += 1) {
      const node = this.nodes[i] as ObservedNode;
      if (role !== undefined && node.role !== role) continue;
      if (testId !== undefined && node.testId !== testId) continue;
      if (within !== undefined && within[i] !== 1) continue;
      if (name !== undefined) {
        const nm = this.foldedName(i);
        if (contains ? !nm.includes(name) : nm !== name) continue;
      }
      out.push(i);
    }
    return out;
  }
}

/**
 * An observation without a single node (a blank page, a crashed renderer, a driver that lost the page) shows nothing, so it cannot
 * show that something is absent: absence and zero-count predicates are `unknown` there, which fails the check, instead of passing vacuously.
 */
function blank(predicate: Predicate): PredicateResult {
  return { predicate, satisfied: 'unknown', actual: { matches: 0, blank: true } };
}

/** The predicate of one kind. */
type Of<K extends Predicate['op']> = Extract<Predicate, { op: K }>;

function evalExists(ctx: EvalContext, predicate: Of<'exists'>): PredicateResult {
  const n = ctx.select(predicate.query).length;
  if (predicate.negate === true && ctx.nodes.length === 0) return blank(predicate);
  return { predicate, satisfied: predicate.negate === true ? n === 0 : n >= 1, actual: { matches: n } };
}

function evalCount(ctx: EvalContext, predicate: Of<'count'>): PredicateResult {
  const n = ctx.select(predicate.query).length;
  if (n === 0 && ctx.nodes.length === 0 && (predicate.cmp === 'lte' || (predicate.cmp === 'eq' && predicate.value === 0))) return blank(predicate);
  const v = predicate.value;
  let ok: boolean | 'unknown';
  if (typeof v !== 'number') ok = false;
  else if (predicate.cmp === 'eq') ok = n === v;
  else if (predicate.cmp === 'gte') ok = n >= v;
  else if (predicate.cmp === 'lte') ok = n <= v;
  else ok = 'unknown';
  return { predicate, satisfied: ok, actual: { matches: n } };
}

function evalText(ctx: EvalContext, predicate: Of<'text'>, params: Record<string, string>): PredicateResult {
  const idx = ctx.select(predicate.query);
  if (idx.length !== 1) return { predicate, satisfied: false, actual: { matches: idx.length } };
  const node = ctx.nodes[idx[0] as number] as ObservedNode;
  const tv = predicate.value as { literal?: string; param?: string };
  let expectedRaw: string;
  if (isStr(tv.literal)) {
    expectedRaw = tv.literal;
  } else if (isStr(tv.param)) {
    if (!Object.hasOwn(params, tv.param) || !isStr(params[tv.param])) {
      return { predicate, satisfied: false, actual: { matches: 1, missingParam: clip(tv.param) } };
    }
    expectedRaw = params[tv.param] as string;
  } else {
    return { predicate, satisfied: 'unknown', actual: { error: 'text value has neither literal nor param' } };
  }
  const expected = fold(expectedRaw);
  const primary = node.text ?? node.name;
  const candidates = node.value === undefined ? [primary] : [primary, node.value];
  const hit = candidates.some((c) => {
    const f = fold(c);
    return predicate.match === 'equals' ? f === expected : f.includes(expected);
  });
  const actual: JsonObject = { matches: 1, text: clip(primary) };
  if (node.value !== undefined) actual['value'] = clip(node.value);
  return { predicate, satisfied: predicate.match === 'equals' || predicate.match === 'contains' ? hit : 'unknown', actual };
}

function evalState(ctx: EvalContext, predicate: Of<'state'>): PredicateResult {
  const idx = ctx.select(predicate.query);
  if (idx.length !== 1) return { predicate, satisfied: false, actual: { matches: idx.length } };
  const node = ctx.nodes[idx[0] as number] as ObservedNode;
  const key = predicate.state as string;
  const raw: unknown = Object.hasOwn(node.states, key) ? (node.states as Record<string, unknown>)[key] : undefined;
  const normalized: JsonValue = raw === undefined ? false : (raw as JsonValue);
  return { predicate, satisfied: normalized === predicate.value, actual: { matches: 1, state: normalized } };
}

function evalRoute(ctx: EvalContext, predicate: Of<'route'>): PredicateResult {
  const route = ctx.obs.route;
  let ok: boolean | 'unknown';
  if (predicate.match === 'equals') ok = route === predicate.value;
  else if (predicate.match === 'prefix') ok = isStr(predicate.value) && route.startsWith(predicate.value);
  else ok = 'unknown';
  return { predicate, satisfied: ok, actual: { route: clip(route) } };
}

function evalOne(ctx: EvalContext, predicate: Predicate, params: Record<string, string>): PredicateResult {
  switch (predicate.op) {
    case 'exists':
      return evalExists(ctx, predicate);
    case 'count':
      return evalCount(ctx, predicate);
    case 'text':
      return evalText(ctx, predicate, params);
    case 'state':
      return evalState(ctx, predicate);
    case 'route':
      return evalRoute(ctx, predicate);
    default:
      return { predicate, satisfied: 'unknown', actual: { error: 'unsupported predicate' } };
  }
}

export const evaluatePredicates: EvaluatePredicates = (predicates, obs, params) => {
  const ctx = new EvalContext(obs);
  return predicates.map((p) => {
    try {
      return evalOne(ctx, p, params);
    } catch (err) {
      return { predicate: p, satisfied: 'unknown', actual: { error: clip(err instanceof Error ? err.message : String(err)) } };
    }
  });
};

/** A program passes iff it has at least one predicate and every predicate is satisfied (`unknown` fails). */
export function allSatisfied(results: readonly PredicateResult[]): boolean {
  return results.length > 0 && results.every((r) => r.satisfied === true);
}
