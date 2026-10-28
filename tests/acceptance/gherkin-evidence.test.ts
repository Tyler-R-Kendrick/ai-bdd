import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunReport } from '@ai-bdd/sdk/contracts';
import { cliOutput, runCli } from './helpers/cli.ts';
import { createProject, FAST_REAL, type Project } from './helpers/project.ts';
import { latestRunDir, readManifest } from './helpers/runs.ts';

const FEATURE = `@web @risk:high @formal
Feature: Upgrade to Pro
  Scenario: A customer upgrades
    When the customer clicks the upgrade button
    Then the confirmation dialog shows the prorated charge
    When the customer confirms the upgrade
    Then the plan changes to Pro
    And the invoice preview shows the prorated amount
    And an upgrade confirmation message appears
`;

let project: Project | undefined;
afterEach(() => {
  project?.cleanup();
  project = undefined;
});

function report(p: Project): RunReport {
  return JSON.parse(readFileSync(p.path('.ai-bdd', 'report', 'report.json'), 'utf8')) as RunReport;
}

describe('Gherkin PDD to verified evidence end to end', () => {
  it('compiles formally, enforces proof evidence, replays without models, and verifies every artifact', async () => {
    const p = createProject({ docs: [], options: FAST_REAL });
    project = p;
    writeFileSync(p.path('docs', 'upgrade.feature'), FEATURE);
    writeFileSync(p.path('ai-bdd.config.gherkin.mjs'), `import { defineConfig } from '@ai-bdd/sdk';
import { gherkin } from '@ai-bdd/gherkin';
import { createFakeModels, fakeDriver } from '@ai-bdd/testing';
export default defineConfig({
  docs: ['docs/**/*.feature'],
  extensions: [gherkin()],
  baseURL: 'http://localhost:4173',
  drivers: { fake: fakeDriver() }, defaultDriver: 'fake',
  models: createFakeModels({ rulesDir: ${JSON.stringify(p.rulesDir)}, logPath: ${JSON.stringify(p.logPath)} }),
  secrets: { adminPassword: { env: 'ACME_ADMIN_PASSWORD' } },
  context: 'Acme billing application',
  characterize: { probeMs: 100 }, settle: { quietMs: 100, intervalMs: 30, timeoutMs: 5000 },
});
`);
    const config = 'ai-bdd.config.gherkin.mjs';
    const compiled = await runCli(p, ['compile'], { config });
    expect(compiled.code, cliOutput(compiled)).toBe(0);
    const first = await runCli(p, ['run'], { config });
    expect(first.code, cliOutput(first)).toBe(1);
    const missing = report(p);
    expect(missing.scenarios.map((s) => s.status)).toEqual(['passed']);
    expect(missing.features?.[0]?.problems.map((problem) => problem.code)).toEqual(['FORMAL_VERIFICATION_REQUIRED']);
    expect(missing.features?.[0]?.tests).toHaveLength(1);

    const featureId = missing.features?.[0]?.featureId;
    if (featureId === undefined) throw new Error('feature result missing');
    const evidenceDir = p.path('.ai-bdd', 'evidence', ...featureId.split('/'));
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, 'proof.smt2'), '(assert true)\n(check-sat)\n');
    writeFileSync(join(evidenceDir, 'manifest.json'), JSON.stringify({ artifacts: [{ path: 'proof.smt2', kind: 'formal-proof' }] }));

    const callsBefore = readFileSync(p.logPath, 'utf8').split('\n').filter(Boolean).length;
    const replay = await runCli(p, ['run', '--frozen', '--no-agent'], { config });
    expect(replay.code, cliOutput(replay)).toBe(0);
    const proven = report(p);
    expect(proven.features?.[0]).toMatchObject({ status: 'passed', risk: 'high', formalVerificationRequired: true, problems: [] });
    expect(proven.features?.[0]?.evidence.some((ref) => ref.kind === 'formal-proof')).toBe(true);
    expect(proven.features?.[0]?.evidence.some((ref) => ref.kind === 'screenshot')).toBe(true);
    expect(proven.features?.[0]?.evidence.some((ref) => ref.kind === 'test-report')).toBe(true);
    const callsAfter = readFileSync(p.logPath, 'utf8').split('\n').filter(Boolean).length;
    expect(callsAfter).toBe(callsBefore);

    const runDir = latestRunDir(p);
    const manifest = readManifest(runDir);
    for (const ref of proven.features?.[0]?.evidence ?? []) {
      expect(manifest.artifacts.some((artifact) => artifact.sha256 === ref.sha256 && artifact.kind === ref.kind)).toBe(true);
    }
    const verified = await runCli(p, ['verify-run', runDir], { config });
    expect(verified.code, cliOutput(verified)).toBe(0);
    const state = JSON.parse(readFileSync(p.path('.ai-bdd', 'state', 'features.json'), 'utf8')) as { features: { featureId: string; runId: string }[] };
    expect(state.features).toEqual([expect.objectContaining({ featureId, runId: proven.runId })]);
    const calls = readFileSync(p.logPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { purpose?: string });
    expect(calls.some((call) => call.purpose === 'extract')).toBe(false);
    expect(dirname(runDir)).toBe(p.runsDir);
  });
});
