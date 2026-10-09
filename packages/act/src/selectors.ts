import type { EffectSignature, Observation, ObservedNode, Selector } from '@ai-bdd/contracts';
import { selectorId } from '@ai-bdd/contracts';

/** Derives a structural selector from an observed node (section 8.2). */
export function deriveSelector(node: ObservedNode, observation: Observation): Selector {
  const ancestors = findAncestors(node, observation);
  const index = siblingIndex(node, observation);
  return {
    role: node.role,
    ...(node.name && node.name.length > 0 ? { name: node.name } : {}),
    ...(node.testId ? { testId: node.testId } : {}),
    ...(ancestors.length > 0 ? { ancestors } : {}),
    ...(index > 0 ? { index } : {}),
  };
}

export type FindResult = ObservedNode | 'missing' | 'ambiguous';

/** Re-finds a node by selector. Missing or ambiguous stops a replay. */
export function findBySelector(selector: Selector, observation: Observation): FindResult {
  const matches: ObservedNode[] = flatten(observation.nodes).filter((node) => matchesSelectorNode(selector, node));
  if (matches.length === 0) return 'missing';
  if (matches.length === 1) return matches[0]!;
  if (selector.index !== undefined) return matches[selector.index] ?? 'missing';
  return 'ambiguous';
}

export function matchesSelectorNode(selector: Selector, node: ObservedNode): boolean {
  if (selector.role !== node.role) return false;
  if (selector.testId !== undefined && node.testId !== selector.testId) return false;
  if (selector.name !== undefined && node.name !== selector.name) return false;
  if (selector.text !== undefined && (node.text ?? node.name) !== selector.text) return false;
  return true;
}

/** The effect signature: what changed between two observations. */
export function computeEffect(before: Observation, after: Observation): EffectSignature {
  const beforeByKey = new Map(flatten(before.nodes).map((node) => [nodeKey(node), node]));
  const afterByKey = new Map(flatten(after.nodes).map((node) => [nodeKey(node), node]));

  const elements: EffectSignature['elements'] = [];
  for (const [key, node] of afterByKey) {
    if (!beforeByKey.has(key)) elements.push({ selector: deriveSelector(node, after), change: 'appeared' });
  }
  for (const [key, node] of beforeByKey) {
    if (!afterByKey.has(key)) elements.push({ selector: deriveSelector(node, before), change: 'disappeared' });
  }
  const route =
    before.route !== after.route ? { ...(before.route ? { before: before.route } : {}), ...(after.route ? { after: after.route } : {}) } : undefined;
  return { elements, ...(route ? { route } : {}) };
}

/** True when at least one effect element is newly true in the after state. */
export function effectSatisfied(effect: EffectSignature, before: Observation, after: Observation): boolean {
  if (effect.route && effect.route.after && before.route !== effect.route.after && after.route === effect.route.after) {
    return true;
  }
  for (const element of effect.elements) {
    const present = findBySelector(element.selector, after) !== 'missing';
    const wasPresent = findBySelector(element.selector, before) !== 'missing';
    if (element.change === 'appeared' && present && !wasPresent) return true;
    if (element.change === 'disappeared' && !present && wasPresent) return true;
    if (element.change === 'state' && present) return true;
  }
  return false;
}

export function selectorFingerprint(selector: Selector): string {
  return selectorId(selector);
}

function nodeKey(node: ObservedNode): string {
  return `${node.role}|${node.testId ?? ''}|${node.name}`;
}

function flatten(nodes: ObservedNode[], out: ObservedNode[] = []): ObservedNode[] {
  for (const node of nodes) {
    out.push(node);
    if (node.children) flatten(node.children, out);
  }
  return out;
}

function findAncestors(node: ObservedNode, observation: Observation): Array<{ role: string; name?: string }> {
  const chain: Array<{ role: string; name?: string }> = [];
  const visit = (nodes: ObservedNode[], path: ObservedNode[]): boolean => {
    for (const candidate of nodes) {
      if (candidate.ref === node.ref) {
        for (const ancestor of path.slice(-3)) {
          chain.push({ role: ancestor.role, ...(ancestor.name ? { name: ancestor.name } : {}) });
        }
        return true;
      }
      if (candidate.children && visit(candidate.children, [...path, candidate])) return true;
    }
    return false;
  };
  visit(observation.nodes, []);
  return chain;
}

function siblingIndex(node: ObservedNode, observation: Observation): number {
  const siblings = flatten(observation.nodes).filter((candidate) => candidate.role === node.role && !candidate.name);
  const position = siblings.findIndex((candidate) => candidate.ref === node.ref);
  return position <= 0 ? 0 : position;
}
