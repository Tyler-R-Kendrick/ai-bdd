import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createFakeModelSet } from '@ai-bdd/models/fake';
import { createRegistry } from '@ai-bdd/registry';
import { createSemanticResolver } from '@ai-bdd/semantic';
import { withHash, type BindingDescriptor } from '@ai-bdd/contracts';

/**
 * Attack 1: find step texts that bind to the wrong binding despite the guards.
 *
 * The corpus is generated, not hand-picked: paraphrases, negations and quantity
 * changes are produced and resolved with the deterministic fake embedder. The
 * assertion that matters: a *different* binding may never win. Coming back
 * empty-handed or ambiguous is allowed; a confident wrong binding is not.
 */
const REPO = fileURLToPath(new URL('../../', import.meta.url));

const seed: BindingDescriptor = {
  id: 'ts:local#seed-workspace',
  provider: 'ts:local',
  pattern: 'Seed a workspace {string} on the {string} plan',
  patternKind: 'cucumber-expression',
  kind: 'setup',
  description: 'Seeds a workspace with a name and a plan tier.',
  examples: ['Seed a workspace "Acme" on the "free" plan'],
  counterExamples: ['Seed an empty workspace'],
  params: [
    { name: 'name', type: 'string' },
    { name: 'plan', type: 'enum', enumValues: ['free', 'pro'] },
  ],
};

const invoices: BindingDescriptor = {
  id: 'ts:local#seed-invoices',
  provider: 'ts:local',
  pattern: 'Seed {int} unpaid invoices for {string}',
  patternKind: 'cucumber-expression',
  kind: 'setup',
  description: 'Creates unpaid invoices so the downgrade is blocked.',
  examples: ['Seed 2 unpaid invoices for "Acme"'],
  params: [
    { name: 'count', type: 'int' },
    { name: 'name', type: 'string' },
  ],
};

const reset: BindingDescriptor = {
  id: 'ts:local#reset',
  provider: 'ts:local',
  pattern: 'Reset test data',
  patternKind: 'cucumber-expression',
  kind: 'setup',
  description: 'Clears every seeded workspace, invoice and session.',
  examples: ['Reset test data'],
};

async function resolverFor() {
  const models = createFakeModelSet({ rulesPath: `${REPO}fixtures/fake-model/rules.json` });
  const registry = createRegistry();
  for (const descriptor of [seed, invoices, reset]) registry.add(descriptor);
  const semantic = createSemanticResolver({
    embedder: models.embed,
    extractor: models.extract,
    config: { threshold: 0.85, margin: 0.1 },
  });
  return { registry, semantic };
}

const workspaceNames = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Soylent', 'Vehement', 'Wayne', 'Stark'];
const plans = ['free', 'pro', 'trial', 'legacy'];

