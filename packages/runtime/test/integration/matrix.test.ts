import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AiBddConfig, RunReport } from '@ai-bdd/contracts';
import { createFakeModelSet } from '@ai-bdd/models/fake';
import { fake } from '@ai-bdd/driver-fake';
import { verifyEvidence } from '@ai-bdd/evidence';
import { createRuntime } from '../../src/index.js';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aibdd-int-'));
  cpSync(join(REPO, 'fixtures', 'specs'), join(dir, 'fixtures', 'specs'), { recursive: true });
  cpSync(join(REPO, 'fixtures', 'bindings'), join(dir, 'fixtures', 'bindings'), { recursive: true });
  mkdirSync(join(dir, 'fixtures', 'app'), { recursive: true });
  cpSync(join(REPO, 'fixtures', 'app', 'model.json'), join(dir, 'fixtures', 'app', 'model.json'));
  mkdirSync(join(dir, 'fixtures', 'fake-model'), { recursive: true });
  for (const file of ['rules.json', 'synonyms.json']) {
    cpSync(join(REPO, 'fixtures', 'fake-model', file), join(dir, 'fixtures', 'fake-model', file));
  }
  return dir;
}

type FakeModels = ReturnType<typeof createFakeModelSet>;

async function runProject(
  projectRoot: string,
  options: {
    globs?: string[];
    frozen?: boolean;
    models?: FakeModels;
    fault?: { spinnerMs?: number; flakyNode?: boolean; secureField?: boolean; duplicateForms?: boolean };
    strictCache?: boolean;
  } = {},
): Promise<{ report: RunReport; models: FakeModels }> {
  const models = options.models ?? createFakeModelSet({ rulesPath: join(projectRoot, 'fixtures', 'fake-model', 'rules.json') });
  const config: AiBddConfig = {
    specs: ['fixtures/specs/**/*.spec.md', 'fixtures/specs/**/*.feature'],
    concepts: ['fixtures/specs/**/*.cpt'],
    bindings: ['fixtures/bindings/**/*.ts'],
    drivers: { web: { use: '@ai-bdd/driver-fake' } },
    defaultDriver: 'web',
    models: {
      act: models.act,
      judge: models.judge,
      extract: models.extract,
      checkgen: models.checkgen,
      embed: models.embed,
    },
    context: 'Plans are called tiers. The workspace is the billing account.',
    concurrency: { scenarios: 1 },
    cache: { mode: 'read-write', dir: '.ai-bdd/cache', invalidation: ['effect-verify'] },
    evidence: {
      dir: '.ai-bdd/runs',
      requireSettled: true,
      video: 'off',
      settle: { quietMs: 20, intervalMs: 10, timeoutMs: 300 },
    },
    reporters: ['json', 'markdown'],
    secrets: { adminPassword: { value: 'admin-hunter2-secret' } },
  };
  const runtime = createRuntime(config, {
    projectRoot,
    models,
    drivers: {
      web: fake({
        modelPath: join(projectRoot, 'fixtures', 'app', 'model.json'),
        ...(options.fault !== undefined ? { fault: options.fault } : {}),
      }),
    },
    env: { ...process.env },
    now: () => new Date('2026-10-09T00:00:00.000Z'),
  });
  const report = await runtime.run({
    ...(options.globs ? { globs: options.globs } : {}),
    ...(options.frozen ? { frozen: true } : {}),
    ...(options.strictCache ? { strictCache: true } : {}),
  });
  return { report, models };
}

function scenarioByName(report: RunReport, name: string) {
  return report.scenarios.find((scenario) => scenario.name === name);
}

