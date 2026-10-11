import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { countByPurpose, readFakeLog } from './helpers/calls.ts';
import { cliOutput, runCli } from './helpers/cli.ts';
import { planFiles } from './helpers/plans.ts';
import { createProject, FAST_REAL, type Project } from './helpers/project.ts';
import { runDirs } from './helpers/runs.ts';

let project: Project | undefined;
afterEach(() => {
  project?.cleanup();
  project = undefined;
});

describe('M15 --frozen', () => {
  it('M15 R-PL2 R-RN3: run --frozen after editing a doc exits 4 and nothing runs; compile --check exits 4 and writes nothing', async () => {
    const p = createProject({ docs: ['billing'], options: FAST_REAL });
    project = p;
    const compiled = await runCli(p, ['compile']);
    expect(compiled.code, cliOutput(compiled)).toBe(0);
    const fresh = await runCli(p, ['compile', '--check']);
    expect(fresh.code, cliOutput(fresh)).toBe(0);

    p.editDoc('billing', 'Refunds and invoice disputes are handled by the support team', 'Refunds and invoice disputes are handled by our support team');
    const plansBefore = planFiles(p);
    const logBefore = readFakeLog(p.logPath);

    const frozen = await runCli(p, ['run', '--frozen', 'docs/billing.md']);
    expect(frozen.code, cliOutput(frozen)).toBe(4);
    expect(runDirs(p)).toHaveLength(0);
    const logAfter = readFakeLog(p.logPath);
    expect(logAfter).toHaveLength(logBefore.length);
    expect(countByPurpose(logAfter).act + countByPurpose(logAfter).judge + countByPurpose(logAfter).checkgen).toBe(0);

    const check = await runCli(p, ['compile', '--check']);
    expect(check.code, cliOutput(check)).toBe(4);
    expect(planFiles(p)).toEqual(plansBefore);

    const status = await runCli(p, ['status', '--json']);
    expect(status.code, cliOutput(status)).toBe(0);
    const parsed = JSON.parse(status.stdout) as { docs?: { docUri: string; state: string }[] } | { docUri: string; state: string }[];
    const docs = Array.isArray(parsed) ? parsed : (parsed.docs ?? []);
    expect(docs.find((d) => d.docUri === 'docs/billing.md')?.state).toBe('stale');
  });

  it('M15 R-RN3: exit codes 0 (passed), 1 (failed scenario), 2 (usage / config), 4 (frozen violation)', async () => {
    const p = createProject({ docs: ['billing', 'release-notes'], options: FAST_REAL });
    project = p;
    const ok = await runCli(p, ['run', 'docs/release-notes.md']);
    expect(ok.code, cliOutput(ok)).toBe(0);
    expect(runDirs(p).length).toBeGreaterThan(0);

    const failed = await runCli(p, ['run', 'docs/billing.md', '--grep', 'Upgrade from Free'], { flags: ['bug-upgrade-noop'] });
    expect(failed.code, cliOutput(failed)).toBe(1);

    const usage = await runCli(p, ['run', '--no-such-flag']);
    expect(usage.code, cliOutput(usage)).toBe(2);
    const noConfig = await runCli(p, ['status'], { config: 'missing.config.mjs' });
    expect(noConfig.code, cliOutput(noConfig)).toBe(2);

    p.editDoc('release-notes', 'The page lists what changed in each release of Acme.', 'The page lists what changed in every release of Acme.');
    const stale = await runCli(p, ['run', '--frozen', 'docs/release-notes.md']);
    expect(stale.code, cliOutput(stale)).toBe(4);
  });

  it('M15 R-EX1 R-PL4: ai-bdd compile is explicit and incremental through the CLI (second compile makes no model call)', async () => {
    const p = createProject({ docs: ['billing', 'todos'], options: FAST_REAL });
    project = p;
    expect((await runCli(p, ['compile'])).code).toBe(0);
    const calls = readFakeLog(p.logPath).length;
    const before = planFiles(p);
    const again = await runCli(p, ['compile']);
    expect(again.code, cliOutput(again)).toBe(0);
    expect(readFakeLog(p.logPath)).toHaveLength(calls);
    expect(planFiles(p)).toEqual(before);
    expect(readFileSync(p.logPath, 'utf8').length).toBeGreaterThan(0);
  });
});
