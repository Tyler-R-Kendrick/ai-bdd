import type { JsonValue, Observation, ObservedNode } from '@ai-bdd/contracts';
import { hashJson } from '@ai-bdd/contracts';

/** Roles whose name is their visible text. */
const TEXT_ROLES = new Set(['text', 'heading', 'paragraph', 'label', 'cell']);

export interface ObserveParseResult {
  nodes: ObservedNode[];
  /** Lines that did not match the documented format, kept for diagnostics. */
  unparsed: string[];
}

/**
 * Parses the `observe` text of an `e2e mcp` session.
 *
 * The documented format is one node per line:
 *
 * ```
 * #s1 button "Upgrade to Pro"
 * #s2 heading "Billing settings"
 *   #s3 text "Free plan"
 * ```
 *
 * Indentation expresses nesting, `text=...` carries node text, and bracketed
 * flags carry state (`[checked]`, `[disabled]`, `[focused]`). Unknown lines are
 * collected rather than dropped, so a format change shows up as an empty
 * observation instead of a silently wrong one.
 */
export function parseObserveText(text: string, revision: number): ObserveParseResult {
  const nodes: ObservedNode[] = [];
  const unparsed: string[] = [];
  const stack: Array<{ depth: number; node: ObservedNode }> = [];
  const used = new Map<string, number>();

  for (const rawLine of text.split(/\r?\n/u)) {
    if (rawLine.trim().length === 0) continue;
    const depth = Math.floor((rawLine.match(/^[ \t]*/u)?.[0].replace(/\t/gu, '  ').length ?? 0) / 2);
    const line = rawLine.trim();
    const match = /^(?:#(?<id>[A-Za-z0-9_-]+)\s+)?(?<role>[A-Za-z][A-Za-z0-9_-]*)(?:\s+"(?<name>(?:[^"\\]|\\.)*)")?(?<rest>.*)$/u.exec(line);
    if (!match?.groups) {
      unparsed.push(line);
      continue;
    }
    const rest = match.groups.rest ?? '';
    const textMatch = /\btext="((?:[^"\\]|\\.)*)"/u.exec(rest);
    const state: Record<string, JsonValue> = {};
    for (const flag of rest.matchAll(/\[([a-z-]+)(?:=([^\]]+))?\]/gu)) {
      state[flag[1] ?? 'flag'] = flag[2] ?? true;
    }
    const sourceId = match.groups.id;
    const ref = sourceId ? `e2e-${sourceId}` : `r${revision}-${used.size + 1}`;
    used.set(ref, (used.get(ref) ?? 0) + 1);
    const role = match.groups.role ?? 'unknown';
    const name = unescape(match.groups.name ?? '');
    const explicitText = textMatch ? unescape(textMatch[1] ?? '') : undefined;
    const inferredText = explicitText ?? (TEXT_ROLES.has(role) ? name : undefined);
    const node: ObservedNode = {
      ref,
      role,
      name,
      ...(inferredText !== undefined && inferredText.length > 0 ? { text: inferredText } : {}),
      ...(Object.keys(state).length > 0 ? { state } : {}),
    };

    while (stack.length > 0 && (stack.at(-1)?.depth ?? 0) >= depth) stack.pop();
    const parent = stack.at(-1)?.node;
    if (parent) {
      parent.children = [...(parent.children ?? []), node];
    } else {
      nodes.push(node);
    }
    stack.push({ depth, node });
  }

  return { nodes, unparsed };
}

function unescape(value: string): string {
  return value.replace(/\\(["\\nt])/gu, (_all, ch: string) =>
    ch === 'n' ? '\n' : ch === 't' ? '\t' : ch,
  );
}

/** A stable structural hash of an observation's tree. */
export function treeHashOf(nodes: ObservedNode[]): string {
  return hashJson(nodes as unknown as JsonValue);
}

export function toObservation(input: {
  revision: number;
  nodes: ObservedNode[];
  url?: string;
  route?: string;
  title?: string;
  tainted: boolean;
  maskingProven: boolean;
  settled: boolean;
  capturedAt: string;
  screenshot?: Observation['screenshot'];
}): Observation {
  const observation: Observation = {
    revision: input.revision,
    nodes: input.nodes,
    treeHash: treeHashOf(input.nodes),
    tainted: input.tainted,
    maskingProven: input.maskingProven,
    settled: input.settled,
    capturedAt: input.capturedAt,
  };
  if (input.url !== undefined) observation.url = input.url;
  if (input.route !== undefined) observation.route = input.route;
  if (input.title !== undefined) observation.title = input.title;
  if (input.screenshot !== undefined) observation.screenshot = input.screenshot;
  return observation;
}
