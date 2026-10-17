import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '../../src/contracts/index.ts';
import { RUN_REPORT_SCHEMA_COMMAND, RUN_REPORT_SCHEMA_FILE, renderRunReportJsonSchema, runReportJsonSchema } from '../../src/report/schema.ts';
import { REGENERATE_SCHEMA, SCHEMA_PATH, readJson, runReportValidator } from './schema-kit.ts';

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
const V1_SHA256 = '1efd7ec47083fc69fdb60b87e941778e5976810e4262acdd767231c9976e2d9a';

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
