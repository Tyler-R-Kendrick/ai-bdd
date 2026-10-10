// @ts-nocheck
import type { ComputeEffect, EffectSignature, JsonValue, NodeKey, NodeStates, ObservedNode, Observation } from '../contracts/index.ts';
import { normalizeText } from '../util/index.ts';
import { isVolatileText } from './volatile.ts';

/**
 * Tracked per-node properties for `changed`. `focused` and `busy` are deliberately excluded:
 * focus moves as a side effect of any click, and busy flips during loading; neither is an
 * application effect, and counting them would let a no-op click look like it did something.
 */
export const TRACKED_STATES: readonly (keyof NodeStates)[] = ['checked', 'disabled', 'expanded', 'invalid', 'pressed', 'selected'];
export const TRACKED_PROPERTIES: readonly string[] = ['value', ...TRACKED_STATES];

export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareKeys(a: NodeKey, b: NodeKey): number {
  return compareStrings(a.role, b.role) || compareStrings(a.name, b.name);
}

const SEP = '\u0000';

/** Stable map key of a node, or null for unnamed nodes (they carry no addressable identity). */
export function nodeKeyId(node: ObservedNode): string | null {
  const name = normalizeText(node.name);
  return name === '' ? null : `${node.role}${SEP}${name}`;
}

export function groupByKey(obs: Observation): Map<string, ObservedNode[]> {
  const map = new Map<string, ObservedNode[]>();
  for (const n of obs.nodes) {
    const id = nodeKeyId(n);
    if (id === null) continue;
    const group = map.get(id);
    if (group === undefined) map.set(id, [n]);
    else group.push(n);
  }
  return map;
}

export function keyFromId(id: string): NodeKey {
  const at = id.indexOf(SEP);
  return { role: id.slice(0, at), name: id.slice(at + 1) };
}

/** Normalized value of a tracked property. Unset states count as `false`, unset values as `''`. */
export function propertyValue(node: ObservedNode, property: string): JsonValue {
  if (property === 'value') return node.value ?? '';
  const v = (node.states as Record<string, boolean | 'mixed' | undefined>)[property];
  return v ?? false;
}

function signature(node: ObservedNode): string {
  return JSON.stringify(TRACKED_PROPERTIES.map((p) => propertyValue(node, p)));
}

function groupVolatile(group: readonly ObservedNode[]): boolean {
  return group.some((n) => isVolatileText(normalizeText(n.name)) || (n.value !== undefined && isVolatileText(n.value)));
}

function sameIdentity(a: readonly ObservedNode[], b: readonly ObservedNode[] | undefined): boolean {
  if (b === undefined || a.length !== b.length) return false;
  if (a.length !== 1) return true;
  const x = a[0];
  const y = b[0];
  return x !== undefined && y !== undefined && signature(x) === signature(y);
}

export const computeEffect: ComputeEffect = (before, after, afterProbe) => {
  const b = groupByKey(before);
  const a = groupByKey(after);
  const p = afterProbe === undefined ? undefined : groupByKey(afterProbe);

  const appeared: NodeKey[] = [];
  const disappeared: NodeKey[] = [];
  const changed: EffectSignature['changed'] = [];

  for (const [id, group] of a) {
    if (b.has(id) || groupVolatile(group)) continue;
    if (p !== undefined && !sameIdentity(group, p.get(id))) continue;
    appeared.push(keyFromId(id));
  }
  for (const [id, group] of b) {
    if (a.has(id) || groupVolatile(group)) continue;
    if (p !== undefined && p.has(id)) continue;
    disappeared.push(keyFromId(id));
  }
  for (const [id, afterGroup] of a) {
    const beforeGroup = b.get(id);
    if (beforeGroup === undefined || beforeGroup.length !== 1 || afterGroup.length !== 1) continue;
    const from = beforeGroup[0];
    const to = afterGroup[0];
    if (from === undefined || to === undefined) continue;
    if (isVolatileText(normalizeText(to.name))) continue;
    const probeGroup = p?.get(id);
    for (const property of TRACKED_PROPERTIES) {
      const fromValue = propertyValue(from, property);
      const toValue = propertyValue(to, property);
      if (fromValue === toValue) continue;
      if (property === 'value' && ((typeof fromValue === 'string' && isVolatileText(fromValue)) || (typeof toValue === 'string' && isVolatileText(toValue)))) continue;
      if (p !== undefined) {
        const probed = probeGroup?.length === 1 ? probeGroup[0] : undefined;
        if (probed === undefined || propertyValue(probed, property) !== toValue) continue;
      }
      changed.push({ key: keyFromId(id), state: property, from: fromValue, to: toValue });
    }
  }

  appeared.sort(compareKeys);
  disappeared.sort(compareKeys);
  changed.sort((x, y) => compareKeys(x.key, y.key) || compareStrings(x.state, y.state));
  return { routeBefore: before.route, routeAfter: after.route, appeared, disappeared, changed };
};
