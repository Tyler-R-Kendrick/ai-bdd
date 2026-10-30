import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import {
  openEngine,
  type EngineHandle,
} from '../../../../tests/acceptance/helpers/engine.ts';
import {
  T,
  scenarioId,
  recordingOf,
} from '../../../../tests/acceptance/helpers/plans.ts';
import {
  createProject,
  type Project,
} from '../../../../tests/acceptance/helpers/project.ts';
import {
  artifactFiles,
  latestRunDir,
} from '../../../../tests/acceptance/helpers/runs.ts';

let project: Project | undefined;
const engines: EngineHandle[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0).reverse()) await engine.close();
  project?.cleanup();
  project = undefined;
});

it('wires the production engine modules through compile, characterize, durable replay and independent artifact verification', async () => {
  // Only the configured model and application driver are deterministic fakes.
  // No EngineModules are replaced: extraction, planning, recording, settling,
  // evidence, reports and verification exercise their public production wiring.
  const p = createProject({ docs: ['billing'] });
  project = p;
  const first = await openEngine(p);
  engines.push(first);
  expect((await first.compile()).exitCode).toBe(0);
  const id = scenarioId(await first.plans(), T.upgrade);
  const characterized = await first.run({ selectors: [id] });
  expect(characterized.exitCode).toBe(0);
  expect(characterized.scenarios[0]).toMatchObject({
    status: 'passed',
    mode: 'characterize',
    recording: 'created',
  });
  const recording = recordingOf(p, id);
  expect(recording?.steps).toHaveLength(6);
  expect(
    recording?.steps.every((step) => step.determinism === 'deterministic'),
  ).toBe(true);
  expect(first.counts().act).toBeGreaterThan(0);
  expect(first.counts().judge).toBeGreaterThan(0);
  const directory = latestRunDir(p);
  expect(await first.engine.verifyRun(directory)).toEqual({
    ok: true,
    problems: [],
  });
  const artifact = artifactFiles(directory)[0]!;
  const original = readFileSync(artifact);
  writeFileSync(artifact, Buffer.concat([original, Buffer.from('tampered')]));
  expect((await first.engine.verifyRun(directory)).ok).toBe(false);
  writeFileSync(artifact, original);
  expect((await first.engine.verifyRun(directory)).ok).toBe(true);
  await first.close();
  engines.splice(engines.indexOf(first), 1);

  const second = await openEngine(p);
  engines.push(second);
  const replayed = await second.run({ selectors: [id] });
  expect(replayed.exitCode).toBe(0);
  expect(replayed.scenarios[0]).toMatchObject({
    status: 'passed',
    mode: 'replay',
  });
  expect(second.counts()).toEqual({
    extract: 0,
    act: 0,
    checkgen: 0,
    judge: 0,
  });
});
