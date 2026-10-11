import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('../../docs/requirements.json', import.meta.url));

test('docs/requirements.json lists the 39 spec requirement ids with text', () => {
  const reqs = JSON.parse(fs.readFileSync(file, 'utf8'));
  const counts = { EX: 6, PL: 4, CH: 7, AS: 4, JU: 3, AG: 4, FX: 1, SE: 2, RN: 4, SDK: 3, EV: 1 };
  const expected = Object.entries(counts).flatMap(([g, n]) => Array.from({ length: n }, (_, i) => `R-${g}${i + 1}`));
  assert.equal(expected.length, 39);
  assert.deepEqual(reqs.map((r) => r.id), expected);
  for (const r of reqs) assert.ok(r.text.length > 10, r.id);
});
