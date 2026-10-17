import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { ERROR_CODES } from '../../src/contracts/index.ts';
import type { JudgeVerdict, Predicate, PredicateResult, RunReport, ScenarioResult, StepResult, Usage } from '../../src/contracts/index.ts';
import {
  RUN_REPORT_SCHEMA_COMMAND,
  RUN_REPORT_SCHEMA_FILE,
  renderRunReportJsonSchema,
  runReportJsonSchema,
  type RunReportSchema,
  type At,
  type SameKeys,
  type SchemaMatchesContract,
} from '../../src/report/schema.ts';
import { REGENERATE_SCHEMA, SCHEMA_PATH, readJson, runReportValidator } from './schema-kit.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// Compile-time controls of the drift check in schema.ts (`pnpm typecheck`). Each mutation is a copy of the contract type with one
// change; the check must pass for the contract type itself and fail, naming the object, for every mutation.
type Report = z.infer<typeof RunReportSchema>;
type WithScenario<T> = Omit<RunReport, 'scenarios'> & { scenarios: T[] };
type WithStep<T> = WithScenario<Omit<ScenarioResult, 'steps'> & { steps: T[] }>;
type WithJudge<T> = WithStep<Omit<StepResult, 'judge'> & { judge?: T }>;
type WithPredicate<T> = WithStep<Omit<StepResult, 'check'> & { check?: { passed: boolean; results: (Omit<PredicateResult, 'predicate'> & { predicate: T })[] } }>;
type WithJudgeUsage<T> = Omit<RunReport, 'usage'> & { usage: Omit<RunReport['usage'], 'byPurpose'> & { byPurpose: Omit<RunReport['usage']['byPurpose'], 'judge'> & { judge: T } } };
type CountWith<T> = Exclude<Predicate, { op: 'count' }> | (Extract<Predicate, { op: 'count' }> & T);

type _Matches = Expect<Equal<SchemaMatchesContract<Report, RunReport>, true>>;
// a new OPTIONAL field on the contract type: invisible to mutual assignability, caught by the key sets, at every depth
type _OptionalTop = Expect<Equal<SchemaMatchesContract<Report, RunReport & { added?: string }>, { propertyNamesDiffer: 'RunReport' }>>;
type _OptionalScenario = Expect<Equal<SchemaMatchesContract<Report, WithScenario<ScenarioResult & { added?: number }>>, { propertyNamesDiffer: 'ScenarioResult' }>>;
type _OptionalStep = Expect<Equal<SchemaMatchesContract<Report, WithStep<StepResult & { added?: boolean }>>, { propertyNamesDiffer: 'StepResult' }>>;
type _OptionalJudge = Expect<Equal<SchemaMatchesContract<Report, WithJudge<JudgeVerdict & { added?: string }>>, { propertyNamesDiffer: 'JudgeVerdict' }>>;
type _OptionalPredicate = Expect<Equal<SchemaMatchesContract<Report, WithPredicate<CountWith<{ added?: string }>>>, { propertyNamesDiffer: 'Predicate(op: count)' }>>;
type _OptionalByPurpose = Expect<Equal<SchemaMatchesContract<Report, WithJudgeUsage<Usage & { added?: number }>>, { propertyNamesDiffer: 'RunReport.usage.byPurpose.judge' }>>;
// the same mutation written the way schema.ts asserts its check: the assertion does not compile
// @ts-expect-error a new optional field on the contract type is drift
type _AssertionFails = Expect<SchemaMatchesContract<Report, RunReport & { added?: string }>>;
// a new required field, an optional field only the schema declares, and a changed type of an existing field
type _Required = Expect<Equal<SchemaMatchesContract<Report, RunReport & { added: string }>, { propertyNamesDiffer: 'RunReport' }>>;
type _SchemaOnly = Expect<Equal<SchemaMatchesContract<Report & { added?: string }, RunReport>, { propertyNamesDiffer: 'RunReport' }>>;
type _Retyped = Expect<Equal<SchemaMatchesContract<Report, Omit<RunReport, 'runId'> & { runId: number }>, { notMutuallyAssignable: true }>>;
// a row of the check that names a property the report does not have (a typo) is false, not a vacuous `never` vs `never` pass
type ReportScenario = Report['scenarios'][number];
type _RowTypo = Expect<Equal<SameKeys<At<ReportScenario, 'confrim'>, At<ScenarioResult, 'confrim'>>, false>>;
type _RowTypoOneSide = Expect<Equal<SameKeys<At<ReportScenario, 'confirm'>, At<ScenarioResult, 'confrim'>>, false>>;
type _RowReal = Expect<Equal<SameKeys<At<ReportScenario, 'confirm'>, At<ScenarioResult, 'confirm'>>, true>>;
export type _TypeAssertions = [
  _Matches, _OptionalTop, _OptionalScenario, _OptionalStep, _OptionalJudge, _OptionalPredicate, _OptionalByPurpose, _AssertionFails,
  _Required, _SchemaOnly, _Retyped, _RowTypo, _RowTypoOneSide, _RowReal,
];

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const committed = (): Record<string, Json> => readJson(SCHEMA_PATH) as Record<string, Json>;

