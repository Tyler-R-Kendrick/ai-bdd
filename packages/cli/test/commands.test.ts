import { describe, expect, it, vi } from 'vitest';
import { AiBddError, type ScenarioResult, type StepResult } from '@ai-bdd/sdk/contracts';
import { DOC_URI, ZERO_USAGE, emptyTotals, makeCompileResult, makePlan, makeRecording, makeReport, runCli } from './helpers.ts';

const step = (over: Partial<StepResult> = {}): StepResult => ({
  stepKey: 'when:bbbbbbbbbbbb', kind: 'when', text: 'the user upgrades', status: 'passed', path: 'replay', determinism: 'deterministic',
  fuzzyReasons: [], actions: 1, usage: ZERO_USAGE, durationMs: 5, evidence: [], sources: [], ...over,
});
const scenario = (over: Partial<ScenarioResult> = {}): ScenarioResult => ({
  scenarioId: 'docs-billing--upgrading/upgrade-to-pro', featureId: 'docs-billing--upgrading', docUri: DOC_URI, title: 'Upgrade to Pro', driver: 'web',
  status: 'passed', mode: 'replay', review: 'accepted', steps: [step()], recording: 'none', usage: ZERO_USAGE, durationMs: 1200, ...over,
});

describe('compile (G8)', () => {
  it('R-EX1: translates flags into CompileOptions and prints per-doc counts and diagnostics', async () => {
    const compile = vi.fn(async () =>
      makeCompileResult({
        docs: [{
          docUri: DOC_URI, state: 'stale', extractedSections: ['s1'], failedSections: [], added: ['f1'], updated: ['f2', 'f3'], removed: [],
          diagnostics: [{ code: 'EXTRACT_UNGROUNDED', severity: 'warning', message: 'dropped a scenario', uri: DOC_URI, range: { startLine: 4, startColumn: 1, endLine: 4, endColumn: 9 } }],
        }],
        usage: { modelCalls: 2, inputTokens: 100, outputTokens: 20 },
      }),
    );
    const h = await runCli(['compile', 'docs/a.md', 'docs/b.md', '--full', '--dry-run'], { engine: { compile } });
    expect(compile).toHaveBeenCalledWith({ docs: ['docs/a.md', 'docs/b.md'], full: true, dryRun: true, check: false });
    expect(h.code).toBe(0);
    expect(h.stdout).toContain(`${DOC_URI}  [stale]  +1 ~2 -0`);
    expect(h.stdout).toContain('warning EXTRACT_UNGROUNDED: dropped a scenario (docs/billing.md:4)');
    expect(h.stdout).toContain('Model calls: 2 (100 input / 20 output tokens)');
    expect(h.stdout).toContain('Dry run: no plan files were written.');
    expect(h.engine.close).toHaveBeenCalledOnce();
  });

  it('R-PL2: compile --check exits 4 when any doc is not fresh, even if the engine said 0', async () => {
    const compile = vi.fn(async () => makeCompileResult({ docs: [{ docUri: DOC_URI, state: 'stale', extractedSections: [], failedSections: [], added: [], updated: [], removed: [], diagnostics: [] }] }));
    const h = await runCli(['compile', '--check'], { engine: { compile } });
    expect(compile).toHaveBeenCalledWith({ full: false, dryRun: false, check: true });
    expect(h.code).toBe(4);
    expect(h.stdout).toContain('Check failed: 1 document(s) are not fresh');
  });

  it('R-PL2: compile --check on fresh docs exits 0', async () => {
    const compile = vi.fn(async () => makeCompileResult({ docs: [{ docUri: DOC_URI, state: 'fresh', extractedSections: [], failedSections: [], added: [], updated: [], removed: [], diagnostics: [] }] }));
    const h = await runCli(['compile', '--check'], { engine: { compile } });
    expect(h.code).toBe(0);
    expect(h.stdout).toContain('Check passed');
  });

  it('R-RN3: compile exits 1 on failed sections or error diagnostics', async () => {
    const failed = vi.fn(async () => makeCompileResult({ docs: [{ docUri: DOC_URI, state: 'stale', extractedSections: [], failedSections: ['s1'], added: [], updated: [], removed: [], diagnostics: [] }] }));
    expect((await runCli(['compile'], { engine: { compile: failed } })).code).toBe(1);
    const errored = vi.fn(async () => makeCompileResult({ docs: [{ docUri: DOC_URI, state: 'stale', extractedSections: ['s'], failedSections: [], added: [], updated: [], removed: [], diagnostics: [{ code: 'DOC_READ_FAILED', severity: 'error', message: 'x' }] }] }));
    expect((await runCli(['compile'], { engine: { compile: errored } })).code).toBe(1);
  });

  it('R-RN3: compile passes through the engine exit code', async () => {
    const compile = vi.fn(async () => makeCompileResult({ exitCode: 3 }));
    expect((await runCli(['compile'], { engine: { compile } })).code).toBe(3);
  });
});

