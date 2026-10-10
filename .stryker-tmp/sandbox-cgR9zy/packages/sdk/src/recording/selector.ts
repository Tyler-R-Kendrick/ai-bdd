// @ts-nocheck
import type { DeriveSelector, FindBySelector, ObservedNode, Observation, Selector } from '../contracts/index.ts';
import { normalizeText } from '../util/index.ts';

type Ancestor = { role: string; name: string };

const MAX_ANCESTORS = 3;

/** Parent of `nodes[index]`: by `parentRef` when resolvable, else by depth in document order. */
function parentIndex(nodes: readonly ObservedNode[], index: number, refs: ReadonlyMap<string, number> | null): number {
  const node = nodes[index];
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
  const refs = sel.ancestors.length > 0 ? buildRefIndex(nodes) : null;
  const out: number[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n === undefined) continue;
    if (n.role !== sel.role) continue;
    if (normalizeText(n.name) !== sel.name) continue;
    if (sel.testId !== undefined && n.testId !== sel.testId) continue;
    if (sel.ancestors.length > 0 && !isSubsequence(sel.ancestors, namedAncestors(nodes, i, refs, Number.POSITIVE_INFINITY))) continue;
    out.push(i);
  }
  return out;
}

export const deriveSelector: DeriveSelector = (node, obs) => {
  let at = obs.nodes.indexOf(node);
  if (at < 0) at = obs.nodes.findIndex((n) => n.ref === node.ref);
  const refs = buildRefIndex(obs.nodes);
  const ancestors = at >= 0 ? namedAncestors(obs.nodes, at, refs, MAX_ANCESTORS) : [];
  const sel: Selector = { role: node.role, name: normalizeText(node.name), ancestors, index: 0, of: 1 };
  if (node.testId !== undefined && node.testId !== '') sel.testId = node.testId;
  const candidates = candidateIndexes(sel, obs);
  const position = candidates.indexOf(at);
  sel.of = Math.max(candidates.length, 1);
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
