import type { EffectSignature, Observation } from '../contracts/index.ts';
import { groupByKey, propertyValue } from './effect.ts';
import { normalizeText } from '../util/index.ts';

export interface EffectVerdict { ok: boolean; detail?: string }

const SEP = '\u0000';
const idOf = (key: { role: string; name: string }): string => `${key.role}${SEP}${normalizeText(key.name)}`;

/**
 * Replay-time effect verification (SPEC §10.2 step 4, R-CH7):
 * every recorded element holds in `after`, the route matches, and at least one recorded element
 * is newly true, i.e. did NOT already hold in `before`. An effect that was already present
 * before the replay therefore never verifies.
 */
export function verifyEffect(effect: EffectSignature, before: Observation, after: Observation): EffectVerdict {
  const b = groupByKey(before);
  const a = groupByKey(after);
  let newlyTrue = 0;

  for (const key of effect.appeared) {
    const id = idOf(key);
    if (!a.has(id)) return { ok: false, detail: `expected ${key.role} "${key.name}" to appear` };
    if (!b.has(id)) newlyTrue++;
  }
  for (const key of effect.disappeared) {
    const id = idOf(key);
    if (a.has(id)) return { ok: false, detail: `expected ${key.role} "${key.name}" to disappear` };
    if (b.has(id)) newlyTrue++;
  }
  for (const c of effect.changed) {
    const id = idOf(c.key);
    const afterGroup = a.get(id);
    const node = afterGroup?.length === 1 ? afterGroup[0] : undefined;
    if (node === undefined || propertyValue(node, c.state) !== c.to) {
      return { ok: false, detail: `expected ${c.key.role} "${c.key.name}" ${c.state} to be ${JSON.stringify(c.to)}` };
    }
    const heldBefore = (b.get(id) ?? []).some((n) => propertyValue(n, c.state) === c.to);
    if (!heldBefore) newlyTrue++;
  }
  if (after.route !== effect.routeAfter) {
    return { ok: false, detail: `expected route ${effect.routeAfter}, got ${after.route}` };
  }
  if (effect.routeAfter !== effect.routeBefore && before.route !== effect.routeAfter) newlyTrue++;

  if (newlyTrue === 0) return { ok: false, detail: 'no recorded effect element became newly true' };
  return { ok: true };
}
