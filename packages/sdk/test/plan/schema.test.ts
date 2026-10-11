import { describe, expect, it } from 'vitest';
import type { DocPlan, ResolvedConfig } from '../../src/contracts/index.ts';
import { createPlanner } from '../../src/plan/index.ts';
import { parseDocPlan } from '../../src/plan/schema.ts';
import { META, billingDoc, firstSectionId, mapOf, result, upgradeDraft } from './fixtures.ts';

function validPlan(): DocPlan {
  const doc = billingDoc();
  return createPlanner({} as ResolvedConfig).merge(doc, null, mapOf(result(firstSectionId(doc, 0), [upgradeDraft(doc)])), META).plan;
}

function failure(value: unknown): string {
  const r = parseDocPlan(value);
  if (r.ok) throw new Error('expected the plan to be rejected');
  return r.message;
}

describe('parseDocPlan', () => {
  it('R-PL4: accepts a planner-produced plan and returns it unchanged', () => {
    const plan = validPlan();
    const r = parseDocPlan(JSON.parse(JSON.stringify(plan)));
    expect(r).toEqual({ ok: true, plan });
  });

  it('R-PL4: optional fields explicitly set to undefined are accepted and vanish when the plan is serialized', () => {
    const plan = validPlan();
    const withUndefined = { ...plan, features: plan.features.map((f) => ({ ...f, story: undefined, description: undefined, pinned: undefined })) };
    const r = parseDocPlan(withUndefined);
    expect(r.ok).toBe(true);
    if (r.ok) expect(JSON.parse(JSON.stringify(r.plan))).toEqual(JSON.parse(JSON.stringify(plan)));
  });

  it('R-PL4: a value that is not an object is rejected at the root', () => {
    expect(failure(null)).toMatch(/^invalid plan at \(root\): /);
    expect(failure([])).toMatch(/^invalid plan at \(root\): /);
    expect(failure('plan')).toMatch(/^invalid plan at \(root\): /);
    expect(failure(undefined)).toMatch(/^invalid plan at \(root\): /);
  });

  it('R-PL4: an unknown top-level key is rejected and named (the schema is strict)', () => {
    const message = failure({ ...validPlan(), extra: 1 });
    expect(message).toMatch(/^invalid plan at \(root\): /);
    expect(message).toContain('"extra"');
  });

  it('R-PL4: the message points at the first offending field by its dotted path', () => {
    expect(failure({ ...validPlan(), schemaVersion: 2 })).toMatch(/^invalid plan at schemaVersion: /);
    expect(failure({ ...validPlan(), uncovered: [1] })).toMatch(/^invalid plan at uncovered\.0: /);
    const plan = validPlan();
    const scenario = plan.features[0]?.scenarios[0];
    const broken = { ...plan, features: [{ ...plan.features[0], scenarios: [{ ...scenario, title: 5 }] }] };
    expect(failure(broken)).toMatch(/^invalid plan at features\.0\.scenarios\.0\.title: /);
  });

  it('R-PL4: missing required fields are rejected', () => {
    for (const key of ['docUri', 'docSha256', 'extractor', 'sections', 'chunks', 'features', 'notTestable', 'rejected', 'uncovered'] as const) {
      const { [key]: _omitted, ...rest } = validPlan();
      expect(failure(rest), key).toMatch(new RegExp(`^invalid plan at ${key}: `));
    }
  });

  it('R-PL4: an empty docUri is rejected', () => {
    expect(failure({ ...validPlan(), docUri: '' })).toMatch(/^invalid plan at docUri: /);
  });
});
