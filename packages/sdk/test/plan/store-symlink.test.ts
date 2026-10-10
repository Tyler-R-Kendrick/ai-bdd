import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DocPlan, ResolvedConfig } from '../../src/contracts/index.ts';
import { createPlanStore, createPlanner } from '../../src/plan/index.ts';
import { META, billingDoc, firstSectionId, mapOf, result, upgradeDraft } from './fixtures.ts';

let project: string;
let outside: string;
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'ai-bdd-plan-link-'));
  outside = mkdtempSync(join(tmpdir(), 'ai-bdd-plan-outside-'));
  mkdirSync(join(project, '.ai-bdd'));
});
afterEach(() => {
  rmSync(project, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function samplePlan(): DocPlan {
  const doc = billingDoc();
  const plan = createPlanner({} as ResolvedConfig).merge(doc, null, mapOf(result(firstSectionId(doc, 0), [upgradeDraft(doc)])), META).plan;
  return { ...plan, docUri: 'docs/billing.md' };
}

describe('the plan store never writes out of the project through a symlinked plans directory', () => {
  it('.ai-bdd/plans -> a directory outside the project: save is refused with POLICY_DENIED and nothing is written there', async () => {
    symlinkSync(outside, join(project, '.ai-bdd', 'plans'));
    const store = createPlanStore({ dir: join(project, '.ai-bdd', 'plans'), readOnly: false });
    await expect(store.save(samplePlan())).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(readdirSync(outside)).toEqual([]);
  });

  it('a symlink below the plans directory that leads out is refused as before', async () => {
    mkdirSync(join(project, '.ai-bdd', 'plans'));
    symlinkSync(outside, join(project, '.ai-bdd', 'plans', 'docs'));
    const store = createPlanStore({ dir: join(project, '.ai-bdd', 'plans'), readOnly: false });
    await expect(store.save(samplePlan())).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(readdirSync(outside)).toEqual([]);
  });

  it('an ordinary plans directory still works, and saving sweeps the debris of a killed writer next to it', async () => {
    const dir = join(project, '.ai-bdd', 'plans');
    mkdirSync(join(dir, 'docs'), { recursive: true });
    const dead = 2 ** 22 + 12345; // beyond the default pid range: certainly no such process
    const debris = `billing.md.plan.json.${dead}.6c9a874a-6f0c-46b7-af7a-151f83570bc0.tmp`;
    writeFileSync(join(dir, 'docs', debris), '{"half');
    const store = createPlanStore({ dir, readOnly: false });
    await store.save(samplePlan());
    expect(readdirSync(join(dir, 'docs'))).toEqual(['billing.md.plan.json']);
  });
});
