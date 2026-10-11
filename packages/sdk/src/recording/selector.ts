import type { DeriveSelector, FindBySelector, ObservedNode, Observation, Selector } from '../contracts/index.ts';
import { normalizeText } from '../util/index.ts';

type Ancestor = { role: string; name: string };

const MAX_ANCESTORS = 3;

/** Parent of `nodes[index]`: by `parentRef` when resolvable, else by depth in document order. */
function parentIndex(nodes: readonly ObservedNode[], index: number, refs: ReadonlyMap<string, number> | null): number {
  const node = nodes[index];
  // Stryker disable next-line UnaryOperator: equivalent mutant, `nodes[index]` is always defined here (every caller passes an index taken from the list), so the -1 is never returned
  if (node === undefined) return -1;
  if (node.parentRef !== undefined && refs !== null) {
    const p = refs.get(node.parentRef);
    if (p !== undefined && p !== index) return p;
  }
  for (let i = index - 1; i >= 0; i--) {
    const c = nodes[i];
    if (c !== undefined && c.depth < node.depth) return i;
  }
  return -1;
}

function buildRefIndex(nodes: readonly ObservedNode[]): Map<string, number> | null {
  // Stryker disable next-line ConditionalExpression: equivalent mutants (`false`, and `n.parentRef !== undefined` -> true), the early return only skips building a map that is read solely for nodes that carry a parentRef, and then `some` is true anyway
  if (!nodes.some((n) => n.parentRef !== undefined)) return null;
  const refs = new Map<string, number>();
  nodes.forEach((n, i) => {
    if (!refs.has(n.ref)) refs.set(n.ref, i);
  });
  return refs;
}

/** Named ancestors of `nodes[index]`, nearest first (unnamed ancestors are skipped). */
function namedAncestors(nodes: readonly ObservedNode[], index: number, refs: ReadonlyMap<string, number> | null, limit: number): Ancestor[] {
  const out: Ancestor[] = [];
  const seen = new Set<number>();
  let cur = parentIndex(nodes, index, refs);
  // Stryker disable next-line ConditionalExpression: equivalent mutant (`cur >= 0` -> true), with cur = -1 `nodes[cur]` is undefined and the loop breaks on the next line
  while (cur >= 0 && out.length < limit && !seen.has(cur)) {
    seen.add(cur);
    const n = nodes[cur];
    if (n === undefined) break;
    const name = normalizeText(n.name);
    if (name !== '') out.push({ role: n.role, name });
    cur = parentIndex(nodes, cur, refs);
  }
  return out;
}

/** `wanted` must be an ordered subsequence of `chain` (both nearest first). */
function isSubsequence(wanted: readonly Ancestor[], chain: readonly Ancestor[]): boolean {
  let j = 0;
  for (const c of chain) {
    const w = wanted[j];
    if (w === undefined) return true;
    if (w.role === c.role && w.name === c.name) j++;
  }
  return j >= wanted.length;
}

function candidateIndexes(sel: Selector, obs: Observation): number[] {
  const nodes = obs.nodes;
  // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent mutants (`> 0` -> true or `>= 0`), the ref index only saves an allocation when there are no ancestors to match, and it is read only on line 69 behind the same test
  const refs = sel.ancestors.length > 0 ? buildRefIndex(nodes) : null;
  const out: number[] = [];
  // Stryker disable next-line EqualityOperator: equivalent mutant (`i <= nodes.length`), `nodes[nodes.length]` is undefined and the next line skips it
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n === undefined) continue;
    if (n.role !== sel.role) continue;
    if (normalizeText(n.name) !== sel.name) continue;
    if (sel.testId !== undefined && n.testId !== sel.testId) continue;
    // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent mutants (`> 0` -> true or `>= 0`), an empty wanted chain is a subsequence of every chain, so the guard only avoids computing ancestors
    if (sel.ancestors.length > 0 && !isSubsequence(sel.ancestors, namedAncestors(nodes, i, refs, Number.POSITIVE_INFINITY))) continue;
    out.push(i);
  }
  return out;
}

export const deriveSelector: DeriveSelector = (node, obs) => {
  let at = obs.nodes.indexOf(node);
  // Stryker disable next-line EqualityOperator: equivalent mutant (`at <= 0`), at 0 the search by ref finds the first node whose ref is the node's own, which is index 0 again
  if (at < 0) at = obs.nodes.findIndex((n) => n.ref === node.ref);
  const refs = buildRefIndex(obs.nodes);
  // Stryker disable next-line ConditionalExpression: equivalent mutant (`at >= 0` -> true), parentIndex(-1) finds no node and returns -1, so the ancestors are empty anyway
  const ancestors = at >= 0 ? namedAncestors(obs.nodes, at, refs, MAX_ANCESTORS) : [];
  const sel: Selector = { role: node.role, name: normalizeText(node.name), ancestors, index: 0, of: 1 };
  if (node.testId !== undefined && node.testId !== '') sel.testId = node.testId;
  const candidates = candidateIndexes(sel, obs);
  const position = candidates.indexOf(at);
  sel.of = Math.max(candidates.length, 1);
  // Stryker disable next-line EqualityOperator: equivalent mutant (`position > 0`), position 0 gives index 0 either way
  sel.index = position >= 0 ? position : 0;
  return sel;
};

export const findBySelector: FindBySelector = (sel, obs) => {
  const candidates = candidateIndexes(sel, obs);
  const c = candidates.length;
  if (c === 0) return { status: 'missing' };
  if (c !== sel.of) return { status: 'ambiguous', count: c };
  const at = candidates[sel.index];
  const node = at === undefined ? undefined : obs.nodes[at];
  if (node === undefined) return { status: 'missing' };
  return { status: 'found', node };
};