describe('status (G8)', () => {
  const status = {
    docs: [
      { docUri: DOC_URI, state: 'stale' as const, dirtySections: ['docs/billing.md#billing'], staleFeatures: ['docs-billing--upgrading'], uncovered: ['c1', 'c2'], notTestable: ['c3'], unreviewedScenarios: ['s1'] },
      { docUri: 'docs/todos.md', state: 'fresh' as const, dirtySections: [], staleFeatures: [], uncovered: [], notTestable: [], unreviewedScenarios: [] },
    ],
  };

  it('prints a per-doc summary without model calls', async () => {
    const h = await runCli(['status'], { engine: { status: vi.fn(async () => status) } });
    expect(h.code).toBe(0);
    expect(h.stdout).toContain(`${DOC_URI}  [stale]`);
    expect(h.stdout).toContain('dirty sections: 1  stale features: 1  uncovered: 2  not testable: 1  unreviewed scenarios: 1');
    expect(h.stdout).toContain('Docs: 1 fresh, 1 stale, 0 new, 0 orphaned');
  });

  it('--json prints the PlanStatus verbatim', async () => {
    const h = await runCli(['status', '--json'], { engine: { status: vi.fn(async () => status) } });
    expect(JSON.parse(h.stdout)).toEqual(status);
  });
});