describe('attack 1: semantic mis-binding', () => {
  it('never binds a negation to the positive binding', async () => {
    const { registry, semantic } = await resolverFor();
    const set = registry.set();
    const negations = [
      'Seed an empty workspace',
      'Do not seed a workspace',
      'Never seed a workspace',
      "Don't seed a workspace",
      'Seed a workspace without a plan',
      'No workspace is seeded',
      'Seeding a workspace fails',
      'Seed none of the workspaces',
      'Seed a workspace with no invoices',
      'Reset nothing',
    ];
    for (const text of negations) {
      const resolution = await semantic.resolve({ text, kind: 'setup' }, set);
      if (resolution === null) continue;
      expect(resolution.type, text).not.toBe('semantic');
      expect(resolution.type, text).not.toBe('exact');
    }
  });

  it('never binds a quantity change to the invoice binding', async () => {
    const { registry, semantic } = await resolverFor();
    const set = registry.set();
    const quantities = [
      'Seed 0 unpaid invoices for "Acme"',
      'Seed 100 unpaid invoices for "Acme"',
      'Seed at most 2 unpaid invoices for "Acme"',
      'Seed fewer unpaid invoices for "Acme"',
      'Seed exactly 7 unpaid invoices for "Acme"',
      'Settle every unpaid invoice for "Acme"',
    ];
    for (const text of quantities) {
      const resolution = await semantic.resolve({ text, kind: 'setup' }, set);
      if (resolution === null) continue;
      if (resolution.type === 'exact') {
        expect(resolution.bindingId, text).toBe('ts:local#seed-invoices');
        continue;
      }
      expect(resolution.type, text).not.toBe('semantic');
    }
  });

  it('keeps 200 generated paraphrases away from the wrong binding', async () => {
    const { registry, semantic } = await resolverFor();
    const set = registry.set();
    const templates = [
      (name: string, plan: string) => `Seed a workspace "${name}" on the "${plan}" plan`,
      (name: string, plan: string) => `Seed a ${plan} workspace called ${name}`,
      (name: string, plan: string) => `Seed the workspace "${name}" with the ${plan} tier`,
      (name: string, plan: string) => `Create a workspace named ${name} on ${plan}`,
      (name: string, plan: string) => `Set up a ${plan} workspace for ${name}`,
      (name: string, plan: string) => `Seed a workspace for ${name} on the ${plan} tier`,
      (name: string, plan: string) => `Seed the ${plan} workspace "${name}"`,
      (name: string, plan: string) => `Seed a workspace "${name}" with the ${plan} plan`,
      (name: string, plan: string) => `Create the ${plan} workspace named ${name}`,
      (name: string, plan: string) => `Make a workspace called ${name} on the ${plan} tier`,
      (name: string, plan: string) => `Seed a ${plan} plan workspace for ${name}`,
    ];

    let inspected = 0;
    let wrong = 0;
    for (const name of workspaceNames) {
      for (const plan of plans) {
        for (const template of templates) {
          const text = template(name, plan);
          inspected += 1;
          const resolution = await semantic.resolve({ text, kind: 'setup' }, set);
          if (resolution === null || resolution.type !== 'semantic') continue;
          // The only acceptable semantic winner for a workspace sentence is the seed
          // binding; landing on the invoice or reset binding is the attack succeeding.
          if (resolution.bindingId !== 'ts:local#seed-workspace') wrong += 1;
        }
      }
    }

    expect(inspected).toBe(workspaceNames.length * plans.length * templates.length);
    expect(inspected).toBeGreaterThanOrEqual(200);
    expect(wrong, 'a paraphrase bound to a different binding').toBe(0);
  });

  it('reports a small margin instead of guessing between near-identical bindings', async () => {
    const models = createFakeModelSet({ rulesPath: `${REPO}fixtures/fake-model/rules.json` });
    const registry = createRegistry();
    const twin = withHash({
      ...seed,
      id: 'ts:local#store-workspace',
      pattern: 'Store the workspace {string} on the {string} plan',
      examples: ['Store the workspace "Acme" on the "free" plan'],
    });
    registry.add(seed);
    registry.add(twin as never);
    const semantic = createSemanticResolver({
      embedder: models.embed,
      extractor: models.extract,
      config: { threshold: 0.85, margin: 0.1 },
    });

    const resolution = await semantic.resolve(
      { text: 'Store the workspace "Acme" on the "free" plan', kind: 'setup' },
      registry.set(),
    );
    if (resolution !== null && resolution.type === 'semantic') {
      // If the resolver *does* decide, the decision must be documented as a small
      // margin, which is exactly what stops a confident wrong binding.
      expect(resolution.margin).toBeLessThan(0.1);
    }
  });

  it('rejects a candidate whose extracted parameter is not in the step text', async () => {
    const models = createFakeModelSet({
      rules: [
        {
          purpose: 'extract',
          match: { contains: ['Extract the parameters'] },
          respond: { object: { name: 'Other', plan: 'enterprise' } },
        },
      ],
    });
    const { registry } = await resolverFor();
    const semantic = createSemanticResolver({
      embedder: models.embed,
      extractor: models.extract,
      config: { threshold: 0.5, margin: 0.01 },
    });
    const resolution = await semantic.resolve(
      { text: 'Seed a workspace "Acme" on the "free" plan', kind: 'setup' },
      registry.set(),
    );
    // The model invented parameters that do not occur in the text, so the candidate is
    // rejected by the deterministic validation instead of being trusted.
    expect(resolution === null || resolution.type !== 'semantic').toBe(true);
  });
});