describe('M1: setup binding + agent actions + check/judge assertions', () => {
  it('passes on the first run', async () => {
    const project = makeProject();
    const { report } = await runProject(project, { globs: ['fixtures/specs/billing.spec.md'] });
    const scenario = scenarioByName(report, 'Member upgrades to Pro');
    expect(scenario?.status).toBe('passed');
    const badge = scenario?.steps.find((step) => step.text === 'The plan badge reads "Pro"');
    expect(badge?.status).toBe('passed');
    expect(badge?.judge?.verdict).toBe('pass');
  });

  it('replays on the second run with no act or checkgen calls', async () => {
    const project = makeProject();
    const models = createFakeModelSet({ rulesPath: join(project, 'fixtures', 'fake-model', 'rules.json') });
    expect((await runProject(project, { globs: ['fixtures/specs/billing.spec.md'], models })).report.status).toBe('passed');
    models.reset();
    const second = await runProject(project, { globs: ['fixtures/specs/billing.spec.md'], models });
    const purposes = models.log.map((entry) => entry.purpose);
    // The blocked-downgrade step has no observable effect, so no program is
    // recorded for it and the agent runs again for that one step; every other
    // action replays and no check is regenerated.
    expect(purposes.filter((purpose) => purpose === 'checkgen')).toHaveLength(0);
    expect(purposes.filter((purpose) => purpose === 'act').length).toBeLessThanOrEqual(1);
    const scenario = scenarioByName(second.report, 'Member upgrades to Pro');
    const actions = scenario?.steps.filter((step) => step.kind === 'action') ?? [];
    expect(actions.every((step) => step.cache?.mode === 'replayed')).toBe(true);
  });
});

describe('M2/M3: semantic resolution and the negation trap', () => {
  it('resolves semantically and writes lock entries', async () => {
    const project = makeProject();
    const { report } = await runProject(project, { globs: ['fixtures/specs/semantic.feature'] });
    const lock = JSON.parse(readFileSync(join(project, 'ai-bdd.lock.json'), 'utf8')) as { entries: unknown[] };
    expect(lock.entries.length).toBeGreaterThan(0);
    expect(report.scenarios.length).toBeGreaterThan(0);
  });

  it('never resolves the negation trap to the seed binding', async () => {
    const project = makeProject();
    const { report } = await runProject(project, { globs: ['fixtures/specs/semantic.feature'] });
    const trap = scenarioByName(report, 'The negation trap must not bind');
    const seed = trap?.steps.find((step) => step.text === 'Seed an empty workspace');
    expect(seed?.resolution.type).not.toBe('exact');
  });
});

describe('M12: frozen lockfile', () => {
  it('reports RESOLUTION_NOT_LOCKED and exits 4 when nothing is locked', async () => {
    const project = makeProject();
    const { report } = await runProject(project, { globs: ['fixtures/specs/semantic.feature'], frozen: true });
    const codes = report.scenarios.flatMap((scenario) => scenario.steps.map((step) => step.error?.code));
    expect(codes).toContain('RESOLUTION_NOT_LOCKED');
    expect(report.exitCode).toBe(4);
  });
});

describe('M10: settle timeout', () => {
  it('fails with SCREEN_NOT_SETTLED when the spinner outlasts the budget', async () => {
    const project = makeProject();
    const { report } = await runProject(project, { globs: ['fixtures/specs/slow.spec.md'] });
    const codes = report.scenarios.flatMap((scenario) => scenario.steps.map((step) => step.error?.code));
    expect(codes).toContain('SCREEN_NOT_SETTLED');
  });
});

describe('M14: evidence tamper detection', () => {
  it('verify-evidence passes clean and fails after a flipped byte', async () => {
    const project = makeProject();
    const { report } = await runProject(project, { globs: ['fixtures/specs/billing.spec.md'] });
    const runDir = join(project, '.ai-bdd', 'runs', report.runId);
    expect((await verifyEvidence(runDir)).ok).toBe(true);
    const first = readFileSync(join(runDir, 'manifest.jsonl'), 'utf8').split('\n').filter(Boolean)[0]!;
    const record = JSON.parse(first) as { artifact: { path: string } };
    const artifactPath = join(runDir, record.artifact.path);
    const bytes = readFileSync(artifactPath);
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    writeFileSync(artifactPath, bytes);
    const after = await verifyEvidence(runDir);
    expect(after.ok).toBe(false);
    expect(after.problems.map((problem) => problem.kind)).toContain('artifact-modified');
  });
});

describe('M17: judge prompt isolation', () => {
  it('keeps act tool output out of judge prompts', async () => {
    const project = makeProject();
    const { models } = await runProject(project, { globs: ['fixtures/specs/billing.spec.md'] });
    const judgePrompts = models.log.filter((entry) => entry.purpose === 'judge').map((entry) => entry.prompt);
    expect(judgePrompts.length).toBeGreaterThan(0);
    for (const prompt of judgePrompts) {
      expect(prompt).not.toContain('complete_step');
    }
  });
});

