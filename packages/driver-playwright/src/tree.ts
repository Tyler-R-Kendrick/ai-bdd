import type { JsonValue, ObservedNode, Selector } from '@ai-bdd/contracts';
import { hashJson } from '@ai-bdd/contracts';

/** How a ref is turned back into a Playwright locator. */
export interface LocatorDescriptor {
  selector: Selector;
  nth: number;
  /** Tag name, used to decide whether a field is a password input. */
  tag?: string;
  inputType?: string;
}

export interface ParsedTree {
  nodes: ObservedNode[];
  descriptors: Map<string, LocatorDescriptor>;
  unparsed: string[];
}

/**
 * Parses a Playwright `ariaSnapshot()` string into observed nodes.
 *
 * The snapshot format is YAML-ish:
 *
 * ```
 * - heading "Billing settings" [level=1]
 * - button "Upgrade to Pro"
 * - textbox "Password": ••••
 * ```
 *
 * Indentation expresses nesting, `- role "name"` carries the accessible name,
 * `[k=v]` carries state, `: value` carries a text value. Refs are
 * `r<revision>-<n>` and are valid only for that observation (F-E3 semantics).
 */
export function parseAriaSnapshot(snapshot: string, revision: number): ParsedTree {
  const nodes: ObservedNode[] = [];
  const descriptors = new Map<string, LocatorDescriptor>();
  const unparsed: string[] = [];
  const stack: Array<{ indent: number; node: ObservedNode }> = [];
  let counter = 0;

  for (const rawLine of snapshot.split(/\r?\n/u)) {
    if (rawLine.trim().length === 0) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim().replace(/^-\s+/u, '');
    const match = /^(?<role>[a-z][a-z0-9_]*)(?:\s+"(?<name>(?:[^"\\]|\\.)*)")?(?<rest>.*)$/u.exec(line);
    if (!match?.groups) {
      unparsed.push(line);
      continue;
    }
    const role = match.groups.role;
    const name = unescape(match.groups.name ?? '');
    const rest = match.groups.rest ?? '';
    const state: Record<string, JsonValue> = {};
    for (const attribute of rest.matchAll(/\[([a-z-]+)(?:=([^\]]+))?\]/gu)) {
      const key = attribute[1] ?? 'flag';
      const value = attribute[2];
      state[key] = value === undefined ? true : Number.isFinite(Number(value)) ? Number(value) : value;
    }
    const valueMatch = /:\s*(.*)$/u.exec(rest);
    const level = typeof state.level === 'number' ? (state.level as number) : undefined;

    counter += 1;
    const ref = `r${revision}-${counter}`;
    const node: ObservedNode = {
      ref,
      role: level !== undefined && (role === 'heading' || role === 'paragraph') ? `${role}[${level}]` : role,
      name,
      ...(valueMatch && valueMatch[1] ? { text: unescape(valueMatch[1]) } : {}),
      ...(Object.keys(state).length > 0 ? { state } : {}),
    };

    while (stack.length > 0 && (stack.at(-1)?.indent ?? -1) >= indent) stack.pop();
    const parent = stack.at(-1)?.node;
    if (parent) parent.children = [...(parent.children ?? []), node];
    else nodes.push(node);
    stack.push({ indent, node });

    descriptors.set(ref, {
      selector: {
        role: baseRole(role),
        ...(name.length > 0 ? { name } : {}),
      },
      nth: nthOf(nodes, node, role, name),
    });
  }

  return { nodes, descriptors, unparsed };
}

function baseRole(role: string): string {
  return role.replace(/\[\d+\]$/u, '');
}

function nthOf(nodes: ObservedNode[], target: ObservedNode, role: string, name: string): number {
  // Count earlier siblings with the same role and name; Playwright's nth() is
  // 0-based, so the first occurrence is 0.
  const all = flatten(Array.isArray(nodes) ? nodes : []);
  const same = all.filter((node) => node.role === target.role && node.name === name);
  void role;
  return Math.max(0, same.findIndex((node) => node.ref === target.ref));
}

function flatten(nodes: ObservedNode[], out: ObservedNode[] = []): ObservedNode[] {
  for (const node of nodes) {
    out.push(node);
    if (node.children) flatten(node.children, out);
  }
  return out;
}

function unescape(value: string): string {
  // Playwright quotes text content (`paragraph: "Plan: Free plan"`); the node value
  // is the unquoted string, which is what a predicate should compare against.
  const unquoted =
    value.length >= 2 && value.startsWith("\"") && value.endsWith("\"") ? value.slice(1, -1) : value;
  return unquoted.replace(/\\(["\\n])/gu, (_all, ch: string) => (ch === "n" ? "\n" : ch));
}

export function structuralTreeHash(nodes: ObservedNode[]): string {
  const shape = (list: ObservedNode[]): JsonValue[] =>
    list.map((node) => ({
      role: node.role,
      name: node.name,
      ...(node.testId ? { testId: node.testId } : {}),
      children: node.children ? shape(node.children) : [],
    }));
  return hashJson(shape(nodes) as unknown as JsonValue);
}
