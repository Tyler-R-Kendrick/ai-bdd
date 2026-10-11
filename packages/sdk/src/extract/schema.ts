import { z } from 'zod';
import type { JsonObject } from '../contracts/index.ts';

/**
 * Strict-provider friendly extraction schema (SPEC 7.2): every key is required and
 * absent values are `null`. Maps are expressed as `[{ name, value }]` arrays.
 * Objects are strict, so unknown keys (for example `config` or `policy`) fail validation (R-EX3).
 */
const RefSchema = z.strictObject({
  handle: z.string(),
  relation: z.enum(['source', 'context']),
  quote: z.string().nullable(),
});

const FixtureArgSchema = z.strictObject({
  name: z.string(),
  value: z.union([z.string(), z.number(), z.boolean()]),
});

const StepSchema = z.strictObject({
  kind: z.enum(['given', 'when', 'then']),
  text: z.string(),
  grounding: z.enum(['quoted', 'inferred']),
  sources: z.array(RefSchema),
  nature: z.enum(['objective', 'subjective']).nullable(),
  requiresState: z.boolean().nullable(),
  fixture: z.strictObject({ name: z.string(), args: z.array(FixtureArgSchema) }).nullable(),
  params: z.array(z.strictObject({ name: z.string(), value: z.string() })),
});

const ScenarioSchema = z.strictObject({
  title: z.string(),
  tags: z.array(z.string()),
  sources: z.array(RefSchema),
  steps: z.array(StepSchema),
});

const FeatureSchema = z.strictObject({
  title: z.string(),
  story: z.strictObject({ asA: z.string(), iWant: z.string(), soThat: z.string().nullable() }).nullable(),
  description: z.string().nullable(),
  tags: z.array(z.string()),
  sources: z.array(RefSchema),
  scenarios: z.array(ScenarioSchema),
});

export const ExtractionSchema = z.strictObject({
  features: z.array(FeatureSchema),
  notTestable: z.array(z.strictObject({ handle: z.string(), reason: z.string() })),
});

export type Extraction = z.infer<typeof ExtractionSchema>;
export type ExtractionFeature = Extraction['features'][number];
export type ExtractionScenario = ExtractionFeature['scenarios'][number];
export type ExtractionStep = ExtractionScenario['steps'][number];
export type ExtractionRef = ExtractionStep['sources'][number];

export const EXTRACTION_OUTPUT_NAME = 'extraction';

/** JSON schema sent to the model (computed once). */
export const EXTRACTION_JSON_SCHEMA: JsonObject = z.toJSONSchema(ExtractionSchema) as unknown as JsonObject;

/** Compact, bounded description of a zod failure, fed back to the model on the repair attempt. */
export function describeSchemaError(error: z.ZodError): string {
  const lines = error.issues.slice(0, 20).map((issue) => {
    const path = issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.');
    return `${path}: ${issue.message}`;
  });
  const more = error.issues.length > 20 ? `\n... and ${error.issues.length - 20} more issues` : '';
  return `${lines.join('\n')}${more}`.slice(0, 3000);
}
