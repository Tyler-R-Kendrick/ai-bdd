import { z } from 'zod';
import type { DocPlan, JsonValue } from '../contracts/index.ts';

/** Hashes are 64 hex chars in practice; the schema only requires a non-empty string so hand-built fixtures stay loadable. */
const Sha = z.string().min(1);

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema)]),
);

const SourceRangeSchema = z
  .object({
    startLine: z.number().int().nonnegative(),
    startColumn: z.number().int().nonnegative(),
    endLine: z.number().int().nonnegative(),
    endColumn: z.number().int().nonnegative(),
  })
  .strict();

const ChunkKindSchema = z.enum(['heading', 'paragraph', 'listItem', 'tableRow', 'code', 'blockquote']);
const ReviewStateSchema = z.enum(['unreviewed', 'accepted', 'rejected']);
const StepKindSchema = z.enum(['given', 'when', 'then']);

const ChunkRefSchema = z
  .object({
    chunkId: z.string().min(1),
    hash: Sha,
    relation: z.enum(['source', 'context']),
    quote: z.string().optional(),
  })
  .strict();

const FixtureCallSchema = z.object({ name: z.string().min(1), args: z.record(z.string(), JsonValueSchema) }).strict();

const StepSchema = z
  .object({
    key: z.string().min(1),
    kind: StepKindSchema,
    text: z.string(),
    grounding: z.enum(['quoted', 'inferred']),
    sources: z.array(ChunkRefSchema),
    nature: z.enum(['objective', 'subjective']).optional(),
    requiresState: z.boolean().optional(),
    fixture: FixtureCallSchema.optional(),
    params: z.record(z.string(), z.string()),
  })
  .strict();

const ScenarioSchema = z
  .object({
    id: z.string().min(1),
    featureId: z.string().min(1),
    title: z.string(),
    tags: z.array(z.string()),
    sources: z.array(ChunkRefSchema),
    steps: z.array(StepSchema),
    driver: z.string().optional(),
    startUrl: z.string().optional(),
    review: ReviewStateSchema,
    fingerprint: Sha,
  })
  .strict();

const UserStorySchema = z.object({ asA: z.string(), iWant: z.string(), soThat: z.string().optional() }).strict();

const FeatureSchema = z
  .object({
    id: z.string().min(1),
    docUri: z.string().min(1),
    sectionId: z.string().min(1),
    title: z.string(),
    story: UserStorySchema.optional(),
    description: z.string().optional(),
    tags: z.array(z.string()),
    sources: z.array(ChunkRefSchema),
    scenarios: z.array(ScenarioSchema),
    review: ReviewStateSchema,
    pinned: z.boolean().optional(),
    fingerprint: Sha,
  })
  .strict();

/** Zod mirror of the contract type `DocPlan` (R-PL4: plan files are validated on every load and save). */
export const DocPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    docUri: z.string().min(1),
    docSha256: Sha,
    extractor: z.object({ modelId: z.string(), promptVersion: z.string() }).strict(),
    sections: z.array(z.object({ id: z.string().min(1), hash: Sha, failed: z.boolean().optional() }).strict()),
    chunks: z.array(
      z.object({ id: z.string().min(1), hash: Sha, kind: ChunkKindSchema, range: SourceRangeSchema, excerpt: z.string() }).strict(),
    ),
    features: z.array(FeatureSchema),
    notTestable: z.array(z.object({ chunkId: z.string().min(1), reason: z.string() }).strict()),
    rejected: z.array(z.object({ fingerprint: Sha, title: z.string() }).strict()),
    uncovered: z.array(z.string()),
  })
  .strict();

/** Compile-time check: every contract `DocPlan` is accepted by the schema's inferred type. */
export function _docPlanIsSchemaCompatible(plan: DocPlan): z.infer<typeof DocPlanSchema> {
  return plan;
}

/** Validates a parsed value as a DocPlan. The result carries no `undefined`-valued keys. */
export function parseDocPlan(value: unknown): { ok: true; plan: DocPlan } | { ok: false; message: string } {
  const r = DocPlanSchema.safeParse(value);
  if (!r.success) {
    const first = r.error.issues[0];
    const where = first === undefined ? '' : ` at ${first.path.join('.') || '(root)'}: ${first.message}`;
    return { ok: false, message: `invalid plan${where}` };
  }
  return { ok: true, plan: r.data as unknown as DocPlan };
}
