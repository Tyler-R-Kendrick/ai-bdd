import { z } from 'zod';
import { ERROR_CODES, type JsonValue, type RunReport } from '../contracts/index.ts';

/**
 * Zod mirror of the contract type `RunReport` (schemaVersion 1), and the JSON Schema generated from it.
 *
 * The contract type in `contracts/index.ts` is frozen and stays the source of truth. This file restates it as a schema so that a
 * consumer (another repository's release gate) can check `.ai-bdd/report/report.json` with any JSON Schema validator. Two things
 * keep the restatement honest:
 *   - `_RUN_REPORT_SCHEMA_MATCHES_TYPE` below does not compile unless the schema's inferred type and `RunReport` are assignable to
 *     each other (optional properties use `exactOptional`, which is what `exactOptionalPropertyTypes` means) and every object of
 *     the report has the same property names on both sides (`SchemaMatchesContract`). Assignability catches a missing, mistyped or
 *     wrongly required property and a different enum or literal, but not an optional property that only one side declares, in
 *     either direction: a field added to the contract type as optional would pass it while this closed schema rejects every report
 *     that carries the field. The property-name check per object closes that gap. It is shallow and lists the report's objects by
 *     name (`ObjectKeySets`), so a new nested object type needs a row there; `JsonValue` fields (`details`, `actual`) are open by
 *     design. test/report/schema.test.ts holds the controls: copies of the contract type with one change each, which must fail;
 *   - the unit tests validate reports captured from real runs against the generated file and reject hand-broken copies.
 * Every object is closed (`additionalProperties: false`): version 1 has exactly the fields of the contract type, and a new field
 * is a new `schemaVersion`.
 */

const count = z.number().int().min(0);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/).meta({ id: 'Sha256', description: '64 lowercase hex characters' });
const jsonValue: z.ZodType<JsonValue> = z
  .lazy(() => z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(jsonValue), z.record(z.string(), jsonValue)]))
  .meta({ id: 'JsonValue' });

const usage = z
  .object({ modelCalls: count, inputTokens: count, outputTokens: count })
  .strict()
  .meta({ id: 'Usage', description: 'Model calls and tokens spent. Replay runs report zero.' });

const sourceRange = z
  .object({ startLine: count, startColumn: count, endLine: count, endColumn: count })
  .strict()
  .meta({ id: 'SourceRange', description: '1-based lines and columns; endColumn is exclusive.' });

const errorCode = z.enum(ERROR_CODES).meta({ id: 'ErrorCode', description: 'See docs/errors.md.' });

const errorPayload = z
  .object({ code: errorCode, message: z.string(), retryable: z.boolean(), details: jsonValue.exactOptional() })
  .strict()
  .meta({ id: 'ErrorPayload' });

const diagnostic = z
  .object({
    code: errorCode,
    severity: z.enum(['error', 'warning', 'info']),
    message: z.string(),
    uri: z.string().exactOptional(),
    range: sourceRange.exactOptional(),
    details: jsonValue.exactOptional(),
  })
  .strict()
  .meta({ id: 'Diagnostic' });

const status = z
  .enum(['passed', 'failed', 'healed', 'blocked', 'skipped', 'inconclusive', 'error'])
  .meta({ id: 'Status', description: 'Outcome of a step or a scenario. `healed` counts as passed unless the run was strict.' });

const stepKind = z.enum(['given', 'when', 'then']);

const artifactRef = z
  .object({
    sha256,
    path: z.string(),
    kind: z.enum([
      'screenshot', 'observation', 'act-transcript', 'action-log', 'judge-request', 'judge-response',
      'checkgen', 'extract-request', 'extract-response', 'report',
    ]),
    bytes: count,
  })
  .strict()
  .meta({ id: 'ArtifactRef', description: 'A content-addressed file under the run directory (verify-run recomputes the hashes).' });

const chunkRef = z
  .object({ chunkId: z.string(), hash: sha256, relation: z.enum(['source', 'context']), quote: z.string().exactOptional() })
  .strict()
  .meta({ id: 'ChunkRef' });

const fuzzyReason = z.enum([
  'directive', 'subjective', 'volatile-content', 'check-not-discriminative', 'check-generation-failed',
  'confirm-replay-failed', 'confirm-check-failed', 'coordinate-action', 'no-observable-effect', 'heal-threshold',
  'agent-only-driver', 'secret-in-recording', 'unsettled-baseline',
]);

