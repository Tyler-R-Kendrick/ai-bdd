import { describe, expect, it, vi } from 'vitest';
import type { JudgeVerdict, ScenarioResult, StepResult } from '@ai-bdd/sdk/contracts';
import { ZERO_USAGE, emptyTotals, makeReport, runCli } from './helpers.ts';

const step = (over: Partial<StepResult> = {}): StepResult => ({
  stepKey: 'when:bbbbbbbbbbbb', kind: 'when', text: 'the user upgrades', status: 'passed', path: 'replay', determinism: 'deterministic',
  fuzzyReasons: [], actions: 1, usage: ZERO_USAGE, durationMs: 5, evidence: [], sources: [], ...over,
});
const scenario = (over: Partial<ScenarioResult> = {}): ScenarioResult => ({
  scenarioId: 'a/one', featureId: 'a', docUri: 'docs/a.md', title: 'One', driver: 'web',
  status: 'passed', mode: 'replay', review: 'accepted', steps: [step()], recording: 'none', usage: ZERO_USAGE, durationMs: 1200, ...over,
});
const verdict: JudgeVerdict = { verdict: 'fail', score: 0.1, spread: 0, samples: [], modelId: 'm', promptVersion: 'judge-v1', cached: false, usage: ZERO_USAGE };

const summary = async (report: ReturnType<typeof makeReport>, over: Parameters<typeof runCli>[1] = {}) => {
  const h = await runCli(['run'], { engine: { run: vi.fn(async () => report) }, ...over });
  return { ...h, lines: h.stdout.split('\n') };
};

describe('run summary: exact output', () => {
  it('an empty run prints only the totals, no recordings, the run dir and the exit code', async () => {
    const h = await summary(makeReport());
    expect(h.code).toBe(0);
    expect(h.stdout).toBe(
      [
        '',
        'Scenarios: 0 total',
        'Steps: 0 replayed, 0 by agent, 0 healed, 0 fuzzy',
        'Model calls: 0 (0 input / 0 output tokens)',
        'Recordings: read-write, none written',
        'Run: .ai-bdd/runs/run-1',
        'Exit code: 0',
        '',
      ].join('\n'),
    );
  });

  it('a passing scenario line carries mode, duration and (when written) the recording result; zero totals are omitted', async () => {
    const h = await summary(
      makeReport({
        totals: emptyTotals({ passed: 2 }),
        scenarios: [
          scenario({ scenarioId: 'a/one', mode: 'characterize', recording: 'created', durationMs: 1250 }),
          scenario({ scenarioId: 'a/two', mode: 'replay', recording: 'none', durationMs: 40 }),
        ],
      }),
    );
    expect(h.lines).toContain('PASS  a/one  (characterize, recording created, 1.3s)');
    expect(h.lines).toContain('PASS  a/two  (replay, 0.0s)');
    expect(h.lines).toContain('Scenarios: 2 total, 2 passed');
    expect(h.lines).toContain('Steps: 2 replayed, 0 by agent, 0 healed, 0 fuzzy');
    expect(h.lines).toContain('Recordings (read-write): 1 created');
  });

  it('prints totals in the fixed order passed, healed, failed, inconclusive, blocked, error, skipped, skipping zeros', async () => {
    const h = await summary(
      makeReport({
        exitCode: 3,
        totals: emptyTotals({ skipped: 1, error: 2, blocked: 3, inconclusive: 4, failed: 5, healed: 6, passed: 7 }),
        scenarios: [scenario()],
      }),
    );
    expect(h.lines).toContain('Scenarios: 1 total, 7 passed, 6 healed, 5 failed, 4 inconclusive, 3 blocked, 2 error, 1 skipped');
    expect(h.code).toBe(3);
  });

  it('tolerates an engine report whose totals omit statuses', async () => {
    const h = await summary(makeReport({ totals: { passed: 2 } as never, scenarios: [scenario(), scenario({ scenarioId: 'a/two' })] }));
    expect(h.lines).toContain('Scenarios: 2 total, 2 passed');
  });

  it('uses a distinct label per scenario status', async () => {
    const statuses = ['passed', 'healed', 'failed', 'blocked', 'skipped', 'inconclusive', 'error'] as const;
    const h = await summary(makeReport({ scenarios: statuses.map((status) => scenario({ scenarioId: `s/${status}`, status, steps: [] })) }));
    const labels = Object.fromEntries(statuses.map((s) => [s, h.lines.find((l) => l.includes(`s/${s}`))?.split(' ')[0]]));
    expect(labels).toEqual({ passed: 'PASS', healed: 'HEAL', failed: 'FAIL', blocked: 'BLOCK', skipped: 'SKIP', inconclusive: 'INCON', error: 'ERROR' });
  });
});

