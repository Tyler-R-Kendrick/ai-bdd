import type {
  DocPlan,
  ExitCode,
  FeatureResult,
  JsonValue,
  ModelPurpose,
  Redactor,
  RunReport,
  ScenarioResult,
  ScenarioStatus,
  Usage,
} from '../contracts/index.ts';
import { PURPOSES, addUsage, zeroUsage } from './usage.ts';

export const ALL_STATUSES: readonly ScenarioStatus[] = ['passed', 'failed', 'healed', 'blocked', 'skipped', 'inconclusive', 'error'];

export function countTotals(results: readonly ScenarioResult[]): Record<ScenarioStatus, number> {
  const totals = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) as Record<ScenarioStatus, number>;
  for (const r of results) totals[r.status] += 1;
  return totals;
}

const INFRA_CODES = new Set(['DRIVER_UNAVAILABLE', 'MODEL_UNAVAILABLE']);

/**
 * Exit code of a run (§5.1, R-RN3). 3 (infrastructure) beats 1; 0 otherwise.
 * `healed` only counts as a failure with `strict`.
 */
export function computeRunExitCode(
  results: readonly ScenarioResult[],
  o: { strict: boolean; modelUnavailable: boolean; compileFailed: boolean },
): ExitCode {
  const infra =
    o.modelUnavailable ||
    results.some(
      (r) =>
        r.status === 'error' ||
        (r.error !== undefined && INFRA_CODES.has(r.error.code)) ||
        r.steps.some((s) => s.error !== undefined && INFRA_CODES.has(s.error.code)),
    );
  if (infra) return 3;
  const bad = results.some((r) => r.status === 'failed' || r.status === 'inconclusive' || r.status === 'blocked' || (o.strict && r.status === 'healed'));
  return bad || o.compileFailed ? 1 : 0;
}

/** Per-doc coverage: referenced (source) non-heading chunks vs uncovered / notTestable lists. */
export function computeCoverage(plans: readonly DocPlan[]): RunReport['coverage'] {
  return {
    docs: [...plans]
      .sort((a, b) => (a.docUri < b.docUri ? -1 : a.docUri > b.docUri ? 1 : 0))
      .map((plan) => {
        const referenced = new Set<string>();
        for (const f of plan.features) {
          const live = f.scenarios.filter((s) => s.review !== 'rejected');
          if (f.review === 'rejected' || (f.scenarios.length > 0 && live.length === 0)) continue;
          for (const r of f.sources) if (r.relation === 'source') referenced.add(r.chunkId);
          for (const s of live) {
            for (const r of s.sources) if (r.relation === 'source') referenced.add(r.chunkId);
            for (const st of s.steps) for (const r of st.sources) if (r.relation === 'source') referenced.add(r.chunkId);
          }
        }
        const body = plan.chunks.filter((c) => c.kind !== 'heading');
        return {
          docUri: plan.docUri,
          chunks: body.length,
          covered: body.filter((c) => referenced.has(c.id)).length,
          uncovered: [...plan.uncovered],
          notTestable: plan.notTestable.map((n) => n.chunkId),
        };
      }),
  };
}

export function buildUsage(
  byPurpose: Record<ModelPurpose, Usage>,
  costUsd: number | undefined,
): RunReport['usage'] {
  let total = zeroUsage();
  for (const p of PURPOSES) total = addUsage(total, byPurpose[p]);
  return {
    ...total,
    byPurpose,
    ...(costUsd === undefined ? {} : { estimatedCostUsd: Math.round(costUsd * 1e6) / 1e6 }),
  };
}

/**
 * The report fields that hold arbitrary JSON (an error's or warning's `details`, a predicate's `actual`). Their keys come from
 * pages, models and errors, so they are data and can carry a secret. Every other key of the report is fixed by its schema.
 */
export const REPORT_DATA_FIELDS: ReadonlySet<string> = new Set(['details', 'actual']);

export function redactFeatureResults(redactor: Redactor, features: readonly FeatureResult[]): FeatureResult[] {
  const walk = (value: JsonValue): JsonValue => {
    if (typeof value === 'string') return redactor.redact(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, REPORT_DATA_FIELDS.has(key) ? redactor.redactJson(child) : walk(child)]));
  };
  return walk(features as unknown as JsonValue) as unknown as FeatureResult[];
}

/**
 * The report as it is returned and written, redacted like every other artifact (R-SE1):
 * - every string value is redacted, and inside the data fields (REPORT_DATA_FIELDS) every key too;
 * - the keys the schema fixes are kept as they are: a secret equal to a field name (`code`) must not rename the field and make the
 *   report invalid, and the name hides nothing, since the engine writes it whatever the secret is;
 * - the three top-level fields the engine computes itself from its id generator and clock keep their text. No input reaches them,
 *   so they hide nothing; redacting a secret that happens to occur in them (a PIN equal to the year) would only make runId name no
 *   run directory and break the timestamps.
 */
export function redactReport(redactor: Redactor, report: RunReport): RunReport {
  const walk = (value: JsonValue): JsonValue => {
    if (typeof value === 'string') return redactor.redact(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== 'object') return value;
    const entries: [string, JsonValue][] = [];
    for (const [key, v] of Object.entries(value)) {
      if (v !== undefined) entries.push([key, REPORT_DATA_FIELDS.has(key) ? redactor.redactJson(v) : walk(v)]);
    }
    return Object.fromEntries(entries);
  };
  const redacted = walk(report as unknown as JsonValue) as unknown as RunReport;
  return { ...redacted, runId: report.runId, startedAt: report.startedAt, finishedAt: report.finishedAt };
}