// Same shapes as the predicate of a recorded check (recording/schema.ts); declared here with `exactOptional` so the inferred type
// equals the contract type under exactOptionalPropertyTypes.
const nodeKey = z.object({ role: z.string(), name: z.string() }).strict();
const nodeQuery = z
  .object({
    role: z.string().exactOptional(),
    name: z.string().exactOptional(),
    nameMatch: z.enum(['exact', 'contains']).exactOptional(),
    testId: z.string().exactOptional(),
    within: nodeKey.exactOptional(),
  })
  .strict();
const textValue = z.union([z.object({ literal: z.string() }).strict(), z.object({ param: z.string() }).strict()]);
const predicate = z
  .discriminatedUnion('op', [
    z.object({ op: z.literal('exists'), query: nodeQuery, negate: z.boolean().exactOptional() }).strict(),
    z.object({ op: z.literal('count'), query: nodeQuery, cmp: z.enum(['eq', 'gte', 'lte']), value: z.number() }).strict(),
    z.object({ op: z.literal('text'), query: nodeQuery, match: z.enum(['equals', 'contains']), value: textValue }).strict(),
    z
      .object({
        op: z.literal('state'),
        query: nodeQuery,
        state: z.enum(['checked', 'disabled', 'expanded', 'selected', 'pressed', 'focused', 'busy', 'invalid']),
        value: z.boolean(),
      })
      .strict(),
    z.object({ op: z.literal('route'), match: z.enum(['equals', 'prefix']), value: z.string() }).strict(),
  ])
  .meta({ id: 'Predicate' });

const checkEvaluation = z
  .object({
    passed: z.boolean(),
    results: z.array(
      z.object({ predicate, satisfied: z.union([z.boolean(), z.literal('unknown')]), actual: jsonValue.exactOptional() }).strict(),
    ),
  })
  .strict()
  .meta({ id: 'CheckEvaluation', description: 'A recorded check, evaluated: each predicate with the value that was observed.' });

const judgeVerdict = z
  .object({
    verdict: z.enum(['pass', 'fail', 'inconclusive']),
    score: z.number(),
    spread: z.number(),
    samples: z.array(
      z
        .object({
          probability: z.number(),
          verdict: z.enum(['holds', 'fails', 'cannot_tell']),
          explanation: z.string(),
          observed: z.string(),
        })
        .strict(),
    ),
    reason: z.enum(['band', 'spread']).exactOptional(),
    modelId: z.string(),
    promptVersion: z.string(),
    cached: z.boolean(),
    usage,
  })
  .strict()
  .meta({ id: 'JudgeVerdict' });

const stepResult = z
  .object({
    stepKey: z.string(),
    kind: stepKind,
    text: z.string(),
    status,
    path: z.enum(['fixture', 'replay', 'heal', 'agent', 'check', 'judge', 'check+judge', 'none']),
    determinism: z.enum(['deterministic', 'fuzzy', 'n/a']),
    fuzzyReasons: z.array(fuzzyReason),
    error: errorPayload.exactOptional(),
    check: checkEvaluation.exactOptional(),
    judge: judgeVerdict.exactOptional(),
    actions: count,
    usage,
    durationMs: z.number(),
    evidence: z.array(artifactRef),
    sources: z.array(chunkRef),
  })
  .strict()
  .meta({ id: 'StepResult' });

const scenarioResult = z
  .object({
    scenarioId: z.string(),
    featureId: z.string(),
    docUri: z.string(),
    title: z.string(),
    driver: z.string(),
    status,
    mode: z.enum(['characterize', 'replay', 'mixed']),
    review: z.enum(['unreviewed', 'accepted', 'rejected']),
    steps: z.array(stepResult),
    recording: z.enum(['created', 'updated', 'unchanged', 'discarded', 'none']),
    confirm: z.object({ runs: count, reclassified: z.array(z.string()), failed: z.boolean() }).strict().exactOptional(),
    error: errorPayload.exactOptional(),
    usage,
    durationMs: z.number(),
  })
  .strict()
  .meta({ id: 'ScenarioResult' });

const runUsage = usage.extend({
  byPurpose: z.object({ extract: usage, act: usage, checkgen: usage, judge: usage }).strict(),
  estimatedCostUsd: z.number().exactOptional(),
});