describe('run summary: failing scenarios', () => {
  const failing = (status: ScenarioResult['status'], steps: StepResult[], over: Partial<ScenarioResult> = {}) => scenario({ scenarioId: 'a/bad', status, steps, ...over });
  const err = (code: 'CHECK_FAILED' | 'DRIVER_ERROR', message: string) => ({ code, message, retryable: false });

  it('lists exactly the failed, error, blocked and inconclusive steps, with error code and message, and no passing steps', async () => {
    const h = await summary(
      makeReport({
        exitCode: 1,
        scenarios: [
          failing('failed', [
            step({ kind: 'given', text: 'g passes' }),
            step({ kind: 'when', text: 'w fails', status: 'failed', error: err('CHECK_FAILED', 'nope') }),
            step({ kind: 'then', text: 't errors', status: 'error', error: err('DRIVER_ERROR', 'browser crashed') }),
            step({ kind: 'then', text: 't blocked', status: 'blocked', error: err('CHECK_FAILED', 'fixture missing') }),
            step({ kind: 'then', text: 't unsure', status: 'inconclusive', judge: verdict }),
            step({ kind: 'then', text: 't healed', status: 'healed' }),
            step({ kind: 'then', text: 't skipped', status: 'skipped' }),
          ]),
        ],
      }),
    );
    const i = h.lines.findIndex((l) => l.startsWith('FAIL '));
    expect(h.lines.slice(i, i + 8)).toEqual([
      'FAIL  a/bad  (replay, 1 healed, 1.2s)',
      '        failed when w fails [CHECK_FAILED]',
      '          nope',
      '        error then t errors [DRIVER_ERROR]',
      '          browser crashed',
      '        blocked then t blocked [CHECK_FAILED]',
      '          fixture missing',
      '        inconclusive then t unsure [JUDGE]',
    ]);
    expect(h.stdout).not.toContain('g passes');
    expect(h.stdout).not.toContain('then t healed');
    expect(h.stdout).not.toContain('t skipped');
  });

  it('a failing step without error or judge verdict has no bracket suffix and no message line', async () => {
    const h = await summary(makeReport({ exitCode: 1, scenarios: [failing('failed', [step({ status: 'failed', text: 'bare' })])] }));
    const i = h.lines.findIndex((l) => l.startsWith('FAIL '));
    expect(h.lines.slice(i, i + 3)).toEqual(['FAIL  a/bad  (replay, 1.2s)', '        failed when bare', '']);
  });

  it('a scenario-level error is printed as "CODE: message" before its steps', async () => {
    const h = await summary(
      makeReport({
        exitCode: 3,
        scenarios: [failing('error', [step({ status: 'error', text: 'boom', error: err('DRIVER_ERROR', 'step level') })], { error: err('DRIVER_ERROR', 'scenario level') })],
      }),
    );
    const i = h.lines.findIndex((l) => l.startsWith('ERROR '));
    expect(h.lines.slice(i + 1, i + 4)).toEqual(['        DRIVER_ERROR: scenario level', '        error when boom [DRIVER_ERROR]', '          step level']);
  });

  it('steps of passed, healed and skipped scenarios are never listed, even if one of them failed', async () => {
    const bad = [step({ status: 'failed', text: 'hidden failure', error: err('CHECK_FAILED', 'hidden message') })];
    const h = await summary(makeReport({ scenarios: ['passed', 'healed', 'skipped'].map((s) => scenario({ scenarioId: `x/${s}`, status: s as ScenarioResult['status'], steps: bad })) }));
    expect(h.stdout).not.toContain('hidden');
  });

  it('a failed confirm run lists the reclassified steps, or "none"', async () => {
    const h = await summary(
      makeReport({
        exitCode: 1,
        scenarios: [
          failing('failed', [], { scenarioId: 'a/c1', confirm: { runs: 2, failed: true, reclassified: ['then:cccccccccccc', 'when:bbbbbbbbbbbb'] } }),
          failing('failed', [], { scenarioId: 'a/c2', confirm: { runs: 2, failed: true, reclassified: [] } }),
          failing('passed', [], { scenarioId: 'a/c3', confirm: { runs: 2, failed: false, reclassified: ['ignored'] } }),
        ],
      }),
    );
    expect(h.lines).toContain('        confirm run failed; reclassified: then:cccccccccccc, when:bbbbbbbbbbbb');
    expect(h.lines).toContain('        confirm run failed; reclassified: none');
    expect(h.stdout).not.toContain('ignored');
    expect(h.stdout.match(/confirm run failed/g)).toHaveLength(2);
  });

  it('a healed scenario shows the healed step count in its line', async () => {
    const h = await summary(
      makeReport({ totals: emptyTotals({ healed: 1 }), scenarios: [scenario({ scenarioId: 'a/h', status: 'healed', mode: 'mixed', recording: 'updated', steps: [step({ status: 'healed', path: 'heal' }), step({ status: 'healed', path: 'heal' }), step()] })] }),
    );
    expect(h.lines).toContain('HEAL  a/h  (mixed, 2 healed, recording updated, 1.2s)');
  });
});

