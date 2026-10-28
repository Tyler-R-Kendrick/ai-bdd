import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEngine, featurePolicy, type Engine } from '../../src/index.ts';
import { makeFixture, type Fixture } from '../engine/fakes.ts';

const BILLING = 'docs-billing--billing/billing-works';
const open: { fx: Fixture; engine: Engine }[] = [];
afterEach(async () => {
  for (const { fx, engine } of open.splice(0)) {
    await engine.close();
    await rm(fx.world.tmp, { recursive: true, force: true });
  }
});

async function setup(user: Parameters<typeof makeFixture>[0] = {}) {
  const fx = await makeFixture(user);
  const engine = await createEngine(fx.config, { modules: fx.modules });
  open.push({ fx, engine });
  return { fx, engine };
}

describe('feature verification state and evidence', () => {
  it('attaches every feature and retains the last state of features not selected by a later run', async () => {
    const { engine } = await setup();
    const full = await engine.run();
    expect(full.features).toHaveLength(3);
    expect(full.features?.every((feature) => feature.status === 'passed' && feature.tests.length > 0)).toBe(true);
    expect(full.features?.every((feature) => feature.evidence.some((ref) => ref.kind === 'test-report'))).toBe(true);
    const previousTodos = full.features?.find((feature) => feature.title === 'Todos');

    const selected = await engine.run({ compile: false, selectors: [BILLING] });
    expect(selected.exitCode).toBe(0);
    const billing = selected.features?.find((feature) => feature.title === 'Billing');
    const todos = selected.features?.find((feature) => feature.title === 'Todos');
    expect(billing).toMatchObject({ selected: true, runId: selected.runId, status: 'passed' });
    expect(todos).toMatchObject({ selected: false, runId: full.runId, lastRunAt: previousTodos?.lastRunAt, status: 'passed' });
  });

  it('fails high-risk formal verification until a proof is attached, then verifies the proof in the run evidence', async () => {
    const { fx, engine } = await setup({ user: { verification: { risk: 'high', formalVerification: { high: true } } } });
    await engine.compile();
    const missing = await engine.run({ compile: false, selectors: [BILLING] });
    expect(missing.exitCode).toBe(1);
    const feature = missing.features?.find((f) => f.title === 'Billing');
    expect(feature).toMatchObject({ status: 'blocked', risk: 'high', formalVerificationRequired: true });
    expect(feature?.problems.map((p) => p.code)).toContain('FORMAL_VERIFICATION_REQUIRED');

    const dir = join(dirname(fx.config.runsDir), 'evidence', feature?.featureId ?? 'missing');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'proof.smt2'), '(assert true)\n(check-sat)\n');
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ artifacts: [{ path: 'proof.smt2', kind: 'formal-proof' }] }));
    const proven = await engine.run({ compile: false, selectors: [BILLING] });
    expect(proven.exitCode).toBe(0);
    expect(proven.features?.find((f) => f.title === 'Billing')).toMatchObject({ status: 'passed', problems: [] });
    expect(proven.features?.find((f) => f.title === 'Billing')?.evidence.some((ref) => ref.kind === 'formal-proof')).toBe(true);
  });

  it('resolves binary, risk, evidence and formal-verification overrides from feature tags', async () => {
    const { engine } = await setup();
    await engine.compile();
    const feature = (await engine.plans())[0]?.features[0];
    if (feature === undefined) throw new Error('fixture feature missing');
    feature.tags = ['@target:cli', '@risk-critical', '@evidence:log,test-report', '@formal'];
    expect(featurePolicy(feature, engine.config)).toEqual({
      target: 'cli', risk: 'critical', requiredEvidence: ['log', 'test-report'], formalVerificationRequired: true,
    });
    feature.tags = ['@library', '@no-formal'];
    expect(featurePolicy(feature, engine.config).target).toBe('library');
    expect(featurePolicy(feature, engine.config).formalVerificationRequired).toBe(false);
  });
});