describe('show (G8)', () => {
  const engine = () => ({ plans: vi.fn(async () => [makePlan()]) });

  it('R-EX4: renders Gherkin-like text with a source comment (line from chunk range) after every step', async () => {
    const h = await runCli(['show', DOC_URI], { engine: engine() });
    expect(h.code).toBe(0);
    const lines = h.stdout.split('\n');
    const idx = lines.findIndex((l) => l.includes('When the user upgrades to Pro'));
    expect(lines[idx + 1]).toBe('      # source: docs/billing.md:3 "can upgrade to Pro from the billing page"');
    expect(h.stdout).toContain('Feature: Upgrading  [unreviewed, pinned]');
    expect(h.stdout).toContain('As a free user');
    expect(h.stdout).toContain('Scenario: Upgrade to Pro  [accepted]');
    // a multi-line chunk reports its start line; context refs are labelled
    expect(h.stdout).toContain('# source: docs/billing.md:5 "The plan badge then shows "Pro"."');
    expect(h.stdout).toContain('# source: docs/billing.md:9 "Pages load within 200ms." (context)');
    // every step has at least one source line immediately after it
    const stepLines = lines.map((l, i) => [l, i] as const).filter(([l]) => /^ {4}(Given|When|Then) /.test(l));
    expect(stepLines).toHaveLength(5);
    for (const [, i] of stepLines) expect(lines[i + 1]).toMatch(/^ {6}# source: /);
    // doc-level footer
    expect(h.stdout).toContain('Not testable:');
    expect(h.stdout).toContain('Uncovered:');
  });

  it('inferred steps fall back to the scenario source and are flagged; fixtures and state are annotated', async () => {
    const h = await runCli(['show', 'docs-billing--upgrading'], { engine: engine() });
    expect(h.stdout).toContain('Given a user on the Free plan\n      # source: docs/billing.md:3 "can upgrade to Pro from the billing page" [scenario source]\n      # inferred step');
    expect(h.stdout).toContain('# fixture: seedAccount {"unpaid":2}');
    expect(h.stdout).toContain('# params: plan="Pro"');
    expect(h.stdout).toContain('# subjective');
  });

  it('selects one scenario by id and by id prefix', async () => {
    const one = await runCli(['show', 'docs-billing--upgrading/upgrade-needs-account'], { engine: engine() });
    expect(one.stdout).toContain('Scenario: Upgrade needs an account');
    expect(one.stdout).not.toContain('Scenario: Upgrade to Pro');
    const prefix = await runCli(['show', 'docs-billing--upgrading/upgrade-to'], { engine: engine() });
    expect(prefix.stdout).toContain('Scenario: Upgrade to Pro');
    expect(prefix.stdout).not.toContain('needs an account');
  });

  it('exits 2 with SCENARIO_NOT_FOUND when nothing matches', async () => {
    const h = await runCli(['show', 'nope'], { engine: engine() });
    expect(h.code).toBe(2);
    expect(h.stderr).toContain('SCENARIO_NOT_FOUND');
  });

  it('--json prints the selected plan elements', async () => {
    const h = await runCli(['show', 'docs-billing--upgrading/upgrade-to-pro', '--json'], { engine: engine() });
    const json = JSON.parse(h.stdout);
    expect(json.docs[0].docUri).toBe(DOC_URI);
    expect(json.docs[0].features[0].scenarios.map((s: { id: string }) => s.id)).toEqual(['docs-billing--upgrading/upgrade-to-pro']);
    expect(json.recordings).toBeUndefined();
  });

  it('--recordings adds determinism and fuzzy reasons per step, reading a read-only store', async () => {
    const rec = makeRecording();
    const createStore = vi.fn(() => ({
      dir: 'x', mode: 'read-only' as const,
      load: vi.fn(async (driverId: string, id: string) => (driverId === 'web' && id === rec.scenarioId ? rec : null)),
      save: vi.fn(), remove: vi.fn(),
      list: vi.fn(async () => [{ driverId: 'web', scenarioId: rec.scenarioId }]),
    }));
    const h = await runCli(['show', rec.scenarioId, '--recordings'], { engine: engine(), deps: { createRecordingStore: createStore as never } });
    expect(createStore).toHaveBeenCalledWith({ dir: '/proj/.ai-bdd/recordings', mode: 'read-only' });
    expect(h.stdout).toContain('# determinism: deterministic');
    expect(h.stdout).toContain('# replay: 1 action(s)');
    expect(h.stdout).toContain('# healed: 1 time(s)');
    expect(h.stdout).toContain('# determinism: fuzzy (subjective)');
    const missing = await runCli(['show', 'docs-billing--upgrading/upgrade-needs-account', '--recordings'], {
      engine: engine(),
      deps: { createRecordingStore: (() => ({ dir: 'x', mode: 'read-only', load: vi.fn(), save: vi.fn(), remove: vi.fn(), list: vi.fn(async () => []) })) as never },
    });
    expect(missing.stdout).toContain('# recording: none');
  });

  it('--recordings --json embeds the recordings keyed by scenario id', async () => {
    const rec = makeRecording();
    const store = { dir: 'x', mode: 'read-only' as const, load: vi.fn(async () => rec), save: vi.fn(), remove: vi.fn(), list: vi.fn(async () => [{ driverId: 'web', scenarioId: rec.scenarioId }]) };
    const h = await runCli(['show', '--json', '--recordings'], { engine: engine(), deps: { createRecordingStore: (() => store) as never } });
    expect(Object.keys(JSON.parse(h.stdout).recordings)).toEqual([rec.scenarioId]);
  });
});

describe('review (G8)', () => {
  it('R-EX5: applies the action to every id in order and reports them', async () => {
    const review = vi.fn(async () => undefined);
    const h = await runCli(['review', 'reject', 'a/b', 'c/d'], { engine: { review } });
    expect(review.mock.calls).toEqual([['a/b', 'reject'], ['c/d', 'reject']]);
    expect(h.stdout).toBe('rejected a/b\nrejected c/d\n');
    expect(h.code).toBe(0);
  });

  it.each(['accept', 'reject', 'pin', 'unpin'] as const)('R-PL3: %s is forwarded to the engine', async (action) => {
    const review = vi.fn(async () => undefined);
    await runCli(['review', action, 'x'], { engine: { review } });
    expect(review).toHaveBeenCalledWith('x', action);
  });

  it('keeps going after an unknown id and exits 2 (SCENARIO_NOT_FOUND)', async () => {
    const review = vi.fn(async (id: string) => {
      if (id === 'bad') throw new AiBddError('SCENARIO_NOT_FOUND', 'no such id');
    });
    const h = await runCli(['review', 'accept', 'bad', 'good'], { engine: { review } });
    expect(h.code).toBe(2);
    expect(review).toHaveBeenCalledTimes(2);
    expect(h.stderr).toContain('bad: [SCENARIO_NOT_FOUND]');
    expect(h.stdout).toContain('accepted good');
  });

  it('R-RN3: an unknown action is a usage error (exit 2) and never loads the engine', async () => {
    const h = await runCli(['review', 'frobnicate', 'x']);
    expect(h.code).toBe(2);
    expect(h.stderr).toContain('USAGE');
    expect(h.createEngine).not.toHaveBeenCalled();
  });
});

describe('run summary (G8)', () => {
  it('prints totals, healed and fuzzy counts, failures with error codes, usage and the run dir', async () => {
    const report = makeReport({
      exitCode: 1,
      totals: emptyTotals({ passed: 1, healed: 1, failed: 1 }),
      usage: { modelCalls: 4, inputTokens: 1000, outputTokens: 200, estimatedCostUsd: 0.0123, byPurpose: { extract: ZERO_USAGE, act: ZERO_USAGE, checkgen: ZERO_USAGE, judge: ZERO_USAGE } },
      warnings: [{ code: 'JUDGE_SAME_AS_ACTOR', severity: 'warning', message: 'judge model equals actor model' }],
      scenarios: [
        scenario({ steps: [step(), step({ status: 'passed', path: 'judge', determinism: 'fuzzy', fuzzyReasons: ['subjective', 'volatile-content'] })] }),
        scenario({ scenarioId: 'x/healed', status: 'healed', mode: 'mixed', recording: 'updated', steps: [step({ status: 'healed', path: 'heal' })] }),
        scenario({
          scenarioId: 'x/broken', status: 'failed', review: 'unreviewed',
          steps: [step({ kind: 'then', text: 'the badge shows Pro', status: 'failed', path: 'check', error: { code: 'CHECK_FAILED', message: 'badge text was Free', retryable: false } })],
        }),
      ],
    });
    const h = await runCli(['run'], { engine: { run: vi.fn(async () => report) } });
    expect(h.code).toBe(1);
    expect(h.stdout).toContain('PASS  docs-billing--upgrading/upgrade-to-pro');
    expect(h.stdout).toContain('HEAL  x/healed');
    expect(h.stdout).toContain('FAIL  x/broken');
    expect(h.stdout).toContain('failed then the badge shows Pro [CHECK_FAILED]');
    expect(h.stdout).toContain('badge text was Free');
    expect(h.stdout).toContain('Scenarios: 3 total, 1 passed, 1 healed, 1 failed');
    expect(h.stdout).toContain('1 healed, 1 fuzzy');
    expect(h.stdout).toContain('Fuzzy reasons: subjective x1, volatile-content x1');
    expect(h.stdout).toContain('Healed steps are reported as passed (use --strict to fail them)');
    expect(h.stdout).toContain('Model calls: 4 (1000 input / 200 output tokens, est. cost $0.0123)');
    expect(h.stdout).toContain('Recordings (read-write): 1 updated');
    expect(h.stdout).toContain('Unreviewed scenarios run: 1');
    expect(h.stdout).toContain('warning JUDGE_SAME_AS_ACTOR');
    expect(h.stdout).toContain('Run: .ai-bdd/runs/run-1');
    expect(h.stdout).toContain('Exit code: 1');
  });
});

describe('verify-run (R-EV1)', () => {
  it('M25: exits 0 for an intact run and resolves the dir against cwd', async () => {
    const verifyRun = vi.fn(async () => ({ ok: true, problems: [] }));
    const h = await runCli(['verify-run', '.ai-bdd/runs/r1'], { engine: { verifyRun } });
    expect(h.code).toBe(0);
    expect(verifyRun).toHaveBeenCalledWith('/proj/.ai-bdd/runs/r1');
  });

  it('M25: exits 1 and lists problems when verification fails', async () => {
    const verifyRun = vi.fn(async () => ({ ok: false, problems: ['modified: a.json', 'missing: b.png'] }));
    const h = await runCli(['verify-run', '/abs/run'], { engine: { verifyRun } });
    expect(h.code).toBe(1);
    expect(h.stdout).toContain('  - modified: a.json');
    expect(h.stdout).toContain('  - missing: b.png');
    expect(verifyRun).toHaveBeenCalledWith('/abs/run');
  });

  it('exits 1 (not a crash) when the engine reports EVIDENCE_CORRUPT', async () => {
    const verifyRun = vi.fn(async () => {
      throw new AiBddError('EVIDENCE_CORRUPT', 'manifest unreadable');
    });
    const h = await runCli(['verify-run', 'r'], { engine: { verifyRun } });
    expect(h.code).toBe(1);
    expect(h.stdout).toContain('manifest unreadable');
  });

  it('works without a config by falling back to the SDK verifyRun', async () => {
    const verifyRun = vi.fn(async () => ({ ok: true, problems: [] }));
    const loadConfig = vi.fn(async () => {
      throw new AiBddError('CONFIG_NOT_FOUND', 'no config');
    });
    const h = await runCli(['verify-run', 'r'], { deps: { loadConfig, verifyRun } });
    expect(h.code).toBe(0);
    expect(verifyRun).toHaveBeenCalledWith('/proj/r');
  });
});

describe('prune (G8)', () => {
  it('passes --dry-run and lists what was (or would be) removed', async () => {
    const prune = vi.fn(async () => ({ removed: ['web/x.json'] }));
    const dry = await runCli(['prune', '--dry-run'], { engine: { prune } });
    expect(prune).toHaveBeenCalledWith({ dryRun: true });
    expect(dry.stdout).toContain('would remove web/x.json');
    const real = await runCli(['prune'], { engine: { prune } });
    expect(prune).toHaveBeenLastCalledWith({ dryRun: false });
    expect(real.stdout).toContain('Removed 1 orphaned recording(s).');
  });

  it('says so when there is nothing to prune', async () => {
    expect((await runCli(['prune'])).stdout).toContain('Nothing to prune.');
  });
});

describe('doctor (G8)', () => {
  it('reports every check and exits 0 when all pass', async () => {
    const h = await runCli(['doctor', '--offline'], { deps: { nodeVersion: '22.22.0' } });
    expect(h.engine.doctor).toHaveBeenCalledWith({ offline: true });
    expect(h.stdout).toContain('[ok]   node: Node 22.22.0');
    expect(h.stdout).toContain('[ok]   plans: all fresh');
    expect(h.stdout).toContain('model reachability skipped');
    expect(h.code).toBe(0);
  });

  it('exits 1 and names the failing checks, including missing drivers, without crashing', async () => {
    const doctor = vi.fn(async () => ({ ok: false, checks: [{ name: 'driver:web', ok: false, detail: 'playwright is not installed' }] }));
    const h = await runCli(['doctor'], { engine: { doctor }, deps: { nodeVersion: '22.22.0' } });
    expect(h.code).toBe(1);
    expect(h.stdout).toContain('[FAIL] driver:web: playwright is not installed');
    expect(h.stdout).toContain('1 check(s) failed.');
  });

  it('does not duplicate checks the engine already reports', async () => {
    const doctor = vi.fn(async () => ({ ok: true, checks: [{ name: 'node', ok: true, detail: 'engine node check' }, { name: 'config', ok: true, detail: 'engine config check' }] }));
    const h = await runCli(['doctor'], { engine: { doctor }, deps: { nodeVersion: '22.22.0' } });
    expect(h.stdout.match(/^\[(?:ok|FAIL)\]\s+node:/gm)).toHaveLength(1);
    expect(h.stdout).toContain('engine node check');
    expect(h.stdout.match(/^\[(?:ok|FAIL)\]\s+config:/gm)).toHaveLength(1);
  });

  it('fails the node check on old Node versions', async () => {
    const h = await runCli(['doctor'], { deps: { nodeVersion: '20.11.1' } });
    expect(h.code).toBe(1);
    expect(h.stdout).toContain('[FAIL] node:');
  });

  it('R-RN3: reports a config failure as a check and exits 2', async () => {
    const loadConfig = vi.fn(async () => {
      throw new AiBddError('CONFIG_INVALID', 'unknown key "foo"');
    });
    const h = await runCli(['doctor'], { deps: { loadConfig, nodeVersion: '22.22.0' } });
    expect(h.code).toBe(2);
    expect(h.stdout).toContain('[FAIL] config: [CONFIG_INVALID] unknown key "foo"');
  });
});