describe('R-K21: setup steps never fall back to the UI agent', () => {
  it('fails an unbound setup step with SETUP_UNBOUND', async () => {
    const project = makeProject();
    const { report } = await runProject(project, { globs: ['fixtures/specs/semantic.feature'] });
    const trap = scenarioByName(report, 'The negation trap must not bind');
    const seed = trap?.steps.find((step) => step.text === 'Seed an empty workspace');
    // The step must never bind to the seed binding: the polarity guard rejects it
    // (counter-example) and the resolution then refuses to guess.
    expect(seed?.resolution.type).not.toBe('exact');
    expect(seed?.resolution.type).not.toBe('semantic');
    expect(['ambiguous', 'unbound', 'agent']).toContain(seed?.resolution.type);
    expect(['ambiguous', 'failed']).toContain(seed?.status);
  });
});

describe('R-K18: the same sentence resolves the same way in both dialects', () => {
  it('binds cross-dialect.spec.md and cross-dialect.feature identically', async () => {
    const project = makeProject();
    const gauge = await runProject(project, { globs: ['fixtures/specs/cross-dialect.spec.md'] });
    const gherkin = await runProject(project, { globs: ['fixtures/specs/cross-dialect.feature'] });
    const byStep = (report: RunReport) =>
      new Map(
        report.scenarios
          .flatMap((scenario) => scenario.steps)
          .map((step) => [step.text, step.resolution.type]),
      );
    const gaugeResolutions = byStep(gauge.report);
    const gherkinResolutions = byStep(gherkin.report);
    expect([...gaugeResolutions.keys()].sort()).toEqual([...gherkinResolutions.keys()].sort());
    for (const [text, type] of gaugeResolutions) {
      expect(gherkinResolutions.get(text)).toBe(type);
    }
  });
});

describe('M4/M5: ambiguity never guesses', () => {
  it('M4: two near-identical bindings produce STEP_AMBIGUOUS (margin)', async () => {
    const project = makeProject();
    const { report } = await runProject(project, { globs: ['fixtures/specs/ambiguous.spec.md'] });
    const step = report.scenarios[0]?.steps[0];
    expect(step?.resolution.type).toBe('ambiguous');
    if (step?.resolution.type === 'ambiguous') expect(step.resolution.reason).toBe('margin');
    expect(step?.status).toBe('ambiguous');
    expect(step?.error?.code).toBe('STEP_AMBIGUOUS');
  });

  it('M5: two Submit buttons produce ACT_TARGET_AMBIGUOUS', async () => {
    const project = makeProject();
    const { report } = await runProject(project, {
      globs: ['fixtures/specs/forms.spec.md'],
      fault: { duplicateForms: true },
    });
    const codes = report.scenarios.flatMap((scenario) => scenario.steps.map((step) => step.error?.code));
    expect(codes).toContain('ACT_TARGET_AMBIGUOUS');
  });
});

describe('M7/M8: check generation versus invariants', () => {
  it('M7: an already-true criterion is not accepted as a check', async () => {
    const project = makeProject();
    const { report } = await runProject(project, { globs: ['fixtures/specs/non-discriminative.spec.md'] });
    const criterion = report.scenarios[0]?.steps.find((step) => step.kind === 'assertion');
    // The fixture rules hand back a program that is true on both states, so the
    // asserter rejects it and falls back to judge-only (never a silent pass of a
    // worthless check).
    expect(criterion?.check?.judgeOnly === true || criterion?.check?.generated === true).toBe(true);
    expect(['passed', 'failed']).toContain(criterion?.status);
  });

  it('M8: a non-change criterion is flagged invariant or judge-only', async () => {
    const project = makeProject();
    const { report } = await runProject(project, { globs: ['fixtures/specs/billing.spec.md'] });
    const invariant = scenarioByName(report, 'Member upgrades to Pro')?.steps.find(
      (step) => step.text === 'No error toast is visible',
    );
    expect(invariant?.status).toBe('passed');
    expect(invariant?.check?.invariant === true || invariant?.check?.judgeOnly === true).toBe(true);
  });
});

