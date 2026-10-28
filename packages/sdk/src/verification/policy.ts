import type { ArtifactKind, BinaryType, Feature, ResolvedConfig, RiskLevel } from '../contracts/index.ts';

export interface FeaturePolicy {
  target: BinaryType;
  risk: RiskLevel;
  requiredEvidence: ArtifactKind[];
  formalVerificationRequired: boolean;
}

const TARGETS: readonly BinaryType[] = ['web', 'cli', 'library', 'api', 'mobile', 'desktop', 'other'];
const RISKS: readonly RiskLevel[] = ['low', 'medium', 'high', 'critical'];
const ARTIFACTS: readonly ArtifactKind[] = [
  'screenshot', 'observation', 'act-transcript', 'action-log', 'judge-request', 'judge-response',
  'checkgen', 'extract-request', 'extract-response', 'report', 'test-report', 'formal-proof', 'log',
];

function tagged(tags: readonly string[], name: string): string | undefined {
  const normalized = name.replace(/^@/, '').toLowerCase();
  for (const raw of tags) {
    const tag = raw.replace(/^@/, '').toLowerCase();
    if (tag === normalized) return '';
    if (tag.startsWith(`${normalized}:`)) return raw.slice(raw.indexOf(':') + 1);
    if (tag.startsWith(`${normalized}-`)) return raw.slice(name.length + 2);
  }
  return undefined;
}

/** Resolve binary/risk metadata from PDD/Gherkin feature tags over the configured defaults. */
export function featurePolicy(feature: Feature, config: ResolvedConfig): FeaturePolicy {
  const tags = feature.tags;
  const targetTag = tagged(tags, 'target');
  const directTarget = TARGETS.find((target) => tagged(tags, target) !== undefined);
  const target = TARGETS.find((candidate) => candidate === targetTag?.toLowerCase()) ?? directTarget ?? config.verification.target;
  const riskTag = tagged(tags, 'risk');
  const risk = RISKS.find((candidate) => candidate === riskTag?.toLowerCase()) ?? config.verification.risk;
  const evidenceTag = tagged(tags, 'evidence');
  const custom = evidenceTag?.split(',').map((kind) => kind.trim()).filter((kind): kind is ArtifactKind => ARTIFACTS.includes(kind as ArtifactKind));
  const formalTag = tagged(tags, 'formal');
  const noFormal = tagged(tags, 'no-formal') !== undefined;
  return {
    target,
    risk,
    requiredEvidence: [...new Set(custom !== undefined && custom.length > 0 ? custom : config.verification.evidence[target])],
    formalVerificationRequired: !noFormal && (formalTag !== undefined || config.verification.formalVerification[risk]),
  };
}
