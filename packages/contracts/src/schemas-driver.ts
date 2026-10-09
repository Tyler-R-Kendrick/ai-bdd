import { z } from 'zod';
import { CandidateSchema, JsonValueSchema, ParamExtractionSchema, ResolutionSchema, StepKindSchema } from './schemas.js';

/** Driver, program and lockfile schemas. */

export const SelectorSchema = z.object({
  role: z.string(),
  name: z.string().optional(),
  testId: z.string().optional(),
  text: z.string().optional(),
  ancestors: z.array(z.object({ role: z.string(), name: z.string().optional() })).optional(),
  index: z.number().int().min(0).optional(),
});

export const ObservedNodeSchema: z.ZodType<unknown> = z.lazy(() =>
  z.object({
    ref: z.string(),
    role: z.string(),
    name: z.string(),
    testId: z.string().optional(),
    text: z.string().optional(),
    state: z.record(z.string(), JsonValueSchema).optional(),
    children: z.array(ObservedNodeSchema).optional(),
  }),
);

export const ArtifactRefSchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  ext: z.string(),
  mediaType: z.string().optional(),
  path: z.string(),
  bytes: z.number().int().min(0).optional(),
});

export const ObservationSchema = z.object({
  revision: z.number().int().min(0),
  nodes: z.array(ObservedNodeSchema),
  treeHash: z.string(),
  url: z.string().optional(),
  route: z.string().optional(),
  title: z.string().optional(),
  screenshot: ArtifactRefSchema.optional(),
  tainted: z.boolean(),
  maskingProven: z.boolean(),
  settled: z.boolean(),
  capturedAt: z.string(),
});

export const VerbSchema = z.enum([
  'tap',
  'doubleTap',
  'longPress',
  'secondaryTap',
  'hover',
  'type',
  'typeSecret',
  'press',
  'select',
  'check',
  'scroll',
  'scrollTo',
  'drag',
  'navigate',
  'back',
  'upload',
  'tapAt',
  'typeAt',
  'invokeMenu',
]);

export const ActionSchema = z.object({
  verb: VerbSchema,
  selector: SelectorSchema.optional(),
  ref: z.string().optional(),
  value: z.string().optional(),
  secretName: z.string().optional(),
  params: JsonValueSchema.optional(),
  delivery: z.enum(['background', 'foreground']).optional(),
  coords: z.object({ x: z.number(), y: z.number() }).optional(),
  captureId: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export const CapabilitiesSchema = z.object({
  verbs: z.array(VerbSchema),
  pixels: z.boolean(),
  tree: z.boolean(),
  video: z.boolean(),
  nativePredicates: z.boolean(),
  maskingProven: z.boolean(),
  deliveryModes: z.array(z.enum(['background', 'foreground'])).optional(),
});

export const ConcurrencyDeclarationSchema = z.object({
  maxSessions: z.number().int().min(1),
  exclusiveResource: z.string().optional(),
});

export const TypedValueSchema = z.union([
  z.object({ literal: z.string() }),
  z.object({ param: z.string() }),
  z.object({ secret: z.string() }),
]);

export const ActActionSchema = z.object({
  verb: VerbSchema,
  selector: SelectorSchema.optional(),
  value: TypedValueSchema.optional(),
  params: JsonValueSchema.optional(),
  delivery: z.enum(['background', 'foreground']).optional(),
});

export const EffectSignatureSchema = z.object({
  elements: z.array(
    z.object({
      selector: SelectorSchema,
      change: z.enum(['appeared', 'disappeared', 'state']),
      detail: z.string().optional(),
    }),
  ),
  route: z.object({ before: z.string().optional(), after: z.string().optional() }).optional(),
});

export const ActProgramSchema = z.object({
  version: z.literal(1),
  key: z.string(),
  text: z.string(),
  driver: z.string(),
  driverMajor: z.number().int(),
  params: z.array(z.string()),
  start: z.object({
    route: z.string().optional(),
    landmarks: z.array(z.object({ role: z.string(), name: z.string().optional() })),
  }),
  actions: z.array(ActActionSchema),
  effect: EffectSignatureSchema,
  recordedAt: z.string(),
  pending: z.boolean().optional(),
});
export const CheckPredicateSchema = z.union([
  z.object({ kind: z.literal('exists'), selector: SelectorSchema }),
  z.object({ kind: z.literal('notExists'), selector: SelectorSchema }),
  z.object({ kind: z.literal('visible'), selector: SelectorSchema }),
  z.object({ kind: z.literal('textEquals'), selector: SelectorSchema, value: z.string(), fromParam: z.string().optional() }),
  z.object({ kind: z.literal('textContains'), selector: SelectorSchema, value: z.string(), fromParam: z.string().optional() }),
  z.object({ kind: z.literal('textMatches'), selector: SelectorSchema, regex: z.string() }),
  z.object({ kind: z.literal('count'), selector: SelectorSchema, value: z.number().int() }),
  z.object({ kind: z.literal('routeMatches'), regex: z.string() }),
  z.object({ kind: z.literal('driverNative'), tool: z.string(), args: JsonValueSchema }),
]);

export const CheckProgramSchema = z.object({
  version: z.literal(1),
  key: z.string(),
  text: z.string(),
  driver: z.string(),
  driverMajor: z.number().int(),
  predicates: z.array(CheckPredicateSchema),
  classification: z.enum(['change', 'invariant']),
  invariant: z.boolean().optional(),
  generatedBy: z.string().optional(),
  createdAt: z.string().optional(),
  verified: z.boolean().optional(),
});

export const CacheOutcomeSchema = z.object({
  mode: z.enum(['replayed', 'healed', 'missed', 'recorded', 'bypassed', 'read-only', 'invalid']),
  key: z.string().optional(),
  invalidation: z.array(z.object({ strategy: z.string(), result: z.enum(['valid', 'invalid', 'unknown']) })).optional(),
  reason: z.string().optional(),
});

export const LockEntrySchema = z.object({
  key: z.string(),
  stepText: z.string(),
  normalizedStepText: z.string(),
  kind: StepKindSchema,
  kindClass: z.enum(['explicit-keyword', 'declared-binding', 'inferred', 'directive']),
  status: z.enum(['semantic', 'agent', 'ambiguous', 'inferred-kind']),
  resolution: ResolutionSchema,
  bindingSetHash: z.string(),
  candidates: z.array(CandidateSchema),
  extraction: ParamExtractionSchema.optional(),
  revalidated: z.boolean().optional(),
  updatedAt: z.string(),
});

export const LockFileSchema = z.object({
  version: z.literal(1),
  generator: z.string(),
  entries: z.array(LockEntrySchema),
});
