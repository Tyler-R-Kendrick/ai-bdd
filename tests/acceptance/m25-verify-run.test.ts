import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { cliOutput, runCli } from './helpers/cli.ts';
import { createProject, FAST_REAL, type Project } from './helpers/project.ts';
import { artifactFiles, latestRunDir, readManifest } from './helpers/runs.ts';
import { openEngine } from './helpers/engine.ts';

let project: Project | undefined;
afterEach(() => {
  project?.cleanup();
  project = undefined;
});

describe('M25 verify-run', () => {
  it('M25 R-EV1: an untouched run dir verifies (exit 0); one flipped byte or one deleted artifact is detected (exit 1)', async () => {
    const p = createProject({ docs: ['release-notes'], options: FAST_REAL });
    project = p;
    const ran = await runCli(p, ['run', 'docs/release-notes.md']);
    expect(ran.code, cliOutput(ran)).toBe(0);
    const dir = latestRunDir(p);
    const manifest = readManifest(dir);
    expect(manifest.artifacts.length).toBeGreaterThan(0);
    expect(manifest.digest).toMatch(/^[0-9a-f]{64}$/);

    const ok = await runCli(p, ['verify-run', dir]);
    expect(ok.code, cliOutput(ok)).toBe(0);

    const files = artifactFiles(dir);
    expect(files.length).toBeGreaterThanOrEqual(2);
    const victim = files[0] as string;
    const original = readFileSync(victim);
    const flipped = Buffer.from(original);
    flipped[0] = (flipped[0] ?? 0) ^ 0x01;
    writeFileSync(victim, flipped);
    const modified = await runCli(p, ['verify-run', dir]);
    expect(modified.code, cliOutput(modified)).toBe(1);
    expect(modified.stdout + modified.stderr).toMatch(/modified/);

    writeFileSync(victim, original);
    expect((await runCli(p, ['verify-run', dir])).code).toBe(0);

    rmSync(files[1] as string);
    const missing = await runCli(p, ['verify-run', dir]);
    expect(missing.code, cliOutput(missing)).toBe(1);
    expect(missing.stdout + missing.stderr).toMatch(/missing/);
  });

  it('M25 R-EV1: engine.verifyRun reports modified, missing and extra artifacts and a tampered digest', async () => {
    const p = createProject({ docs: ['release-notes'] });
    project = p;
    const h = await openEngine(p);
    await h.compile();
    const report = await h.run({ selectors: ['docs/release-notes.md'] });
    expect(report.exitCode).toBe(0);
    const dir = latestRunDir(p);
    expect(await h.engine.verifyRun(dir)).toEqual({ ok: true, problems: [] });

    const files = artifactFiles(dir);
    const victim = files[0] as string;
    const original = readFileSync(victim);
    writeFileSync(victim, Buffer.concat([original, Buffer.from(' ')]));
    const modified = await h.engine.verifyRun(dir);
    expect(modified.ok).toBe(false);
    expect(modified.problems.join('\n')).toMatch(/modified/);
    writeFileSync(victim, original);

    writeFileSync(`${dir}/artifacts/zz-extra.json`, '{}');
    const extra = await h.engine.verifyRun(dir);
    expect(extra.ok).toBe(false);
    expect(extra.problems.join('\n')).toMatch(/extra/);
    rmSync(`${dir}/artifacts/zz-extra.json`);

    const manifestPath = `${dir}/manifest.json`;
    const manifest = readFileSync(manifestPath, 'utf8');
    writeFileSync(manifestPath, `${JSON.stringify({ ...(JSON.parse(manifest) as object), digest: '0'.repeat(64) }, null, 2)}\n`);
    const digest = await h.engine.verifyRun(dir);
    expect(digest.ok).toBe(false);
    writeFileSync(manifestPath, manifest);
    expect((await h.engine.verifyRun(dir)).ok).toBe(true);
    await h.close();
  });
});