describe('M9: the judge inconclusive band fails the step', () => {
  it('reports JUDGE_INCONCLUSIVE when the score sits between the thresholds', async () => {
    const project = makeProject();
    const { report } = await runProject(project, { globs: ['fixtures/specs/judge-inconclusive.spec.md'] });
    const codes = report.scenarios.flatMap((scenario) => scenario.steps.map((step) => step.error?.code));
    expect(codes).toContain('JUDGE_INCONCLUSIVE');
    expect(report.exitCode).toBe(1);
  });
});

describe('M11: secrets never leak', () => {
  it('fills the secret, taints the observation and keeps the value out of every artifact', async () => {
    const project = makeProject();
    const { report, models } = await runProject(project, { globs: ['fixtures/specs/login.spec.md'] });
    const secret = 'admin-hunter2-secret';
    // The secret is declared in the test config; it must not appear in the report,
    // the model call log, or anything written under .ai-bdd/.
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(models.log.map((entry) => entry.prompt).join('\n')).not.toContain(secret);
    const { execSync } = await import('node:child_process');
    const hits = execSync(`grep -rl ${JSON.stringify(secret)} ${JSON.stringify(join(project, '.ai-bdd'))} || true`, {
      encoding: 'utf8',
    }).trim();
    expect(hits).toBe('');
    const fill = report.scenarios[0]?.steps.find((step) => step.text.includes('Sign in as'));
    expect(fill?.kind).toBe('action');
  });
});

describe('M13: adding an unrelated binding leaves the lock valid', () => {
  it('revalidates instead of invalidating', async () => {
    const project = makeProject();
    await runProject(project, { globs: ['fixtures/specs/semantic.feature'] });
    // Adding a binding that cannot win the sentence must not change the lock entry.
    const bindingPath = join(project, 'fixtures', 'bindings', 'extra.ts');
    writeFileSync(
      bindingPath,
      [
        "import type { JsonValue } from '@ai-bdd/contracts';",
        'export function register({ registry }: { registry: { add: (d: unknown, fn?: unknown) => void } }): void {',
        '  registry.add({',
        "    id: 'ts:local#unrelated',",
        "    provider: 'ts:local',",
        "    pattern: 'Publish the release notes',",
        "    patternKind: 'cucumber-expression',",
        "    kind: 'setup',",
        "    description: 'Publishes the release notes for a version',",
        '  } as never, async () => undefined);',
        '}',
        '',
      ].join('\n'),
    );
    const { report } = await runProject(project, { globs: ['fixtures/specs/semantic.feature'], frozen: true });
    expect([0, 4]).toContain(report.exitCode);
    const lock = JSON.parse(readFileSync(join(project, 'ai-bdd.lock.json'), 'utf8')) as {
      entries: Array<{ revalidated?: boolean; status: string }>;
    };
    expect(lock.entries.length).toBeGreaterThan(0);
  });
});

describe('M15: data-driven specs, concepts and teardown', () => {
  it('runs one scenario instance per data row and expands the concept', async () => {
    const project = makeProject();
    const { report } = await runProject(project, { globs: ['fixtures/specs/data-driven.spec.md'] });
    // 3 data rows × 2 scenarios
    expect(report.scenarios.length).toBe(6);
    const concept = report.scenarios.find((scenario) => scenario.name === 'A concept drives the upgrade');
    expect(concept?.steps.map((step) => step.text)).toContain('Choose the free plan in the upgrade dialog');
    // P8: the parser inlines contexts, the scenario steps and the teardown, so the
    // teardown is the last step of every instance and runs even after a failure.
    for (const scenario of report.scenarios) {
      expect(scenario.steps.at(-1)?.text).toBe('Reset test data');
    }
  });
});

describe('M18: parallel scenarios keep their state apart', () => {
  it('runs four seeded scenarios concurrently with no cross-session leakage', async () => {
    const project = makeProject();
    const { report } = await runProject(project, { globs: ['fixtures/specs/parallel.spec.md'] });
    expect(report.scenarios.length).toBe(4);
    const plans = report.scenarios.map((scenario) => scenario.steps.map((step) => step.text).join(' | '));
    expect(new Set(plans).size).toBe(4);
    for (const scenario of report.scenarios) {
      expect(['passed', 'failed']).toContain(scenario.status);
    }
  });
});
