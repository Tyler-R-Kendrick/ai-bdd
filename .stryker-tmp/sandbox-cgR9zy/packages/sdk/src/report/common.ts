// @ts-nocheck
import type { JsonValue, ModelPurpose, ScenarioResult, ScenarioStatus, StepResult, StepStatus } from '../contracts/index.ts';

/** Worst first. Mirrors the scenario status precedence of the runner (spec 9.7). */
export const STATUS_ORDER: readonly ScenarioStatus[] = ['error', 'failed', 'inconclusive', 'blocked', 'healed', 'passed', 'skipped'];

export const PURPOSES: readonly ModelPurpose[] = ['extract', 'act', 'checkgen', 'judge'];

/** Statuses that make a scenario a failure for reporting purposes. */
const FAILING = new Set<StepStatus>(['error', 'failed', 'inconclusive', 'blocked']);

export function isFailing(status: StepStatus): boolean {
  return FAILING.has(status);
}

export function worstStatus(statuses: readonly ScenarioStatus[]): ScenarioStatus | undefined {
  for (const s of STATUS_ORDER) if (statuses.includes(s)) return s;
  return undefined;
}

export function firstFailingStep(sc: ScenarioResult): { index: number; step: StepResult } | undefined {
  const steps = sc.steps ?? [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step !== undefined && isFailing(step.status)) return { index: i, step };
  }
  return undefined;
}

export function healedSteps(sc: ScenarioResult): StepResult[] {
  return (sc.steps ?? []).filter((s) => s.status === 'healed');
}

/** Collapse whitespace so a value can sit on one line. */
export function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Error code and message for a scenario: its own error, else the first failing step's error, else a status default. */
export function failureInfo(sc: ScenarioResult): { code: string; message: string } {
  const fs = firstFailingStep(sc);
  const err = sc.error ?? fs?.step.error;
  if (err !== undefined) return { code: err.code, message: err.message };
  const fallback: Partial<Record<ScenarioStatus, string>> = {
    inconclusive: 'JUDGE_INCONCLUSIVE',
    blocked: 'FIXTURE_REQUIRED',
  };
  const code = fallback[sc.status] ?? 'INTERNAL';
  const message = fs !== undefined ? `step ${fs.index + 1} ${fs.step.status}: ${oneLine(fs.step.text)}` : `scenario ${sc.status}`;
  return { code, message };
}

/** Extract `details.stub` when an error carries a fixture stub. */
export function stubOf(details: JsonValue | undefined): string | undefined {
  if (details === null || details === undefined || typeof details !== 'object' || Array.isArray(details)) return undefined;
  const stub = details['stub'];
  return typeof stub === 'string' ? stub : undefined;
}

export function seconds(ms: number): string {
  return (Number.isFinite(ms) ? ms / 1000 : 0).toFixed(3);
}
