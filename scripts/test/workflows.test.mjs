import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';

// The workflow files are parsed with the same YAML library the SDK uses for front matter. A syntax error in a workflow makes
// GitHub skip every job without a message on the pull request, so it is checked here.
const root = path.resolve(import.meta.dirname, '..', '..');
const { parse } = createRequire(path.join(root, 'packages', 'sdk', 'package.json'))('yaml');
const dir = path.join(root, '.github', 'workflows');

for (const file of fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
  test(`${file} is valid YAML and every job has a runner and steps`, () => {
    const doc = parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    assert.ok(doc.jobs && Object.keys(doc.jobs).length > 0, 'has jobs');
    for (const [name, job] of Object.entries(doc.jobs)) {
      assert.ok(job['runs-on'], `${name}: runs-on`);
      assert.ok(Array.isArray(job.steps) && job.steps.length > 0, `${name}: steps`);
      for (const step of job.steps) assert.ok(step.run !== undefined || step.uses !== undefined, `${name}: step ${JSON.stringify(step.name ?? step)} runs or uses something`);
      for (const needed of [job.needs ?? []].flat()) assert.ok(doc.jobs[needed], `${name}: needs ${needed}`);
    }
  });
}