describe('run summary: step statistics, usage and notes', () => {
  it('counts steps by path (replay, agent+heal) and healed status, and fuzzy steps with sorted reason counts', async () => {
    const h = await summary(
      makeReport({
        scenarios: [
          scenario({
            steps: [
              step({ path: 'replay' }),
              step({ path: 'replay' }),
              step({ path: 'agent' }),
              step({ path: 'heal', status: 'healed' }),
              step({ path: 'check', determinism: 'fuzzy', fuzzyReasons: ['volatile-content', 'subjective'] }),
              step({ path: 'judge', determinism: 'fuzzy', fuzzyReasons: ['subjective'] }),
              step({ path: 'fixture', determinism: 'n/a', fuzzyReasons: ['subjective'] }),
            ],
          }),
        ],
      }),
    );
    // fuzzy reasons of non-fuzzy steps are not counted
    expect(h.lines).toContain('Steps: 2 replayed, 2 by agent, 1 healed, 2 fuzzy');
    expect(h.lines).toContain('Fuzzy reasons: subjective x2, volatile-content x1');
  });

  it('omits the fuzzy line when there are no fuzzy steps', async () => {
    const h = await summary(makeReport({ scenarios: [scenario()] }));
    expect(h.stdout).not.toContain('Fuzzy reasons');
  });

  it('the healed reminder mentions --strict only when the run was not strict, and is absent without healed steps', async () => {
    const healed = scenario({ status: 'healed', steps: [step({ status: 'healed', path: 'heal' })] });
    const lax = await summary(makeReport({ scenarios: [healed] }));
    expect(lax.lines).toContain('Healed steps are reported as passed (use --strict to fail them); review them.');
    const strict = await summary(makeReport({ options: { ...makeReport().options, strict: true }, scenarios: [healed] }));
    expect(strict.lines).toContain('Healed steps are reported as passed; review them.');
    const none = await summary(makeReport({ scenarios: [scenario()] }));
    expect(none.stdout).not.toContain('Healed steps are reported');
  });

  it('shows the estimated cost with four decimals only when the report has one', async () => {
    const withCost = await summary(makeReport({ usage: { ...makeReport().usage, modelCalls: 3, inputTokens: 10, outputTokens: 2, estimatedCostUsd: 1.5 } }));
    expect(withCost.lines).toContain('Model calls: 3 (10 input / 2 output tokens, est. cost $1.5000)');
    const zero = await summary(makeReport({ usage: { ...makeReport().usage, estimatedCostUsd: 0 } }));
    expect(zero.lines).toContain('Model calls: 0 (0 input / 0 output tokens, est. cost $0.0000)');
    const without = await summary(makeReport());
    expect(without.lines).toContain('Model calls: 0 (0 input / 0 output tokens)');
  });

  it('counts recording results per kind in first-seen order, naming the recordings mode', async () => {
    const h = await summary(
      makeReport({
        options: { ...makeReport().options, recordingsMode: 'read-only' },
        scenarios: ['created', 'unchanged', 'created', 'none', 'discarded'].map((recording, i) => scenario({ scenarioId: `r/${i}`, recording: recording as ScenarioResult['recording'] })),
      }),
    );
    expect(h.lines).toContain('Recordings (read-only): 2 created, 1 unchanged, 1 discarded');
  });

  it('reports unreviewed scenarios that ran, and warnings with their codes', async () => {
    const h = await summary(
      makeReport({
        scenarios: [scenario({ review: 'unreviewed' }), scenario({ review: 'unreviewed' }), scenario({ review: 'accepted' })],
        warnings: [
          { code: 'JUDGE_SAME_AS_ACTOR', severity: 'warning', message: 'same model' },
          { code: 'PLAN_PINNED_STALE', severity: 'warning', message: 'pinned feature is stale' },
        ],
      }),
    );
    expect(h.lines).toContain('Unreviewed scenarios run: 2 (see `ai-bdd review`)');
    expect(h.lines).toContain('warning JUDGE_SAME_AS_ACTOR: same model');
    expect(h.lines).toContain('warning PLAN_PINNED_STALE: pinned feature is stale');
    const none = await summary(makeReport({ scenarios: [scenario({ review: 'accepted' })] }));
    expect(none.stdout).not.toContain('Unreviewed');
    expect(none.stdout).not.toContain('warning ');
  });

  it('prints the run directory relative to the cwd, and falls back to the run id when that is empty', async () => {
    const rel = await summary(makeReport({ runId: 'abc' }), { cwd: '/proj', config: { runsDir: '/proj/.ai-bdd/runs' } });
    expect(rel.lines).toContain('Run: .ai-bdd/runs/abc');
    const outside = await summary(makeReport({ runId: 'abc' }), { cwd: '/proj', config: { runsDir: '/elsewhere/runs' } });
    expect(outside.lines).toContain('Run: ../elsewhere/runs/abc');
    const same = await summary(makeReport({ runId: '.' }), { cwd: '/proj', config: { runsDir: '/proj' } });
    expect(same.lines).toContain('Run: .');
  });
});

