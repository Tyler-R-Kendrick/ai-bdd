/**
 * Fixture setup bindings for the billing corpus.
 *
 * Only setup steps are bound on purpose: every action and assertion in the
 * corpus is left unbound so it exercises the agent act path, the check generator
 * and the judge. The bindings call the fixture app's test API, which is also the
 * data-seeding pattern the docs recommend for flake-free runs.
 */
import type { JsonValue } from '@ai-bdd/contracts';

export interface BindingEndpoint {
  baseUrl: string;
  token: string;
}

export const DEFAULT_ENDPOINT: BindingEndpoint = {
  baseUrl: process.env.AI_BDD_APP_URL ?? 'http://127.0.0.1:3000',
  token: process.env.AI_BDD_TEST_TOKEN ?? 'ai-bdd-test',
};

export interface RegistrationContext {
  registry: {
    add: (descriptor: Record<string, JsonValue>, fn?: unknown) => void;
    addRemote?: (provider: string, descriptors: Array<Record<string, JsonValue>>) => void;
  };
  config: { hooks?: Record<string, unknown> };
}

async function seedWorkspace(endpoint: BindingEndpoint, params: Record<string, JsonValue>): Promise<void> {
  await post(endpoint, '/__test/seed', {
    workspace: String(params.name ?? params.workspace ?? ''),
    plan: String(params.plan ?? 'free'),
  });
}

async function seedUnpaid(endpoint: BindingEndpoint, params: Record<string, JsonValue>): Promise<void> {
  await post(endpoint, '/__test/seed', {
    workspace: String(params.name ?? params.workspace ?? 'Acme'),
    unpaid: Number(params.count ?? 1),
  });
}

async function resetData(endpoint: BindingEndpoint): Promise<void> {
  await post(endpoint, '/__test/reset', {});
}

async function post(endpoint: BindingEndpoint, path: string, body: Record<string, JsonValue>): Promise<void> {
  const response = await fetch(`${endpoint.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-token': endpoint.token },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} failed with ${response.status}`);
}

/**
 * Registers the fixture bindings. `register` is the documented entry point the
 * runtime calls for every file matched by `config.bindings`.
 *
 * The bindings are wrapped so that a run against the fake driver (no HTTP app)
 * still succeeds: the fake driver already knows the seeded state through its
 * own navigation parameters, so a connection failure is tolerated here and
 * reported as a note rather than a step failure.
 */
interface SeedContext {
  session?: { driverId?: string; seedState?: (seed: Record<string, unknown>) => void };
}

/** Seeds the driver itself when it supports it (the fake driver does). */
function seedDriver(ctx: unknown, seed: Record<string, unknown>): void {
  const session = (ctx as SeedContext | undefined)?.session;
  session?.seedState?.(seed);
}

export function register({ registry }: RegistrationContext): void {
  const endpoint = DEFAULT_ENDPOINT;
  const tolerant = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch {
      // The fixture app is optional for fake-driver runs.
    }
  };

  registry.add(
    {
      id: 'ts:local#seed-workspace',
      provider: 'ts:local',
      pattern: 'Seed a workspace {string} on the {string} plan',
      patternKind: 'cucumber-expression',
      kind: 'setup',
      description: 'Seeds a workspace with a name and a plan tier.',
      examples: [
        'Seed a workspace "Acme" on the "free" plan',
        // Two teams bind the same sentence and both list it as an example; the
        // margin then decides, and M4 requires that decision to be ambiguous.
        'Store the workspace "Acme" on the "free" plan',
      ],
      counterExamples: ['Seed an empty workspace'],
      params: [
        { name: 'name', type: 'string' },
        { name: 'plan', type: 'enum', enumValues: ['free', 'pro'] },
      ],
    } as never,
    async (params: Record<string, JsonValue>, ctx: unknown) => {
      seedDriver(ctx, { workspace: String(params.name ?? ''), plan: String(params.plan ?? 'free') });
      return tolerant(() => seedWorkspace(endpoint, params));
    },
  );

  registry.add(
    {
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
    } as never,
    async (params: Record<string, JsonValue>, ctx: unknown) => {
      seedDriver(ctx, { unpaid: Number(params.count ?? 1), workspace: String(params.name ?? 'Acme') });
      return tolerant(() => seedUnpaid(endpoint, params));
    },
  );

  registry.add(
    {
      id: 'ts:local#reset',
      provider: 'ts:local',
      pattern: 'Reset test data',
      patternKind: 'cucumber-expression',
      kind: 'setup',
      description: 'Clears every seeded workspace, invoice and session.',
      examples: ['Reset test data'],
    } as never,
    async (_params: Record<string, JsonValue>, ctx: unknown) => {
      seedDriver(ctx, { plan: 'free', unpaid: 0, workspace: null, dialog: null, toast: null });
      return tolerant(() => resetData(endpoint));
    },
  );

  // The deliberate near-twin used by the margin-ambiguity case (M4): it is
  // semantically almost identical to the seed binding on purpose.
  registry.add(
    {
      id: 'ts:local#store-workspace',
      provider: 'ts:local',
      // Deliberately a paraphrase, not a pattern match: the step under test is
      // "Store the workspace "Acme" on the "free" plan", which must therefore be
      // decided by the semantic margin and come out ambiguous (M4).
      pattern: 'Stash a workspace {string} for the {string} plan',
      patternKind: 'cucumber-expression',
      kind: 'setup',
      description: 'Seeds a workspace with a name and a plan tier.',
      examples: [
        'Stash a workspace "Acme" for the "free" plan',
        'Store the workspace "Acme" on the "free" plan',
      ],
      params: [
        { name: 'name', type: 'string' },
        { name: 'plan', type: 'enum', enumValues: ['free', 'pro'] },
      ],
    } as never,
    async (params: Record<string, JsonValue>) => tolerant(() => seedWorkspace(endpoint, params)),
  );
}
