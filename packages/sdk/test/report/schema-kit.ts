import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

const here = dirname(fileURLToPath(import.meta.url));

/** The committed JSON Schema of the run report (`@ai-bdd/sdk/schema/run-report.v1.json`). */
export const SCHEMA_PATH = join(here, '..', '..', 'schema', 'run-report.v1.schema.json');
/** Regenerate it with this command; the freshness test names it in its failure message. */
export const REGENERATE_SCHEMA = 'node scripts/gen-run-report-schema.mjs';

/** Reports captured from real runs of the offline test project (see fixtures/README.md). */
export const FIXTURE_DIR = join(here, 'fixtures');
export type FixtureName = 'passed' | 'failed';
export const fixturePath = (name: FixtureName): string => join(FIXTURE_DIR, `report.v1.${name}.json`);
export const REGENERATE_FIXTURES = 'UPDATE_REPORT_FIXTURES=1 pnpm exec vitest run --project acceptance tests/acceptance/m28-run-report-contract.test.ts';

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

export const readFixture = (name: FixtureName): Record<string, unknown> => readJson(fixturePath(name)) as Record<string, unknown>;

/** A validator for the committed schema the way a consumer would build one: Ajv, draft 2020-12, strict mode, every error reported. */
export function runReportValidator(): ValidateFunction {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  return ajv.compile(readJson(SCHEMA_PATH) as object);
}

export interface Verdict {
  valid: boolean;
  errors: ErrorObject[];
}

export function validateWithSchema(validate: ValidateFunction, value: unknown): Verdict {
  const valid = validate(value) === true;
  return { valid, errors: valid ? [] : [...(validate.errors ?? [])] };
}

export function describeErrors(errors: readonly ErrorObject[]): string {
  return errors.map((e) => `${e.instancePath === '' ? '(root)' : e.instancePath} ${e.message ?? e.keyword}`).join('; ');
}
