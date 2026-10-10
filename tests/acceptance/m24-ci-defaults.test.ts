import { afterEach, describe, expect, it } from 'vitest';
import { cliOutput, runCli } from './helpers/cli.ts';
import { recordingFiles } from './helpers/plans.ts';
import { createProject, FAST_REAL, type Project } from './helpers/project.ts';

let project: Project | undefined;
afterEach(() => {
  project?.cleanup();
  project = undefined;
});

async function compiled(): Promise<Project> {
  const p = createProject({ docs: ['release-notes'], options: FAST_REAL });
  project = p;
  const c = await runCli(p, ['compile']);
  expect(c.code, cliOutput(c)).toBe(0);
  return p;
}

describe('M24 CI defaults', () => {
  it('M24 R-CH6 R-RN4 R-RN3: CI=1 run -u fails with RECORDING_READ_ONLY (exit 2)', async () => {
    const p = await compiled();
    const r = await runCli(p, ['run', '-u', 'docs/release-notes.md'], { env: { CI: '1' } });
    expect(r.code, cliOutput(r)).toBe(2);
    expect(r.stdout + r.stderr).toContain('RECORDING_READ_ONLY');
    expect(recordingFiles(p)).toEqual([]);
  });

  it('M24 R-CH6 R-RN4: CI=1 run characterizes but writes no recordings, and exits 0 when everything passes', async () => {
    const p = await compiled();
    const r = await runCli(p, ['run', 'docs/release-notes.md'], { env: { CI: '1' } });
    expect(r.code, cliOutput(r)).toBe(0);
    expect(recordingFiles(p)).toEqual([]);
    // the same command outside CI does write one
    const local = await runCli(p, ['run', 'docs/release-notes.md']);
    expect(local.code, cliOutput(local)).toBe(0);
    expect(recordingFiles(p).length).toBe(1);
  });

  it('M24 R-RN4: CI=1 defaults to --frozen: a stale plan exits 4 without running anything', async () => {
    const p = await compiled();
    p.editDoc('release-notes', 'The page lists what changed in each release of Acme.', 'The page lists what changed in every release of Acme.');
    const r = await runCli(p, ['run', 'docs/release-notes.md'], { env: { CI: 'true' } });
    expect(r.code, cliOutput(r)).toBe(4);
  });

  it('M24 R-RN4: AI_BDD_RECORDINGS=read-write re-enables writes under CI=1, including -u', async () => {
    const p = await compiled();
    const r = await runCli(p, ['run', '-u', 'docs/release-notes.md'], { env: { CI: '1', AI_BDD_RECORDINGS: 'read-write' } });
    expect(r.code, cliOutput(r)).toBe(0);
    expect(recordingFiles(p).length).toBe(1);
  });
});
