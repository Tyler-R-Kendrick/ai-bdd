import { AiBddError, type DocPlan, type ScenarioFilter, type ScenarioTarget } from '../contracts/index.ts';
import { cmp, globToRegExp } from './util.ts';

/** All targets of the given plans (including rejected scenarios), ordered by docUri then plan order. */
export function allTargets(plans: readonly DocPlan[]): ScenarioTarget[] {
  const out: ScenarioTarget[] = [];
  for (const plan of [...plans].sort((a, b) => cmp(a.docUri, b.docUri))) {
    for (const feature of plan.features) for (const scenario of feature.scenarios) out.push({ plan, feature, scenario });
  }
  return out;
}

/** A selector is an exact scenario or feature id, an id prefix ending in `/` or `--`, or a doc glob. */
export function selectorMatches(selector: string, t: ScenarioTarget): boolean {
  const id = t.scenario.id;
  if (id === selector || t.feature.id === selector) return true;
  if ((selector.endsWith('/') || selector.endsWith('--')) && id.startsWith(selector)) return true;
  const doc = t.plan.docUri;
  return doc === selector || globToRegExp(selector.replace(/^\.\//, '')).test(doc);
}

const normTag = (t: string): string => (t.startsWith('@') ? t.slice(1) : t).toLowerCase();

/** `listScenarios` semantics (§9.1): non-rejected scenarios filtered by selectors, tags (any) and grep.
 * With `strictSelectors` (used by `run`), a selector that matches nothing is SCENARIO_NOT_FOUND. */
export function selectTargets(plans: readonly DocPlan[], filter: ScenarioFilter = {}, opts: { strictSelectors?: boolean } = {}): ScenarioTarget[] {
  const all = allTargets(plans);
  const selectors = filter.selectors?.filter((s) => s.length > 0) ?? [];
  for (const sel of opts.strictSelectors === true ? selectors : []) {
    if (!all.some((t) => selectorMatches(sel, t))) {
      throw new AiBddError('SCENARIO_NOT_FOUND', `Selector "${sel}" matches no scenario, feature or document in the plans`, { details: { selector: sel } });
    }
  }
  const wantTags = (filter.tags ?? []).map(normTag);
  const grep = filter.grep?.toLowerCase();
  return all.filter((t) => {
    if (t.scenario.review === 'rejected') return false;
    if (selectors.length > 0 && !selectors.some((s) => selectorMatches(s, t))) return false;
    if (wantTags.length > 0) {
      const have = new Set([...t.scenario.tags, ...t.feature.tags].map(normTag));
      if (!wantTags.some((w) => have.has(w))) return false;
    }
    if (grep !== undefined && grep.length > 0 && !t.scenario.title.toLowerCase().includes(grep)) return false;
    return true;
  });
}

/** Find a scenario by exact id across plans; throws SCENARIO_NOT_FOUND. */
export function findTarget(plans: readonly DocPlan[], scenarioId: string): ScenarioTarget {
  const hit = allTargets(plans).find((t) => t.scenario.id === scenarioId);
  if (hit === undefined) throw new AiBddError('SCENARIO_NOT_FOUND', `Scenario "${scenarioId}" is not in any plan`, { details: { scenarioId } });
  return hit;
}
