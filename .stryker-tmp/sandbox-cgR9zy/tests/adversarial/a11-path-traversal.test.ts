// @ts-nocheck
// Attack 11: path traversal through docUri, scenario ids, planDir, run directories and verify-run (R-PL4, R-EV1).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPlanStore, createRecordingStore, createEvidenceStore, createRedactor, loadPlansSync, stableJson, verifyRun } from '@ai-bdd/sdk';
import type { DocPlan, ScenarioRecording } from '@ai-bdd/sdk/contracts';
import { cliOutput, createProject, extraction, makeEngine, modelSet, openEngine, quoteFrom, runCli, StubSession, walkFiles, type Project } from './helpers/kit.ts';

let project: Project | undefined;
const cleanups: string[] = [];
afterEach(() => {
  project?.cleanup();
  project = undefined;
  for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(d);
  return d;
};

const emptyPlan = (docUri: string): DocPlan => ({
  schemaVersion: 1,
  docUri,
  docSha256: '0'.repeat(64),
  extractor: { modelId: 'm', promptVersion: 'p' },
  sections: [],
  chunks: [],
  features: [],
  notTestable: [],
  rejected: [],
  uncovered: [],
});

describe('A11 R-PL4 plan store path safety', () => {
  const bad = ['../x', 'a/../../x', 'a/..', '..', '/etc/passwd', '/abs/doc.md', 'C:\\Windows\\x', 'C:/x', 'a\\b', 'a\\..\\..\\b', '', 'a\0b', 'docs/../../outside', './../x', '....//x', 'a/b/../../../c'];
  for (const uri of bad) {
    it(`A11 R-PL4: rejects docUri ${JSON.stringify(uri)} for save, load and remove without touching the file system outside`, async () => {
      const root = tmp('a11-');
      const dir = join(root, 'plans');
      mkdirSync(dir, { recursive: true });
      const store = createPlanStore({ dir, readOnly: false });
      await expect(store.save(emptyPlan(uri))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      await expect(store.load(uri)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      await expect(store.remove(uri)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      expect(readdirSync(root)).toEqual(['plans']);
      expect(readdirSync(dir)).toEqual([]);
    });
  }

  it('A11 R-PL4: a read-only plan store refuses to write or delete', async () => {
    const root = tmp('a11-');
    const store = createPlanStore({ dir: join(root, 'plans'), readOnly: true });
    await expect(store.save(emptyPlan('docs/a.md'))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(store.remove('docs/a.md')).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });

  it('A11 R-PL4: a plan file whose content claims another docUri than its path is corrupt (it cannot impersonate another document)', () => {
    const root = tmp('a11-');
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'a.md.plan.json'), stableJson(emptyPlan('docs/b.md') as never));
    expect(() => loadPlansSync(root)).toThrowError(/PLAN_CORRUPT|does not match its path/);
  });

  it('A11 R-PL4: schema versions other than 1 and structurally broken plans are rejected, never half-loaded', () => {
    const root = tmp('a11-');
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'a.md.plan.json'), JSON.stringify({ ...emptyPlan('docs/a.md'), schemaVersion: 2 }));
    expect(() => loadPlansSync(root)).toThrowError(/PLAN_SCHEMA_UNSUPPORTED|schemaVersion/);
    writeFileSync(join(root, 'docs', 'a.md.plan.json'), JSON.stringify({ ...emptyPlan('docs/a.md'), features: 'nope' }));
    expect(() => loadPlansSync(root)).toThrowError(/PLAN_CORRUPT|plan/i);
    writeFileSync(join(root, 'docs', 'a.md.plan.json'), '{not json');
    expect(() => loadPlansSync(root)).toThrowError(/PLAN_CORRUPT|JSON/);
  });

  it('A11 R-PL4: a plan directory containing a symlink to the outside is not followed when reading', () => {
    const root = tmp('a11-');
    const outside = tmp('a11-out-');
    mkdirSync(join(outside, 'docs'), { recursive: true });
    writeFileSync(join(outside, 'docs', 'evil.md.plan.json'), stableJson(emptyPlan('docs/evil.md') as never));
    symlinkSync(outside, join(root, 'linked'));
    expect(loadPlansSync(root)).toEqual([]);
  });
});

describe('A11 R-PL4 symlinks planted in the repository cannot redirect writes outside the project', () => {
  async function compileWithLink(linkRel: string[], opts: { pre?: (p: Project) => void } = {}): Promise<{ outside: string; exitCode: number; error?: unknown }> {
    project = createProject({ docs: [] });
    project.writeDoc('notes', '# Notes\n\n## Reading\n\nCustomers open the release notes from the primary navigation. The page shows the heading Release notes.\n');
    const outside = tmp('a11-out-');
    const linkPath = project.path(...linkRel);
    mkdirSync(join(linkPath, '..'), { recursive: true });
    symlinkSync(outside, linkPath);
    opts.pre?.(project);
    const models = modelSet({
      extract: (req) => {
        const q = quoteFrom(req, 'Customers open the release notes');
        return q === null ? { object: extraction([]) } : { object: extraction([{ title: 'Notes', sources: [q], scenarios: [{ title: 'Open', sources: [q], steps: [{ kind: 'when', text: 'the customer opens the release notes' }, { kind: 'then', text: 'the heading is shown' }] }] }]) };
      },
    });
    const h = await makeEngine(project, { models });
    try {
      const res = await h.engine.compile();
      return { outside, exitCode: res.exitCode };
    } catch (error) {
      return { outside, exitCode: -1, error };
    } finally {
      await h.close();
    }
  }

  it('A11 R-PL4: `.ai-bdd/plans/docs` is a symlink to a directory outside the project: compile does not write the plan there', async () => {
    const r = await compileWithLink(['.ai-bdd', 'plans', 'docs']);
    expect(walkFiles(r.outside), `compile wrote outside the project (exit ${r.exitCode}, error ${String(r.error)})`).toEqual([]);
  });

  it('A11 R-PL4: `.ai-bdd/runs` is a symlink to a directory outside the project: a run does not write evidence there', async () => {
    project = createProject({ docs: ['billing'] });
    const outside = tmp('a11-out-');
    rmSync(project.runsDir, { recursive: true, force: true });
    mkdirSync(project.aiBddDir, { recursive: true });
    symlinkSync(outside, project.runsDir);
    const h = await openEngine(project);
    await h.compile();
    // Failing closed is the expected outcome: the run is refused with POLICY_DENIED. Completing without evidence would also be acceptable.
    const error = await h.run({ titles: ['Upgrade button is visible on the Free plan'] }).then(() => undefined, (e: unknown) => e);
    if (error !== undefined) expect(error).toMatchObject({ code: 'POLICY_DENIED' });
    await h.close();
    expect(walkFiles(outside), 'evidence written through a planted symlink').toEqual([]);
  });
});

describe('A11 R-PL4 recording paths', () => {
  const rec = (scenarioId: string, driverId: string): ScenarioRecording => ({
    schemaVersion: 1,
    scenarioId,
    scenarioFingerprint: '0'.repeat(64),
    driver: { id: driverId, major: 1 },
    steps: [],
    promptVersions: { act: 'a', checkgen: 'c', judge: 'j' },
  });
  const badIds = ['../../x', 'a/../../x', 'a/./b', '/abs', 'a//b', 'A/B', 'a b', 'a\\b', 'a\0b', '', '.', '..', 'a/..', 'é/x', 'a:b', 'a/b\n'];
  for (const id of badIds) {
    it(`A11 R-PL4: scenario id ${JSON.stringify(id)} cannot be saved, loaded or removed as a recording`, async () => {
      const root = tmp('a11-');
      const store = createRecordingStore({ dir: join(root, 'rec'), mode: 'read-write' });
      await expect(store.save(rec(id, 'fake'))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      await expect(store.load('fake', id)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      await expect(store.remove('fake', id)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      expect(existsSync(join(root, 'rec'))).toBe(false);
    });
  }
  for (const driverId of ['../x', 'a/b', 'a\\b', '', '..', 'A', 'x y']) {
    it(`A11 R-PL4: driver id ${JSON.stringify(driverId)} cannot select a recording directory`, async () => {
      const root = tmp('a11-');
      const store = createRecordingStore({ dir: join(root, 'rec'), mode: 'read-write' });
      await expect(store.save(rec('feature/scenario', driverId))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      expect(existsSync(join(root, 'rec'))).toBe(false);
    });
  }

  it('A11 R-PL4: a recording file whose content names another scenario than its path is rejected (RECORDING_CORRUPT)', async () => {
    const root = tmp('a11-');
    const store = createRecordingStore({ dir: join(root, 'rec'), mode: 'read-write' });
    await store.save(rec('feature/one', 'fake'));
    const file = join(root, 'rec', 'fake', 'feature', 'one.json');
    writeFileSync(join(root, 'rec', 'fake', 'feature', 'two.json'), readFileSync(file, 'utf8'));
    await expect(store.load('fake', 'feature/two')).rejects.toMatchObject({ code: 'RECORDING_CORRUPT' });
  });

  it('A11 R-PL4: a session whose driverId is a traversal string (sessionFactory) makes the scenario an error and writes nothing outside the recordings directory', async () => {
    project = createProject({ docs: ['billing'] });
    const h = await openEngine(project);
    await h.compile();
    const id = (await h.plans())[0]?.features[0]?.scenarios[0]?.id ?? '';
    const stub = new StubSession(() => ({ nodes: [{ role: 'heading', name: 'Billing', depth: 0, level: 1, states: {} }] }), () => ({ ok: true }), { driverId: '../../../escape' });
    const r = await h.engine.runScenario(id, { sessionFactory: async () => stub });
    await h.close();
    expect(r.status).not.toBe('passed');
    expect(existsSync(join(project.dir, '..', 'escape'))).toBe(false);
    expect(existsSync(join(project.dir, 'escape'))).toBe(false);
    expect(walkFiles(project.recordingsDir)).toEqual([]);
  });

  it('A11 R-PL4: a plan file edited to carry a traversal scenario id fails closed when that scenario runs', async () => {
    project = createProject({ docs: ['billing'] });
    const h = await openEngine(project);
    await h.compile();
    await h.close();
    const file = project.path('.ai-bdd', 'plans', 'docs', 'billing.md.plan.json');
    const plan = JSON.parse(readFileSync(file, 'utf8')) as DocPlan;
    const sc = plan.features[0]?.scenarios[0];
    expect(sc).toBeDefined();
    if (sc) sc.id = '../../../../tmp/a11-escaped';
    writeFileSync(file, stableJson(plan as never));
    const h2 = await openEngine(project);
    const r = await h2.engine.runScenario('../../../../tmp/a11-escaped', { driver: 'fake' });
    await h2.close();
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('POLICY_DENIED');
    expect(existsSync('/tmp/a11-escaped.json')).toBe(false);
  });
});

describe('A11 R-EV1 verify-run and run directories', () => {
  async function realRun(): Promise<{ dir: string; project: Project }> {
    project = createProject({ docs: ['billing'] });
    const h = await openEngine(project);
    await h.compile();
    await h.run({ titles: ['Upgrade from Free to Pro'] });
    await h.close();
    const runs = readdirSync(project.runsDir);
    return { dir: join(project.runsDir, runs[runs.length - 1] as string), project };
  }

  it('A11 R-EV1: a manifest that lists a traversal / absolute / backslash / nested artifact path is reported, and the outside file is never reported as fine', async () => {
    const { dir } = await realRun();
    const secretOutside = tmp('a11-out-');
    writeFileSync(join(secretOutside, 'victim.txt'), 'outside');
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { artifacts: { sha256: string; path: string; kind: string; bytes: number }[]; digest: string; runId: string };
    for (const bad of ['../../../../etc/passwd', '/etc/passwd', 'artifacts/../../manifest.json', 'artifacts\\..\\x', `../${secretOutside}/victim.txt`, 'artifacts/', 'artifacts']) {
      const crafted = { ...manifest, artifacts: [...manifest.artifacts, { sha256: '0'.repeat(64), path: bad, kind: 'report', bytes: 1 }] };
      const probe = tmp('a11-run-');
      writeFileSync(join(probe, 'manifest.json'), JSON.stringify(crafted));
      const r = await verifyRun(probe);
      expect(r.ok, bad).toBe(false);
      expect(r.problems.join('\n'), bad).toMatch(/unsafe path|missing|inconsistent|digest/);
    }
  });

  it('A11 R-EV1: verifying a directory that is not a run, an empty directory and a manifest of the wrong shape all fail closed (exit 1 through the CLI)', async () => {
    project = createProject({ docs: [] });
    const empty = project.path('empty-run');
    mkdirSync(empty);
    const a = await runCli(project, ['verify-run', 'empty-run']);
    expect(a.code, cliOutput(a)).toBe(1);
    writeFileSync(join(empty, 'manifest.json'), '[]');
    const b = await runCli(project, ['verify-run', 'empty-run']);
    expect(b.code, cliOutput(b)).toBe(1);
    writeFileSync(join(empty, 'manifest.json'), JSON.stringify({ runId: 'x', digest: 'y', artifacts: [{ path: 1 }] }));
    const c = await runCli(project, ['verify-run', 'empty-run']);
    expect(c.code, cliOutput(c)).toBe(1);
    const d = await runCli(project, ['verify-run', '../../../../../../../../nonexistent']);
    expect(d.code, cliOutput(d)).toBe(1);
  });

  it('A11 R-EV1: replacing an artifact by a symlink to a file with the same content is not accepted as a regular artifact', async () => {
    const { dir } = await realRun();
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { artifacts: { path: string }[] };
    const first = manifest.artifacts[0]?.path;
    expect(first).toBeDefined();
    const target = join(dir, first as string);
    const copy = join(tmp('a11-out-'), 'same');
    writeFileSync(copy, readFileSync(target));
    rmSync(target);
    symlinkSync(copy, target);
    const r = await verifyRun(dir);
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/not a regular file/);
  });

  it('A11 R-EV1: an extra file dropped into the artifacts directory, a flipped byte, and a deleted artifact are each reported', async () => {
    const { dir } = await realRun();
    expect((await verifyRun(dir)).ok).toBe(true);
    writeFileSync(join(dir, 'artifacts', 'planted.json'), '{}');
    expect((await verifyRun(dir)).problems.join('\n')).toContain('extra');
    rmSync(join(dir, 'artifacts', 'planted.json'));
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { artifacts: { path: string }[] };
    const files = manifest.artifacts.map((a) => join(dir, a.path));
    const one = files[0] as string;
    const original = readFileSync(one);
    const flipped = Buffer.from(original);
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    writeFileSync(one, flipped);
    expect((await verifyRun(dir)).problems.join('\n')).toContain('modified');
    writeFileSync(one, original);
    rmSync(files[1] as string);
    expect((await verifyRun(dir)).problems.join('\n')).toContain('missing');
  });

  it('A11 R-EV1: the evidence store refuses an unsafe run id', async () => {
    const root = tmp('a11-');
    for (const runId of ['', '.', '..', '../x', 'a/b', 'a\\b', 'a\0b']) {
      await expect(createEvidenceStore({ runsDir: root, runId, redactor: createRedactor({}) })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    }
    expect(readdirSync(root)).toEqual([]);
  });
});

describe('A11 R-PL4 document discovery', () => {
  it('A11 R-PL4: documents reached through a symlink to a file outside the project are refused (POLICY_DENIED), not read', async () => {
    project = createProject({ docs: [] });
    const outside = tmp('a11-out-');
    writeFileSync(join(outside, 'secret.md'), '# Secret\n\n## S\n\nThe launch code is 0000 and must stay private.\n');
    symlinkSync(join(outside, 'secret.md'), project.path('docs', 'linked.md'));
    const sent: string[] = [];
    const models = modelSet({ extract: (req) => { sent.push(JSON.stringify(req)); return { object: extraction([]) }; } });
    const h = await makeEngine(project, { models });
    await expect(h.engine.compile()).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await h.close();
    expect(sent.join('')).not.toContain('launch code');
  });

  it('A11 R-PL4: a document called `a..b.md` (dots in the middle of a name) compiles instead of aborting the whole compile', async () => {
    project = createProject({ docs: [] });
    project.writeDoc('release..notes', '# Notes\n\n## Reading\n\nCustomers open the release notes from the primary navigation. The page shows the heading Release notes.\n');
    const models = modelSet({ extract: () => ({ object: extraction([]) }) });
    const h = await makeEngine(project, { models });
    const res = await h.engine.compile().catch((e: unknown) => e);
    await h.close();
    expect(res instanceof Error ? `threw ${(res as { code?: string }).code}: ${res.message}` : 'compiled').toBe('compiled');
  });

  it('A11 R-PL4: `compile` document arguments that point outside the project select nothing and read nothing', async () => {
    project = createProject({ docs: ['billing'] });
    const outside = tmp('a11-out-');
    writeFileSync(join(outside, 'x.md'), '# X\n\n## Y\n\nOutside text that must never be read by the compiler.\n');
    const r = await runCli(project, ['compile', join(outside, 'x.md'), '../x.md', '/etc/passwd']);
    expect(`${r.stdout}${r.stderr}`).not.toContain('Outside text');
    expect(existsSync(project.path('.ai-bdd', 'plans', 'x.md.plan.json'))).toBe(false);
  });
});
