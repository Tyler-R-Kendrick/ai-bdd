import { z } from 'zod';
import {
  BindingDescriptorSchema,
  JsonValueSchema,
  SourceLocationSchema,
  StepArgSchema,
  StepKindSchema,
  StepOptionsSchema,
} from './schemas.js';
import {
  EvidenceRecordSchema,
  RunReportSchema,
  ScenarioResultSchema,
  StepResultSchema,
} from './schemas-results.js';
import { CapabilitiesSchema } from './schemas-driver.js';
import { ResolutionSchema } from './schemas.js';
import { AiBddErrorPayloadSchema } from './schemas-results.js';

/** Zod schemas for the daemon tool contract (section 10.1). */

export const PluginInfoSchema = z
  .object({ name: z.string(), version: z.string(), language: z.string() })
  .strict();

export const StepPayloadSchema = z
  .object({
    text: z.string(),
    keyword: z.string().optional(),
    kind: StepKindSchema.optional(),
    args: z.array(StepArgSchema).optional(),
    location: SourceLocationSchema.optional(),
    options: StepOptionsSchema.optional(),
    stepId: z.string().optional(),
    scenarioId: z.string().optional(),
  })
  .strict();

export const HealthInputSchema = z.strictObject({});

export const HealthOutputSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
  drivers: z.array(z.object({ name: z.string(), ok: z.boolean(), problems: z.array(z.string()) })),
  protocol: z.number().int(),
});

export const OpenSessionInputSchema = z
  .object({
    scenarioId: z.string().min(1),
    scenarioName: z.string(),
    tags: z.array(z.string()),
    driver: z.string().optional(),
    target: JsonValueSchema.optional(),
    plugin: PluginInfoSchema,
  })
  .strict();

export const OpenSessionOutputSchema = z.object({
  sessionId: z.string(),
  traceId: z.string(),
  driver: z.string(),
  capabilities: CapabilitiesSchema,
});

export const RegisterBindingsInputSchema = z
  .object({
    sessionId: z.string().optional(),
    provider: z.string().min(1),
    bindings: z.array(BindingDescriptorSchema),
  })
  .strict();

export const RegisterBindingsOutputSchema = z.object({
  bindingSetHash: z.string(),
  accepted: z.number().int(),
  rejected: z.array(z.object({ id: z.string(), reason: z.string() })),
});

export const ResolveStepInputSchema = z
  .object({ sessionId: z.string(), step: StepPayloadSchema })
  .strict();

export const ResolveStepOutputSchema = z.object({
  resolution: ResolutionSchema,
  kind: StepKindSchema,
  kindSource: z.enum(['directive', 'binding', 'keyword', 'prefix', 'default']),
  next: z.enum(['invoke-local', 'run-step', 'fail']),
  error: AiBddErrorPayloadSchema.optional(),
});

export const RunStepInputSchema = z
  .object({ sessionId: z.string(), step: StepPayloadSchema, resolution: ResolutionSchema.optional() })
  .strict();

export const RunStepOutputSchema = StepResultSchema;

export const ReportBindingResultInputSchema = z
  .object({
    sessionId: z.string(),
    stepId: z.string().optional(),
    step: StepPayloadSchema,
    bindingId: z.string(),
    status: z.enum(['passed', 'failed']),
    durationMs: z.number().min(0),
    error: z.object({ message: z.string(), stack: z.string().optional() }).optional(),
    judgeAfter: z.boolean().optional(),
  })
  .strict();

export const ReportBindingResultOutputSchema = StepResultSchema;

export const GetEvidenceInputSchema = z.object({ runId: z.string().optional(), evidenceId: z.string() }).strict();

export const GetEvidenceOutputSchema = EvidenceRecordSchema.extend({ absolutePath: z.string() });

export const CloseSessionInputSchema = z
  .object({ sessionId: z.string(), status: z.enum(['passed', 'failed', 'skipped']) })
  .strict();

export const CloseSessionOutputSchema = z.object({ scenarioResult: ScenarioResultSchema });

export const RunInputSchema = z
  .object({
    globs: z.array(z.string()).optional(),
    tags: z.string().optional(),
    driver: z.string().optional(),
    frozen: z.boolean().optional(),
    driverConfig: z
      .record(z.string(), z.object({ use: z.string(), options: JsonValueSchema.optional() }))
      .optional(),
    projectRoot: z.string().optional(),
  })
  .strict();

export const RunOutputSchema = RunReportSchema;
