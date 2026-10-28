#!/usr/bin/env node
// Generates packages/sdk/schema/run-report.v2.schema.json, the JSON Schema (draft 2020-12) of the run report, from the zod schema
// in packages/sdk/src/report/schema.ts (which a compile-time check ties to the `RunReport` contract type).
//   node scripts/gen-run-report-schema.mjs           write the file
//   node scripts/gen-run-report-schema.mjs --check   fail when the file differs from what would be generated
// The TypeScript source is loaded through Node's type stripping (Node >= 22.18, the repository's engine).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMain, parseArgs } from './lib.mjs';

const SOURCE = 'packages/sdk/src/report/schema.ts';
export const OUTPUT = 'packages/sdk/schema/run-report.v2.schema.json';
export const COMMAND = 'node scripts/gen-run-report-schema.mjs';

/** The text the committed file must have, from the schema module under `root`. */
export async function renderSchema(root) {
  const mod = await import(pathToFileURL(path.join(root, SOURCE)).href);
  return mod.renderRunReportJsonSchema();
}

/** Writes (or, with `check`, verifies) the schema file. `render` is injectable for tests. */
export async function run(root, { check = false, render = renderSchema } = {}) {
  const expected = await render(root);
  const file = path.join(root, OUTPUT);
  if (check) {
    let actual = null;
    try {
      actual = fs.readFileSync(file, 'utf8');
    } catch {
      /* a missing file is drift */
    }
    if (actual === expected) return { ok: true, problems: [], summary: `${OUTPUT} is in sync` };
    return { ok: false, problems: [`${OUTPUT} is ${actual === null ? 'missing' : 'out of date'}: run ${COMMAND}`] };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, expected);
  return { ok: true, problems: [], summary: `wrote ${OUTPUT}` };
}

if (isMain(import.meta.url)) {
  const { root, flags } = parseArgs(process.argv.slice(2), import.meta.url);
  const result = await run(root, { check: flags.has('--check') });
  if (result.ok) {
    console.log(`gen-run-report-schema: ${result.summary}`);
  } else {
    console.error('gen-run-report-schema: FAILED');
    for (const p of result.problems) console.error(`  - ${p}`);
    process.exit(1);
  }
}
