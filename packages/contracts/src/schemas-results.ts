import { DiagnosticSchema, KindSourceSchema, ResolutionSchema, SourceLocationSchema, StatusSchema, StepKindSchema } from './schemas.js';

import { z } from 'zod';
import { JsonValueSchema } from './schemas.js';
import { ArtifactRefSchema, CacheOutcomeSchema, CheckPredicateSchema } from './schemas-driver.js';

export const ImageInputSchema = z.object({
  ref: z.string().optional(),
  base64: z.string().optional(),
  mediaType: z.string(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
});

/**
 * Judge input schema. Strict keys mean an agent transcript cannot be smuggled
 * into a judge request (R-K3a).
 */
export const JudgeRequestSchema = z
  .object({
    criterion: z.string(),
    actionPreceded: z.boolean(),
    beforeImages: z.array(ImageInputSchema),
    afterImages: z.array(ImageInputSchema),
    beforeTrees: z.array(z.string()),
    afterTrees: z.array(z.string()),
    context: z.string().optional(),
    params: z.record(z.string(), JsonValueSchema).optional(),
    driver: z.string(),
    promptVersion: z.string().optional(),
  })
  .strict();

export const JudgeSampleSchema = z.object({
  probability: z.number().min(0).max(1),
  verdict: z.enum(['holds', 'fails', 'cannot_tell']),
  explanation: z.string(),
  observed: z.string(),
  contradictory: z.boolean().optional(),
});

export const JudgeVerdictSchema = z.object({
  score: z.number().min(0).max(1),
  verdict: z.enum(['pass', 'fail', 'inconclusive']),
  samples: z.array(JudgeSampleSchema),
  spread: z.number(),
  modelId: z.string(),
  promptVersion: z.string(),
  cacheKey: z.string(),
  reused: z.boolean(),
  reason: z.string().optional(),
  evidenceIds: z.array(z.string()).optional(),
});

export const EvidenceRecordSchema = z.object({
  evidenceId: z.string(),
  runId: z.string(),
  kind: z.enum([
    'screenshot',
    'observation',
    'video',
    'judge-request',
    'judge-response',
    'action-log',
    'check-result',
    'act-program',
    'check-program',
    'log',
    'attachment',
    'tree',
    'dom',
  ]),
  artifact: ArtifactRefSchema,
  stepId: z.string().optional(),
  scenarioId: z.string().optional(),
  traceId: z.string().optional(),
  spanId: z.string().optional(),
  createdAt: z.string(),
  chainHash: z.string(),
  prevChainHash: z.string(),
  meta: z.record(z.string(), JsonValueSchema).optional(),
});

export const EvidenceManifestSchema = z.object({
  runId: z.string(),
  rootHash: z.string(),
  count: z.number().int().min(0),
  createdAt: z.string(),
  signature: z.object({ alg: z.literal('ed25519'), keyId: z.string().optional(), value: z.string() }).optional(),
});

export const AiBddErrorPayloadSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  details: JsonValueSchema.optional(),
  group: z.string().optional(),
});

export const EvidenceRefSchema = z.object({
  evidenceId: z.string(),
  kind: z.string(),
  sha256: z.string().optional(),
  path: z.string().optional(),
});

export const CheckOutcomeSchema = z.object({
  programKey: z.string().optional(),
  results: z.array(
    z.object({
      predicate: CheckPredicateSchema,
      result: z.enum(['satisfied', 'unsatisfied', 'unknown']),
      detail: z.string().optional(),
    }),
  ),
  status: z.enum(['passed', 'failed', 'skipped']),
  invariant: z.boolean().optional(),
  judgeOnly: z.boolean().optional(),
  generated: z.boolean().optional(),
  attempts: z.number().int().optional(),
});

export const HealingInfoSchema = z.object({
  reason: z.string(),
  replayedActions: z.number().int(),
  totalActions: z.number().int(),
});

export const StepResultSchema = z.object({
  stepId: z.string(),
  text: z.string(),
  kind: StepKindSchema,
  kindSource: KindSourceSchema,
  phase: z.enum(['context', 'scenario', 'teardown']).optional(),
  status: StatusSchema,
  resolution: ResolutionSchema,
  cache: CacheOutcomeSchema.optional(),
  check: CheckOutcomeSchema.optional(),
  judge: JudgeVerdictSchema.optional(),
  healing: HealingInfoSchema.optional(),
  evidence: z.array(EvidenceRefSchema),
  durationMs: z.number().min(0),
  traceId: z.string().optional(),
  traceparent: z.string().optional(),
  modelCalls: z.number().int().optional(),
  error: AiBddErrorPayloadSchema.optional(),
  notes: z.array(z.string()).optional(),
  location: SourceLocationSchema.optional(),
  conceptChain: z.array(z.string()).optional(),
});

export const ScenarioResultSchema = z.object({
  scenarioId: z.string(),
  name: z.string(),
  specName: z.string(),
  uri: z.string(),
  tags: z.array(z.string()),
  dataRow: z.array(z.string()).optional(),
  status: StatusSchema,
  steps: z.array(StepResultSchema),
  durationMs: z.number().min(0),
  traceId: z.string().optional(),
  driver: z.string().optional(),
  error: AiBddErrorPayloadSchema.optional(),
});

export const RunStatsSchema = z.object({
  scenarios: z.number().int(),
  passed: z.number().int(),
  failed: z.number().int(),
  healed: z.number().int(),
  skipped: z.number().int(),
  steps: z.number().int(),
  judgeOnly: z.number().int(),
  semanticResolutions: z.number().int(),
  actReplays: z.number().int(),
  heals: z.number().int(),
  modelCalls: z.number().int(),
});

export const RunReportSchema = z.object({
  runId: z.string(),
  version: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  status: StatusSchema,
  driver: z.string().optional(),
  scenarios: z.array(ScenarioResultSchema),
  stats: RunStatsSchema,
  cost: JsonValueSchema.optional(),
  lock: JsonValueSchema.optional(),
  diagnostics: z.array(DiagnosticSchema),
  exitCode: z.number().int(),
  frozen: z.boolean().optional(),
  strictCache: z.boolean().optional(),
  runDir: z.string().optional(),
  rootHash: z.string().optional(),
});


