// @ts-nocheck
import type { DocPlan, Feature, Scenario, ScenarioFilter } from '@ai-bdd/sdk/contracts';

export interface FeatureGroup {
  plan: DocPlan;
  feature: Feature;
  scenarios: Scenario[];
}

/** Converts a posix glob (`*`, `**`, `?`) to an anchored regular expression. */
export function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob.charAt(i);
    if (ch === '*') {
      if (glob.charAt(i + 1) === '*') {
        if (glob.charAt(i + 2) === '/') {
          source += '(?:.*/)?';
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (ch === '?') {
      source += '[^/]';
    } else {
      source += ch.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

export function normalizeTag(tag: string): string {
  return tag.trim().replace(/^@+/, '');
}

function matchesSelector(selector: string, plan: DocPlan, scenario: Scenario): boolean {
  if (selector === scenario.id) return true;
  if ((selector.endsWith('/') || selector.endsWith('--')) && scenario.id.startsWith(selector)) return true;
  if (selector === plan.docUri) return true;
  return globToRegExp(selector).test(plan.docUri);
}

function matchesFilter(filter: ScenarioFilter | undefined, plan: DocPlan, scenario: Scenario): boolean {
  if (filter === undefined) return true;
  const { selectors, tags, grep } = filter;
  if (selectors !== undefined && selectors.length > 0 && !selectors.some((s) => matchesSelector(s, plan, scenario))) {
    return false;
  }
  if (tags !== undefined && tags.length > 0) {
    const wanted = new Set(tags.map(normalizeTag));
    if (!scenario.tags.some((t) => wanted.has(normalizeTag(t)))) return false;
  }
  if (grep !== undefined && grep.length > 0 && !scenario.title.toLowerCase().includes(grep.toLowerCase())) {
    return false;
  }
  return true;
}

/**
 * Pure selection over already loaded plans: drops rejected scenarios, applies the filter and keeps plan order
 * (plans arrive sorted by docUri from `loadPlansSync`). Features left without scenarios are omitted.
 */
export function selectScenarios(plans: readonly DocPlan[], filter?: ScenarioFilter): FeatureGroup[] {
  const groups: FeatureGroup[] = [];
  for (const plan of plans) {
    for (const feature of plan.features) {
      if (feature.review === 'rejected') continue;
      const scenarios = feature.scenarios.filter((s) => s.review !== 'rejected' && matchesFilter(filter, plan, s));
      if (scenarios.length > 0) groups.push({ plan, feature, scenarios });
    }
  }
  return groups;
}