export const RunReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().describe('Also the name of the run directory under .ai-bdd/runs/.'),
    startedAt: z.string().describe('ISO 8601 timestamp.'),
    finishedAt: z.string().describe('ISO 8601 timestamp.'),
    options: z
      .object({
        frozen: z.boolean(),
        strict: z.boolean(),
        audit: z.boolean(),
        noAgent: z.boolean(),
        updateRecordings: z.boolean(),
        recordingsMode: z.enum(['read-write', 'read-only', 'off']),
        workers: count,
      })
      .strict(),
    scenarios: z.array(scenarioResult),
    totals: z
      .object({ passed: count, failed: count, healed: count, blocked: count, skipped: count, inconclusive: count, error: count })
      .strict()
      .describe('Scenario count per status; every status is present.'),
    usage: runUsage,
    coverage: z
      .object({
        docs: z.array(
          z
            .object({
              docUri: z.string(),
              chunks: count,
              covered: count,
              uncovered: z.array(z.string()),
              notTestable: z.array(z.string()),
            })
            .strict(),
        ),
      })
      .strict(),
    warnings: z.array(diagnostic),
    exitCode: z
      .literal([0, 1, 2, 3, 4])
      .describe('The process exit code of `ai-bdd run`: 0 passed, 1 scenario failed, inconclusive or blocked, 2 usage or config, 3 infrastructure, 4 frozen violation.'),
  })
  .strict();

// ───────────────────────── compile-time drift check: schema vs contract type
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Obj<T> = NonNullable<T>;
/** Property `K` of `T`, optional or not; `never` when `T` has no `K`. */
type At<T, K extends PropertyKey> = K extends keyof Obj<T> ? Obj<T>[K] : never;
/** The element type of an array. */
type Item<T> = Obj<T> extends readonly (infer E)[] ? E : never;
/** The variant of a union discriminated by `op` (a predicate). */
type Variant<T, Op> = Extract<Obj<T>, { op: Op }>;
/** The member of a union that has a required `K` (a text value: `literal` or `param`). */
type Having<T, K extends PropertyKey> = Extract<Obj<T>, Record<K, unknown>>;
/** Same property names, optional ones included: assignability cannot see an optional property that only one side declares. */
type SameKeys<A, B> = Mutual<keyof Obj<A>, keyof Obj<B>>;

type Scenario<T> = Item<At<T, 'scenarios'>>;
type Step<T> = Item<At<Scenario<T>, 'steps'>>;
type Judge<T> = At<Step<T>, 'judge'>;
type PredicateResult<T> = Item<At<At<Step<T>, 'check'>, 'results'>>;
type Pred<T> = At<PredicateResult<T>, 'predicate'>;
type ByPurpose<T> = At<At<T, 'usage'>, 'byPurpose'>;
type Warning<T> = Item<At<T, 'warnings'>>;

