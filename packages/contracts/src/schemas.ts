import { z } from 'zod';

/** Shared zod schemas (section 10). `XSchema` mirrors the exported type `X`. */

export const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema)]),
);

export const SourceLocationSchema = z.object({
  uri: z.string(),
  line: z.number().int().min(1),
  column: z.number().int().min(1),
  endLine: z.number().int().min(1).optional(),
  endColumn: z.number().int().min(1).optional(),
});

export const DiagnosticSchema = z.object({
  code: z.string(),
  severity: z.enum(['error', 'warning', 'info']),
  message: z.string(),
  location: SourceLocationSchema.optional(),
  details: JsonValueSchema.optional(),
  related: z.array(SourceLocationSchema).optional(),
});

export const DataTableSchema = z.object({
  header: z.array(z.string()),
  rows: z.array(z.array(z.string())),
});

export const StepArgSchema = z.union([
  z.object({ type: z.literal('table'), table: DataTableSchema, location: SourceLocationSchema.optional() }),
  z.object({
    type: z.literal('docString'),
    content: z.string(),
    mediaType: z.string().optional(),
    location: SourceLocationSchema.optional(),
  }),
  z.object({ type: z.literal('file'), path: z.string(), content: z.string(), location: SourceLocationSchema.optional() }),
  z.object({ type: z.literal('secret'), name: z.string(), location: SourceLocationSchema.optional() }),
]);

export const StepKindSchema = z.enum(['setup', 'action', 'assertion']);
export const KindSourceSchema = z.enum(['directive', 'binding', 'keyword', 'prefix', 'default']);
export const StatusSchema = z.enum(['passed', 'failed', 'skipped', 'pending', 'ambiguous', 'undefined', 'healed']);

export const StepOptionsSchema = z
  .object({
    kind: StepKindSchema.optional(),
    mode: z.enum(['auto', 'check', 'judge', 'both']).optional(),
    threshold: z.number().min(0).max(1).optional(),
    failThreshold: z.number().min(0).max(1).optional(),
    samples: z.number().int().min(1).max(9).optional(),
    vision: z.boolean().optional(),
    driver: z.string().optional(),
    resolve: z.enum(['auto', 'exact', 'semantic', 'agent']).optional(),
    timeout: z.number().int().positive().optional(),
    invariant: z.boolean().optional(),
  })
  .strict();

export const StepOriginSchema = z.object({
  conceptId: z.string(),
  signature: z.string(),
  definition: SourceLocationSchema,
  callSite: SourceLocationSchema,
  args: z.record(z.string(), z.string()),
});

export const StepSchema = z.object({
  id: z.string(),
  text: z.string(),
  normalized: z.string(),
  keyword: z.string().optional(),
  kind: StepKindSchema,
  kindSource: KindSourceSchema,
  args: z.array(StepArgSchema),
  location: SourceLocationSchema,
  options: StepOptionsSchema,
  phase: z.enum(['context', 'scenario', 'teardown']).optional(),
  dataRow: z.array(z.string()).optional(),
  originChain: z.array(StepOriginSchema),
  conceptArgs: z.record(z.string(), z.string()).optional(),
});

export const ScenarioSchema = z.object({
  id: z.string(),
  name: z.string(),
  tags: z.array(z.string()),
  steps: z.array(StepSchema),
  dataRow: z.array(z.string()).optional(),
  dataHeader: z.array(z.string()).optional(),
  exampleSet: z.string().optional(),
  rule: z.string().optional(),
  options: StepOptionsSchema,
  location: SourceLocationSchema,
});

export const SpecDocumentSchema = z.object({
  id: z.string(),
  name: z.string(),
  uri: z.string(),
  dialect: z.string().min(1),
  tags: z.array(z.string()),
  options: StepOptionsSchema,
  dataTable: DataTableSchema.optional(),
  contexts: z.array(StepSchema),
  teardown: z.array(StepSchema),
  scenarios: z.array(ScenarioSchema),
  diagnostics: z.array(DiagnosticSchema),
});

export const ParamDeclSchema = z.object({
  name: z.string(),
  type: z.enum(['string', 'int', 'float', 'word', 'any', 'enum']),
  enumValues: z.array(z.string()).optional(),
  derived: z.boolean().optional(),
  optional: z.boolean().optional(),
});

export const BindingDescriptorSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  pattern: z.string(),
  patternKind: z.enum(['cucumber-expression', 'regex', 'gauge-template']),
  kind: z.union([StepKindSchema, z.literal('any')]),
  description: z.string().optional(),
  examples: z.array(z.string()).optional(),
  counterExamples: z.array(z.string()).optional(),
  params: z.array(ParamDeclSchema).optional(),
  strictKind: z.boolean().optional(),
  source: SourceLocationSchema.optional(),
  functionRef: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const CandidateSchema = z.object({
  bindingId: z.string(),
  bindingHash: z.string(),
  score: z.number(),
  margin: z.number().optional(),
  guard: z.string().optional(),
});

export const ParamExtractionSchema = z.object({
  modelId: z.string(),
  promptVersion: z.string(),
  raw: JsonValueSchema,
  validated: z.boolean(),
});

export const ResolutionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('exact'), bindingId: z.string(), bindingHash: z.string(), params: z.record(z.string(), JsonValueSchema) }),
  z.object({
    type: z.literal('semantic'),
    bindingId: z.string(),
    bindingHash: z.string(),
    params: z.record(z.string(), JsonValueSchema),
    score: z.number(),
    margin: z.number(),
    candidates: z.array(CandidateSchema),
    extraction: ParamExtractionSchema,
  }),
  z.object({
    type: z.literal('agent'),
    mode: z.enum(['act', 'assert']),
    reason: z.enum(['no-match', 'guard-rejected', 'below-threshold']),
  }),
  z.object({
    type: z.literal('ambiguous'),
    reason: z.enum(['margin', 'multiple-exact', 'guard-rejected']),
    candidates: z.array(CandidateSchema),
    message: z.string(),
  }),
  z.object({
    type: z.literal('unbound'),
    reason: z.enum(['setup-unbound', 'no-binding']),
    message: z.string(),
  }),
]);
