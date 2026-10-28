import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createEngine, createPlanner, type Engine } from '@ai-bdd/sdk';
import { gherkin, GHERKIN_EXTENSION_ID } from '../src/index.ts';
import { makeFixture, type Fixture } from '../../sdk/test/engine/fakes.ts';

const DOCUMENT = `@web
Feature: Account upgrade
  Background:
    Given a registered customer

  Scenario: Upgrade once
    When the customer upgrades
    Then the plan is Pro

  Rule: Trials
    Scenario Outline: Upgrade <plan>
      When the customer chooses <plan>
      Then the plan is <plan>

      Examples:
        | plan |
        | Pro  |
        | Team |
`;

const open: { fx: Fixture; engine: Engine }[] = [];
afterEach(async () => {
  for (const { fx, engine } of open.splice(0)) {
    await engine.close();
    await rm(fx.world.tmp, { recursive: true, force: true });
  }
});

async function setup(text = DOCUMENT) {
  const fx = await makeFixture({
    docs: { 'docs/account.feature': text },
    user: { docs: ['docs/**/*.feature'], extensions: [gherkin()] },
  });
  const engine = await createEngine(fx.config, { modules: { ...fx.modules, createPlanner: (config) => createPlanner(config) } });
  open.push({ fx, engine });
  return { fx, engine };
}

describe('official Cucumber Gherkin document extension', () => {
  it('compiles Background, Rules and Scenario Outlines to grounded plans without an extraction model', async () => {
    const { fx, engine } = await setup();
    const compiled = await engine.compile();
    expect(compiled.exitCode).toBe(0);
    expect(compiled.usage.modelCalls).toBe(0);
    expect(fx.world.modelCalls.filter((call) => call.purpose === 'extract')).toHaveLength(0);

    const plans = await engine.plans();
    expect(plans).toHaveLength(1);
    const feature = plans[0]?.features[0];
    expect(feature?.title).toBe('Account upgrade');
    expect(feature?.tags).toEqual(['@web']);
    expect(feature?.scenarios.map((scenario) => scenario.title)).toEqual(['Upgrade once', 'Upgrade Pro', 'Upgrade Team']);
    expect(feature?.scenarios[0]?.steps.map((step) => [step.kind, step.text])).toEqual([
      ['given', 'a registered customer'], ['when', 'the customer upgrades'], ['then', 'the plan is Pro'],
    ]);
    expect(feature?.scenarios[2]?.steps.at(-1)?.text).toBe('the plan is Team');
    expect(plans[0]?.extractor.modelId).toBe(GHERKIN_EXTENSION_ID);
    for (const scenario of feature?.scenarios ?? []) {
      expect(scenario.sources.length).toBeGreaterThan(0);
      expect(scenario.steps.every((step) => step.grounding === 'quoted' && step.sources.length > 0)).toBe(true);
    }

    const fresh = await engine.compile({ check: true });
    expect(fresh.exitCode).toBe(0);
  });

  it('runs expanded scenarios and attaches test state and required evidence to their feature', async () => {
    const { engine } = await setup();
    const report = await engine.run();
    expect(report.exitCode).toBe(0);
    expect(report.scenarios).toHaveLength(3);
    expect(report.features).toHaveLength(1);
    expect(report.features?.[0]).toMatchObject({
      title: 'Account upgrade', status: 'passed', selected: true, target: 'web', risk: 'medium',
    });
    expect(report.features?.[0]?.tests).toHaveLength(3);
    expect(new Set(report.features?.[0]?.evidence.map((ref) => ref.kind))).toEqual(new Set(['observation', 'screenshot', 'test-report']));
    expect(report.features?.[0]?.runId).toBe(report.runId);
  });

  it('fails a documented feature that has no associated executable test', async () => {
    const { engine } = await setup('Feature: Documentation only\n  A feature without scenarios is not verified.');
    const report = await engine.run();
    expect(report.exitCode).toBe(1);
    expect(report.scenarios).toHaveLength(0);
    expect(report.features?.[0]).toMatchObject({ title: 'Documentation only', status: 'blocked', selected: true, tests: [] });
    expect(report.features?.[0]?.problems.map((problem) => problem.code)).toContain('TEST_REQUIRED');
  });

  it('reports invalid Gherkin as a document error and never calls a model', async () => {
    const { fx, engine } = await setup('Feature: broken\n  Scenario: bad table\n    Given a table\n      | a | b |\n      | c |');
    const compiled = await engine.compile();
    expect(compiled.exitCode).not.toBe(0);
    expect(compiled.usage.modelCalls).toBe(0);
    expect(fx.world.modelCalls).toHaveLength(0);
    expect(compiled.docs[0]?.diagnostics.some((d) => d.message.includes('invalid Gherkin'))).toBe(true);
  });
});
