import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { COMMAND, OUTPUT, renderSchema, run } from '../gen-run-report-schema.mjs';
import { cleanup, makeRepo } from './fixture.mjs';

const render = async () => '{\n  "title": "x"\n}\n';

test('writes the schema file, creating its directory', async () => {
  const root = makeRepo({});
  try {
    const r = await run(root, { render });
    assert.equal(r.ok, true);
    assert.equal(fs.readFileSync(path.join(root, OUTPUT), 'utf8'), await render());
  } finally {
    cleanup(root);
  }
});

test('--check fails when the file is missing or drifts, names the regeneration command, and passes after writing', async () => {
  const root = makeRepo({});
  try {
    const missing = await run(root, { check: true, render });
    assert.equal(missing.ok, false);
    assert.match(missing.problems[0], /missing/);
    assert.ok(missing.problems[0].includes(COMMAND), 'the message carries the command that regenerates the file');

    await run(root, { render });
    assert.equal((await run(root, { check: true, render })).ok, true);

    fs.appendFileSync(path.join(root, OUTPUT), ' \n');
    const drift = await run(root, { check: true, render });
    assert.equal(drift.ok, false);
    assert.match(drift.problems[0], /out of date/);
    assert.ok(drift.problems[0].includes(COMMAND));
  } finally {
    cleanup(root);
  }
});

test('the real generator renders the committed file from the zod schema', async () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  assert.equal(await renderSchema(repo), fs.readFileSync(path.join(repo, OUTPUT), 'utf8'));
  assert.equal(COMMAND, 'node scripts/gen-run-report-schema.mjs');
});