/** Every object type of the report, by name, and whether the schema `S` and the contract type `C` give it the same property names. */
type ObjectKeySets<S, C> = {
  RunReport: SameKeys<S, C>;
  'RunReport.options': SameKeys<At<S, 'options'>, At<C, 'options'>>;
  'RunReport.totals': SameKeys<At<S, 'totals'>, At<C, 'totals'>>;
  'RunReport.usage': SameKeys<At<S, 'usage'>, At<C, 'usage'>>;
  'RunReport.usage.byPurpose': SameKeys<ByPurpose<S>, ByPurpose<C>>;
  'RunReport.coverage': SameKeys<At<S, 'coverage'>, At<C, 'coverage'>>;
  'RunReport.coverage.docs[]': SameKeys<Item<At<At<S, 'coverage'>, 'docs'>>, Item<At<At<C, 'coverage'>, 'docs'>>>;
  Diagnostic: SameKeys<Warning<S>, Warning<C>>;
  'Diagnostic.range': SameKeys<At<Warning<S>, 'range'>, At<Warning<C>, 'range'>>;
  ScenarioResult: SameKeys<Scenario<S>, Scenario<C>>;
  'ScenarioResult.confirm': SameKeys<At<Scenario<S>, 'confirm'>, At<Scenario<C>, 'confirm'>>;
  'ScenarioResult.error': SameKeys<At<Scenario<S>, 'error'>, At<Scenario<C>, 'error'>>;
  'ScenarioResult.usage': SameKeys<At<Scenario<S>, 'usage'>, At<Scenario<C>, 'usage'>>;
  StepResult: SameKeys<Step<S>, Step<C>>;
  'StepResult.error': SameKeys<At<Step<S>, 'error'>, At<Step<C>, 'error'>>;
  'StepResult.usage': SameKeys<At<Step<S>, 'usage'>, At<Step<C>, 'usage'>>;
  'StepResult.evidence[]': SameKeys<Item<At<Step<S>, 'evidence'>>, Item<At<Step<C>, 'evidence'>>>;
  'StepResult.sources[]': SameKeys<Item<At<Step<S>, 'sources'>>, Item<At<Step<C>, 'sources'>>>;
  CheckEvaluation: SameKeys<At<Step<S>, 'check'>, At<Step<C>, 'check'>>;
  'CheckEvaluation.results[]': SameKeys<PredicateResult<S>, PredicateResult<C>>;
  JudgeVerdict: SameKeys<Judge<S>, Judge<C>>;
  'JudgeVerdict.samples[]': SameKeys<Item<At<Judge<S>, 'samples'>>, Item<At<Judge<C>, 'samples'>>>;
  'JudgeVerdict.usage': SameKeys<At<Judge<S>, 'usage'>, At<Judge<C>, 'usage'>>;
  'Predicate(op: text).value(literal)': SameKeys<Having<At<Variant<Pred<S>, 'text'>, 'value'>, 'literal'>, Having<At<Variant<Pred<C>, 'text'>, 'value'>, 'literal'>>;
  'Predicate(op: text).value(param)': SameKeys<Having<At<Variant<Pred<S>, 'text'>, 'value'>, 'param'>, Having<At<Variant<Pred<C>, 'text'>, 'value'>, 'param'>>;
} & {
  [P in keyof Obj<ByPurpose<C>> as `RunReport.usage.byPurpose.${P & string}`]: SameKeys<At<ByPurpose<S>, P>, At<ByPurpose<C>, P>>;
} & {
  [O in At<Pred<C>, 'op'> as `Predicate(op: ${O & string})`]: SameKeys<Variant<Pred<S>, O>, Variant<Pred<C>, O>>;
} & {
  [O in At<Pred<C>, 'op'> as `Predicate(op: ${O & string}).query`]: SameKeys<At<Variant<Pred<S>, O>, 'query'>, At<Variant<Pred<C>, O>, 'query'>>;
} & {
  [O in At<Pred<C>, 'op'> as `Predicate(op: ${O & string}).query.within`]: SameKeys<
    At<At<Variant<Pred<S>, O>, 'query'>, 'within'>,
    At<At<Variant<Pred<C>, O>, 'query'>, 'within'>
  >;
};

/** The names of the objects whose property names differ; `never` when there are none. */
type KeyDrift<S, C> = { [K in keyof ObjectKeySets<S, C>]: ObjectKeySets<S, C>[K] extends true ? never : K }[keyof ObjectKeySets<S, C>];

/**
 * `true` when the schema `S` and the contract type `C` accept the same values and every object of the report has the same
 * property names on both sides. Otherwise a type that says what differs, so assigning `true` to it fails with that in the message.
 */
export type SchemaMatchesContract<S, C> = [KeyDrift<S, C>] extends [never]
  ? Mutual<S, C> extends true
    ? true
    : { notMutuallyAssignable: true }
  : { propertyNamesDiffer: KeyDrift<S, C> };

/** Compile-time check: the schema and the contract type `RunReport` agree (see `SchemaMatchesContract`). Drift makes this line a type error. */
export const _RUN_REPORT_SCHEMA_MATCHES_TYPE: SchemaMatchesContract<z.infer<typeof RunReportSchema>, RunReport> = true;

export const RUN_REPORT_SCHEMA_ID = 'urn:ai-bdd:schema:run-report:1';
export const RUN_REPORT_SCHEMA_FILE = 'packages/sdk/schema/run-report.v1.schema.json';
export const RUN_REPORT_SCHEMA_COMMAND = 'node scripts/gen-run-report-schema.mjs';

/** The JSON Schema (draft 2020-12) of `RunReport` v1 as an object, key order fixed. */
export function runReportJsonSchema(): Record<string, unknown> {
  const { $schema, ...rest } = z.toJSONSchema(RunReportSchema, { target: 'draft-2020-12', io: 'output' }) as Record<string, unknown>;
  return {
    $schema,
    $id: RUN_REPORT_SCHEMA_ID,
    title: 'ai-bdd run report',
    description: 'The report.json written by `ai-bdd run` (.ai-bdd/report/report.json), schemaVersion 1.',
    ...rest,
  };
}

/** The exact text of the committed schema file: two-space JSON and a final newline. */
export function renderRunReportJsonSchema(): string {
  return `${JSON.stringify(runReportJsonSchema(), null, 2)}\n`;
}
