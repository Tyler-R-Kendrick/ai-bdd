import type { CheckPredicate, JsonValue, Observation, ObservedNode, PredicateResult, PredicateResultValue, Selector } from '@ai-bdd/contracts';

/**
 * Role aliases used when matching a predicate selector to a node.
 *
 * Different drivers name the same surface differently: the fixture model calls a
 * paragraph `text`, while Playwright's aria snapshot calls it `paragraph`. A spec
 * should not have to know which driver it runs against, so the aliases below
 * normalise the common cases. The list is intentionally small and documented.
 */
const ROLE_ALIASES: Record<string, string[]> = {
  text: ['text', 'paragraph', 'span', 'generic', 'code', 'blockquote'],
  paragraph: ['paragraph', 'text'],
  heading: ['heading'],
  image: ['image', 'img'],
  link: ['link'],
  list: ['list'],
  listitem: ['listitem', 'listItem'],
  textbox: ['textbox', 'input', 'searchbox'],
  button: ['button'],
  checkbox: ['checkbox'],
  combobox: ['combobox', 'listbox'],
  dialog: ['dialog', 'alertdialog'],
  alert: ['alert', 'status'],
  tab: ['tab'],
  cell: ['cell', 'gridcell'],
  row: ['row'],
  table: ['table', 'grid'],
};

export function roleMatches(nodeRole: string, wanted: string): boolean {
  if (nodeRole === wanted) return true;
  const aliases = ROLE_ALIASES[wanted];
  if (aliases?.includes(nodeRole)) return true;
  // A heading level suffix (`heading[1]`) still matches a `heading` selector.
  if (nodeRole.startsWith(wanted) && /^[a-z]+\[\d+\]$/u.test(nodeRole)) return true;
  return false;
}

/** Matches a node against a predicate selector; `name`/`text` are optional filters. */
export function matchesSelector(node: ObservedNode, selector: Selector): boolean {
  if (selector.role && !roleMatches(node.role, selector.role)) return false;
  if (selector.testId !== undefined && node.testId !== selector.testId) return false;
  if (selector.name !== undefined && node.name !== selector.name) return false;
  if (selector.text !== undefined && (node.text ?? node.name) !== selector.text) return false;
  return true;
}

export function flattenNodes(nodes: ObservedNode[], out: ObservedNode[] = []): ObservedNode[] {
  for (const node of nodes) {
    out.push(node);
    if (node.children) flattenNodes(node.children, out);
  }
  return out;
}

/**
 * The shared predicate evaluator (section 8.3). Every predicate answers
 * `satisfied`, `unsatisfied` or `unknown`; `unknown` never implies success.
 */
export function evaluatePredicates(
  predicates: CheckPredicate[],
  observation: Observation,
  params: Record<string, JsonValue> = {},
  native?: (predicates: CheckPredicate[]) => Promise<PredicateResultValue[]>,
): PredicateResult[] {
  return predicates.map((predicate) => evaluateOne(predicate, observation, params, native));
}

function evaluateOne(
  predicate: CheckPredicate,
  observation: Observation,
  params: Record<string, JsonValue>,
  _native?: (predicates: CheckPredicate[]) => Promise<PredicateResultValue[]>,
): PredicateResult {
  const nodes = flattenNodes(observation.nodes);
  const withParam = (value: string, fromParam?: string): string =>
    fromParam !== undefined ? String(params[fromParam] ?? value) : value;

  switch (predicate.kind) {
    case 'driverNative':
      return { predicate, result: 'unknown', detail: `the driver must evaluate ${predicate.tool}` };
    case 'exists': {
      const found = nodes.some((node) => matchesSelector(node, predicate.selector));
      return { predicate, result: found ? 'satisfied' : 'unsatisfied' };
    }
    case 'notExists': {
      const found = nodes.some((node) => matchesSelector(node, predicate.selector));
      return { predicate, result: found ? 'unsatisfied' : 'satisfied' };
    }
    case 'visible': {
      const found = nodes.some((node) => matchesSelector(node, predicate.selector));
      return { predicate, result: found ? 'satisfied' : 'unsatisfied', ...(found ? {} : { detail: 'no node matches' }) };
    }
    case 'count': {
      const count = nodes.filter((node) => matchesSelector(node, predicate.selector)).length;
      return {
        predicate,
        result: count === predicate.value ? 'satisfied' : 'unsatisfied',
        detail: `found ${count}, expected ${predicate.value}`,
      };
    }
    case 'textEquals': {
      const value = withParam(predicate.value, predicate.fromParam);
      const candidates = nodes.filter((node) => matchesSelector(node, predicate.selector));
      if (candidates.length === 0) return { predicate, result: 'unsatisfied', detail: 'no node matches' };
      const match = candidates.some((node) => (node.text ?? node.name) === value);
      return { predicate, result: match ? 'satisfied' : 'unsatisfied', detail: `expected "${value}"` };
    }
    case 'textContains': {
      const value = withParam(predicate.value, predicate.fromParam);
      const candidates = nodes.filter((node) => matchesSelector(node, predicate.selector));
      const match = candidates.some((node) => (node.text ?? node.name).includes(value));
      return { predicate, result: match ? 'satisfied' : 'unsatisfied', detail: `expected to contain "${value}"` };
    }
    case 'textMatches': {
      let regex: RegExp;
      try {
        regex = new RegExp(predicate.regex, 'u');
      } catch {
        return { predicate, result: 'unknown', detail: 'the regex does not compile' };
      }
      const match = nodes.some((node) => regex.test(node.text ?? node.name));
      return { predicate, result: match ? 'satisfied' : 'unsatisfied' };
    }
    case 'routeMatches': {
      let regex: RegExp;
      try {
        regex = new RegExp(predicate.regex, 'u');
      } catch {
        return { predicate, result: 'unknown', detail: 'the regex does not compile' };
      }
      const route = observation.route ?? observation.url ?? '';
      return { predicate, result: regex.test(route) ? 'satisfied' : 'unsatisfied', detail: `route was ${route}` };
    }
    default:
      return { predicate, result: 'unknown', detail: 'unsupported predicate' };
  }
}

export function allSatisfied(results: PredicateResult[]): boolean {
  return results.length > 0 && results.every((result) => result.result === 'satisfied');
}

export function anyUnknown(results: PredicateResult[]): boolean {
  return results.some((result) => result.result === 'unknown');
}