describe('run: engine lifecycle and flags', () => {
  it('RECORDING_READ_ONLY (exit 2) when -u is combined with a read-only recordings mode, without running anything', async () => {
    const h = await runCli(['run', '-u'], { config: { recordingsMode: 'read-only' } });
    expect(h.code).toBe(2);
    expect(h.stderr).toContain('ai-bdd: error [RECORDING_READ_ONLY]: Recordings are read-only (CI default)');
    expect(h.stderr).toContain('AI_BDD_RECORDINGS=read-write');
    expect(h.engine.run).not.toHaveBeenCalled();
    expect(h.engine.close).toHaveBeenCalledOnce();
  });

  it('-u with the other recordings modes reaches the engine', async () => {
    for (const recordingsMode of ['read-write', 'off'] as const) {
      const h = await runCli(['run', '-u'], { config: { recordingsMode } });
      expect(h.code).toBe(0);
      expect(h.engine.run).toHaveBeenCalledOnce();
    }
  });

  it('CI env spellings: only "true" and "1" (any case, trimmed) mean CI', async () => {
    const frozenFor = async (ci: string | undefined) => {
      const h = await runCli(['run'], { env: ci === undefined ? {} : { CI: ci } });
      return (h.engine.run as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].frozen;
    };
    expect(await frozenFor('1')).toBe(true);
    expect(await frozenFor('true')).toBe(true);
    expect(await frozenFor('TRUE')).toBe(true);
    expect(await frozenFor(' 1 ')).toBe(true);
    expect(await frozenFor('0')).toBe(false);
    expect(await frozenFor('false')).toBe(false);
    expect(await frozenFor('yes')).toBe(false);
    expect(await frozenFor('')).toBe(false);
    expect(await frozenFor(undefined)).toBe(false);
  });

  it('--frozen on the command line beats a non-CI environment, and an explicit CI run never compiles', async () => {
    const h = await runCli(['run', '--frozen', '--no-compile'], { env: {} });
    expect((h.engine.run as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({ frozen: true, compile: false });
  });
});
