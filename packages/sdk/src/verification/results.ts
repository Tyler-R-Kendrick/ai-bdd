import { dirname, join } from 'node:path';
import type {
  Diagnostic, DocPlan, EvidenceStore, Feature, FeatureResult, ResolvedConfig, RunReport, ScenarioResult,
} from '../contracts/index.ts';
import { stableJson } from '../util/index.ts';
import { worstStatus } from '../report/common.ts';
import { attachSupplementalEvidence } from './attachments.ts';
import { featurePolicy } from './policy.ts';

function dedupe(refs: readonly FeatureResult['evidence'][number][]): FeatureResult['evidence'] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.kind}\0${ref.sha256}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function diagnostic(feature: Feature, code: 'TEST_REQUIRED' | 'EVIDENCE_REQUIRED' | 'FORMAL_VERIFICATION_REQUIRED', message: string): Diagnostic {
  return { code, severity: 'error', message, uri: feature.docUri, details: { featureId: feature.id } };
}

async function currentResult(
  config: ResolvedConfig,
  feature: Feature,
  scenarios: readonly ScenarioResult[],
  store: EvidenceStore,
  runId: string,
  lastRunAt: string,
): Promise<FeatureResult> {
  const policy = featurePolicy(feature, config);
  const tests = scenarios.map((scenario) => ({ scenarioId: scenario.scenarioId, status: scenario.status }));
  const captured = scenarios.flatMap((scenario) => scenario.steps.flatMap((step) => step.evidence));
  const resultArtifact = await store.putArtifact('test-report', stableJson({
    featureId: feature.id, docUri: feature.docUri, runId, lastRunAt,
    tests: tests.map((test) => ({ scenarioId: test.scenarioId, status: test.status })),
  }));
  const supplemental = await attachSupplementalEvidence(feature, join(dirname(config.runsDir), 'evidence'), store);
  const evidence = dedupe([...captured, resultArtifact, ...supplemental.refs]);
  const kinds = new Set(evidence.map((ref) => ref.kind));
  const problems: Diagnostic[] = [...supplemental.problems];
  if (tests.length === 0) problems.push(diagnostic(feature, 'TEST_REQUIRED', `Feature "${feature.title}" has no associated test result`));
  const missing = policy.requiredEvidence.filter((kind) => !kinds.has(kind));
  if (missing.length > 0) {
    problems.push(diagnostic(feature, 'EVIDENCE_REQUIRED', `Feature "${feature.title}" is missing required evidence: ${missing.join(', ')}`));
  }
  if (policy.formalVerificationRequired && !kinds.has('formal-proof')) {
    problems.push(diagnostic(feature, 'FORMAL_VERIFICATION_REQUIRED', `Feature "${feature.title}" requires formal verification evidence at ${policy.risk} risk`));
  }
  const testStatus = worstStatus(tests.map((test) => test.status)) ?? 'skipped';
  return {
    featureId: feature.id, docUri: feature.docUri, title: feature.title,
    status: problems.length > 0 && testStatus !== 'error' && testStatus !== 'failed' ? 'blocked' : testStatus,
    selected: true, ...policy, tests, evidence, problems, runId, lastRunAt,
  };
}

export interface BuildFeatureResults {
  config: ResolvedConfig;
  plans: readonly DocPlan[];
  results: readonly ScenarioResult[];
  previous: readonly FeatureResult[];
  evidence: EvidenceStore;
  runId: string;
  lastRunAt: string;
  selective: boolean;
}

/** Attach the latest test state and required evidence to every feature in the PDD plans. */
export async function buildFeatureResults(input: BuildFeatureResults): Promise<FeatureResult[]> {
  const previous = new Map(input.previous.map((result) => [result.featureId, result] as const));
  const results = new Map<string, ScenarioResult[]>();
  for (const result of input.results) {
    const list = results.get(result.featureId);
    if (list === undefined) results.set(result.featureId, [result]);
    else list.push(result);
  }
  const out: FeatureResult[] = [];
  for (const plan of input.plans) {
    for (const feature of plan.features) {
      const scenarios = results.get(feature.id) ?? [];
      const selected = scenarios.length > 0 || (!input.selective && feature.review !== 'rejected');
      if (selected) {
        out.push(await currentResult(input.config, feature, scenarios, input.evidence, input.runId, input.lastRunAt));
      } else {
        const prior = previous.get(feature.id);
        out.push(prior === undefined ? {
          featureId: feature.id, docUri: feature.docUri, title: feature.title,
          status: 'skipped', selected: false, ...featurePolicy(feature, input.config), tests: [], evidence: [], problems: [],
        } : { ...prior, selected: false });
      }
    }
  }
  return out;
}

export function selectedFeatureFailures(features: readonly FeatureResult[] | undefined): boolean {
  return features?.some((feature) => feature.selected && feature.problems.some((problem) => problem.severity === 'error')) ?? false;
}

export type FeatureRunReport = RunReport & { features: FeatureResult[] };