/** Every sub-schema that describes an object with named properties. */
function objectSchemas(node: Json, path = '#'): { path: string; schema: Record<string, Json> }[] {
  if (node === null || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap((child, i) => objectSchemas(child, `${path}/${i}`));
  const own = node['properties'] !== undefined && typeof node['properties'] === 'object' ? [{ path, schema: node }] : [];
  return [...own, ...Object.entries(node).flatMap(([key, child]) => objectSchemas(child, `${path}/${key}`))];
}

/** The sha256 of run-report.v1.schema.json as released. Version 1 is closed: this constant and that file never change. */
const V1_SHA256 = '7e907a6232b9b8de41e14154243d11612be07d8bba4e831085cf828f4ca3d423';

describe('run report JSON Schema: the committed file', () => {
  it('is version 1 as released: its sha256 is pinned, because a change needs schemaVersion 2 and a new file', () => {
    const sha = createHash('sha256').update(readFileSync(SCHEMA_PATH)).digest('hex');
    expect(
      sha,
      'run-report.v1.schema.json changed. Version 1 is closed and consumers validate against it: a new or changed report field needs schemaVersion 2 and a new file (run-report.v2.schema.json), never an edit of v1',
    ).toBe(V1_SHA256);
  });

  it('is exactly what the generator renders from the zod schema (otherwise: regenerate it)', () => {
    const onDisk = readFileSync(SCHEMA_PATH, 'utf8');
    expect(onDisk, `${RUN_REPORT_SCHEMA_FILE} is out of date: run \`${REGENERATE_SCHEMA}\` and commit the result`).toBe(renderRunReportJsonSchema());
  });

  it('is deterministic: rendering twice gives the same bytes, two-space JSON with one final newline', () => {
    const text = renderRunReportJsonSchema();
    expect(renderRunReportJsonSchema()).toBe(text);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    expect(text).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
    expect(runReportJsonSchema()).toEqual(JSON.parse(text));
  });

  it('names the command that regenerates it, and that command exists in package.json', () => {
    expect(RUN_REPORT_SCHEMA_COMMAND).toBe(REGENERATE_SCHEMA);
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
    const scripts = (readJson(join(root, 'package.json')) as { scripts: Record<string, string> }).scripts;
    expect(scripts['gen:report-schema']).toBe(REGENERATE_SCHEMA);
  });

  it('declares draft 2020-12, an id and a title', () => {
    const schema = committed();
    expect(schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema['$id']).toBe('urn:ai-bdd:schema:run-report:1');
    expect(schema['title']).toBe('ai-bdd run report');
  });

  it('is a valid draft 2020-12 schema that compiles in strict mode (no unknown keywords, no dangling $ref)', () => {
    const ajv = new Ajv2020({ strict: true });
    expect(ajv.validateSchema(committed())).toBe(true);
    expect(() => runReportValidator()).not.toThrow();
  });

  it('closes every object: version 1 has exactly the fields of the contract type', () => {
    const objects = objectSchemas(committed());
    expect(objects.length).toBeGreaterThan(20);
    const open = objects.filter((o) => o.schema['additionalProperties'] !== false).map((o) => o.path);
    expect(open).toEqual([]);
  });

  it('pins version 1, the exit codes and the exhaustive totals', () => {
    const schema = committed();
    const props = schema['properties'] as Record<string, Record<string, Json>>;
    expect(props['schemaVersion']).toEqual({ type: 'number', const: 1 });
    expect(schema['required']).toEqual(Object.keys(props));
    expect(props['exitCode']?.['enum']).toEqual([0, 1, 2, 3, 4]);
    const statuses = ['passed', 'failed', 'healed', 'blocked', 'skipped', 'inconclusive', 'error'];
    expect((schema['$defs'] as Record<string, Record<string, Json>>)['Status']?.['enum']).toEqual(statuses);
    const totals = props['totals'] as { required: string[]; properties: Record<string, Json> };
    expect([...totals.required].sort()).toEqual([...statuses].sort());
    expect(Object.keys(totals.properties).sort()).toEqual([...totals.required].sort());
  });

  it('docs/cli.md states the timestamp pattern and the years toISOString() writes it for (0000 to 9999), and both hold', () => {
    const timestamp = (committed()['properties'] as Record<string, Record<string, Json>>)['startedAt']?.['pattern'] as string;
    const docs = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'docs', 'cli.md'), 'utf8');
    expect(docs).toContain(`\`${timestamp}\``);
    expect(docs).toContain('as `Date.prototype.toISOString()` writes them for the years 0000 to 9999');
    const iso = (year: number): string => new Date(new Date('2000-01-01T00:00:00.000Z').setUTCFullYear(year)).toISOString();
    const matches = (year: number): boolean => new RegExp(timestamp, 'u').test(iso(year));
    expect([0, 1970, 9999].map(matches)).toEqual([true, true, true]);
    expect([iso(-1), iso(10000)]).toEqual(['-000001-01-01T00:00:00.000Z', '+010000-01-01T00:00:00.000Z']);
    expect([-1, 10000].map(matches)).toEqual([false, false]);
  });

  it('lists exactly the contract error codes', () => {
    const codes = (committed()['$defs'] as Record<string, Record<string, Json>>)['ErrorCode'];
    expect(codes?.['enum']).toEqual([...ERROR_CODES]);
  });
});

describe('run report JSON Schema: how a consumer reaches it', () => {
  const sdkDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const manifest = readJson(join(sdkDir, 'package.json')) as { exports: Record<string, unknown>; files: string[] };

  it('is exported from @ai-bdd/sdk as schema/run-report.v1.json and shipped in the package', () => {
    expect(manifest.exports['./schema/run-report.v1.json']).toBe('./schema/run-report.v1.schema.json');
    expect(manifest.files).toContain('schema');
  });

  it('resolves through the package export to the committed file', () => {
    const require = createRequire(import.meta.url);
    const resolved = require.resolve('@ai-bdd/sdk/schema/run-report.v1.json');
    expect(readFileSync(resolved, 'utf8')).toBe(readFileSync(SCHEMA_PATH, 'utf8'));
  });
});
