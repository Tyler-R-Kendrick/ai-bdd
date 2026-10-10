// @ts-nocheck
import { join, relative } from 'node:path';
import type { ExitCode, ReporterName, RunOptions, RunReport, ScenarioResult, StepResult } from '@ai-bdd/sdk/contracts';
import { AiBddError } from '@ai-bdd/sdk/contracts';
import { withEngine, type Ctx } from '../context.ts';
import { isCiEnv } from '../parse.ts';

export interface RunFlags {
  selectors: string[];
  tags: string[];
  grep?: string | undefined;
  driver?: string | undefined;
  frozen?: boolean | undefined;
  /** Commander's `--no-compile` yields `false`; the default is `true`. */
  compile?: boolean | undefined;
  strict?: boolean | undefined;
  updateRecordings?: boolean | undefined;
  agent?: boolean | undefined;
  audit?: boolean | undefined;
  workers?: number | undefined;
  reporters: ReporterName[];
}

/** Translates CLI flags into engine `RunOptions`, applying the CI defaults of §5.2 (R-RN4). */
export function toRunOptions(flags: RunFlags, ci: boolean, signal?: AbortSignal): RunOptions {
  const frozen = flags.frozen ?? ci;
  return {
    ...(flags.selectors.length > 0 ? { selectors: flags.selectors } : {}),
    ...(flags.tags.length > 0 ? { tags: flags.tags } : {}),
    ...(flags.grep !== undefined ? { grep: flags.grep } : {}),
    ...(flags.driver !== undefined ? { driver: flags.driver } : {}),
    frozen,
    // A frozen run never compiles: a stale plan is a failure, not something to fix up.
    compile: !frozen && flags.compile !== false,
    strict: flags.strict === true,
    updateRecordings: flags.updateRecordings === true,
    noAgent: flags.agent === false,
    audit: flags.audit === true,
    ...(flags.workers !== undefined ? { workers: flags.workers } : {}),
    ...(flags.reporters.length > 0 ? { reporters: flags.reporters } : {}),
    ...(signal ? { signal } : {}),
  };
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

const MARK: Record<ScenarioResult['status'], string> = {
  passed: 'PASS ',
  healed: 'HEAL ',
  failed: 'FAIL ',
  blocked: 'BLOCK',
  skipped: 'SKIP ',
  inconclusive: 'INCON',
  error: 'ERROR',
};

function failingSteps(s: ScenarioResult): StepResult[] {
  return s.steps.filter((st) => st.status === 'failed' || st.status === 'error' || st.status === 'blocked' || st.status === 'inconclusive');
}

function stepsByPath(report: RunReport): { fuzzy: Map<string, number>; fuzzyTotal: number; healed: number; replayed: number; agent: number } {
  const fuzzy = new Map<string, number>();
  let fuzzyTotal = 0;
  let healed = 0;
  let replayed = 0;
  let agent = 0;
  for (const sc of report.scenarios) {
    for (const st of sc.steps) {
      if (st.determinism === 'fuzzy') {
        fuzzyTotal++;
        for (const r of st.fuzzyReasons) fuzzy.set(r, (fuzzy.get(r) ?? 0) + 1);
      }
      if (st.status === 'healed') healed++;
      if (st.path === 'replay') replayed++;
      if (st.path === 'agent' || st.path === 'heal') agent++;
    }
  }
  return { fuzzy, fuzzyTotal, healed, replayed, agent };
}

export function printRunSummary(ctx: Ctx, report: RunReport, runDir: string): void {
  for (const sc of report.scenarios) {
    const healedSteps = sc.steps.filter((st) => st.status === 'healed').length;
    const extra = [sc.mode, healedSteps > 0 ? `${healedSteps} healed` : undefined, sc.recording !== 'none' ? `recording ${sc.recording}` : undefined, seconds(sc.durationMs)]
      .filter(Boolean)
      .join(', ');
    ctx.out(`${MARK[sc.status]} ${sc.scenarioId}  (${extra})`);
    if (sc.error) ctx.out(`        ${sc.error.code}: ${sc.error.message}`);
    if (sc.status !== 'passed' && sc.status !== 'healed' && sc.status !== 'skipped') {
      for (const st of failingSteps(sc)) {
        const code = st.error ? ` [${st.error.code}]` : st.judge ? ' [JUDGE]' : '';
        ctx.out(`        ${st.status} ${st.kind} ${st.text}${code}`);
        if (st.error) ctx.out(`          ${st.error.message}`);
      }
    }
    if (sc.confirm?.failed) ctx.out(`        confirm run failed; reclassified: ${sc.confirm.reclassified.join(', ') || 'none'}`);
  }

  const t = report.totals;
  const total = report.scenarios.length;
  const order: ScenarioResult['status'][] = ['passed', 'healed', 'failed', 'inconclusive', 'blocked', 'error', 'skipped'];
  const parts = order.filter((k) => (t[k] ?? 0) > 0).map((k) => `${t[k]} ${k}`);
  ctx.out();
  ctx.out(`Scenarios: ${total} total${parts.length > 0 ? `, ${parts.join(', ')}` : ''}`);

  const s = stepsByPath(report);
  ctx.out(`Steps: ${s.replayed} replayed, ${s.agent} by agent, ${s.healed} healed, ${s.fuzzyTotal} fuzzy`);
  if (s.fuzzy.size > 0) {
    const reasons = [...s.fuzzy].sort(([a], [b]) => (a < b ? -1 : 1)).map(([r, n]) => `${r} x${n}`);
    ctx.out(`Fuzzy reasons: ${reasons.join(', ')}`);
  }
  if (s.healed > 0) ctx.out(`Healed steps are reported as passed${report.options.strict ? '' : ' (use --strict to fail them)'}; review them.`);

  const u = report.usage;
  const cost = u.estimatedCostUsd !== undefined ? `, est. cost $${u.estimatedCostUsd.toFixed(4)}` : '';
  ctx.out(`Model calls: ${u.modelCalls} (${u.inputTokens} input / ${u.outputTokens} output tokens${cost})`);

  const rec = new Map<string, number>();
  for (const sc of report.scenarios) if (sc.recording !== 'none') rec.set(sc.recording, (rec.get(sc.recording) ?? 0) + 1);
  if (rec.size > 0) ctx.out(`Recordings (${report.options.recordingsMode}): ${[...rec].map(([k, n]) => `${n} ${k}`).join(', ')}`);
  else ctx.out(`Recordings: ${report.options.recordingsMode}, none written`);

  const unreviewed = report.scenarios.filter((x) => x.review === 'unreviewed').length;
  if (unreviewed > 0) ctx.out(`Unreviewed scenarios run: ${unreviewed} (see \`ai-bdd review\`)`);
  for (const w of report.warnings) ctx.out(`warning ${w.code}: ${w.message}`);
  ctx.out(`Run: ${runDir}`);
  ctx.out(`Exit code: ${report.exitCode}`);
}

export async function runRun(ctx: Ctx, flags: RunFlags): Promise<ExitCode> {
  return withEngine(ctx, { driver: flags.driver }, async ({ engine, config }) => {
    const ci = config.ci || isCiEnv(ctx.io.env);
    const opts = toRunOptions(flags, ci, ctx.deps.signal);

    if (opts.updateRecordings === true && config.recordingsMode === 'read-only') {
      throw new AiBddError(
        'RECORDING_READ_ONLY',
        'Recordings are read-only (CI default), so -u/--update-recordings cannot write them. Set AI_BDD_RECORDINGS=read-write to allow it.',
      );
    }

    const report = await engine.run(opts);
    printRunSummary(ctx, report, relative(ctx.io.cwd, join(config.runsDir, report.runId)) || report.runId);
    return report.exitCode;
  });
}
