// Chaos 8: hostile file system. Output directories turned into files, symlink loops and symlinks that lead out of the project:
// the tool must refuse before it spends model calls, with exit 2 and a message that names the directory; nothing outside the
// project may be written or deleted; and once the hostility is removed the very same command works again.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  diffSnapshots,
  makeOutsideDir,
  removePath,
  replaceWithFile,
  snapshotTree,
  symlinkEscape,
  symlinkLoop,
} from '@ai-bdd/testing';
import { FAST, T, chaosEngine, cliOutput, compilePlain, createProject, runCli, type Project } from './helpers/kit.ts';
import { readFakeLog } from '../acceptance/helpers/calls.ts';

const OPTIONS = FAST;
/** A throw-away project and an outside directory (tests run concurrently, so each cleans up after itself). */
async function withSetup(docs: string[], withPlans: boolean, fn: (project: Project, outside: string) => Promise<void>): Promise<void> {
  const project = createProject({ docs, options: OPTIONS });
  const outside = makeOutsideDir();
  try {
    mkdirSync(project.aiBddDir, { recursive: true });
    if (withPlans) await compilePlain(project);
    await fn(project, outside);
  } finally {
    project.cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
}

type Hostility = 'file' | 'loop' | 'escape';
const HOSTILITIES: Hostility[] = ['file', 'loop', 'escape'];

function inflict(kind: Hostility, path: string, outside: string): void {
  if (kind === 'file') replaceWithFile(path, 'precious user data\n');
  else if (kind === 'loop') symlinkLoop(path);
  else symlinkEscape(path, outside);
}

interface Target {
  /** path relative to the project */
  rel: string;
  /** which directory the message must name */
  names: RegExp;
  args: string[];
  needsPlans: boolean;
  kinds: Hostility[];
}

const TARGETS: Target[] = [
  { rel: '.ai-bdd/plans', names: /plans/, args: ['compile'], needsPlans: false, kinds: HOSTILITIES },
  { rel: '.ai-bdd/plans', names: /plans/, args: ['status'], needsPlans: false, kinds: HOSTILITIES },
  { rel: '.ai-bdd/recordings', names: /recordings/, args: ['run', '--no-compile'], needsPlans: true, kinds: HOSTILITIES },
  { rel: '.ai-bdd/runs', names: /runs/, args: ['run', '--no-compile'], needsPlans: true, kinds: HOSTILITIES },
  { rel: '.ai-bdd/cache', names: /cache/, args: ['run', '--no-compile'], needsPlans: true, kinds: ['file', 'escape'] },
  { rel: '.ai-bdd', names: /plans/, args: ['compile'], needsPlans: false, kinds: ['file', 'escape'] },
];

describe('chaos 8: output directories under a hostile file system', () => {
  for (const target of TARGETS) {
    for (const kind of target.kinds) {
      it.concurrent(`${target.args.join(' ')} with ${target.rel} as ${kind === 'file' ? 'a file' : kind === 'loop' ? 'a symlink loop' : 'a symlink out of the project'}: exit 2 with a clear error, no model call, nothing outside written`, async () => {
        await withSetup(['login'], target.needsPlans, async (project, outside) => {
        const path = join(project.dir, target.rel);
        const outsideBefore = snapshotTree(outside);
        const callsBefore = readFakeLog(project.logPath).length;
        if (target.rel === '.ai-bdd') removePath(path);
        inflict(kind, path, outside);

        const r = await runCli(project, target.args, { overrides: OPTIONS, timeoutMs: 90_000 });

        expect(r.code, cliOutput(r)).toBe(2);
        expect(r.stderr, cliOutput(r)).toMatch(/error \[(POLICY_DENIED|CONFIG_INVALID)\]/);
        expect(r.stderr, 'no raw errno / internal error leaks to the user').not.toMatch(/internal error|ENOTDIR|ELOOP/);
        expect(r.stderr, 'the message names the directory').toMatch(target.names);
        expect(diffSnapshots(outsideBefore, snapshotTree(outside)), 'nothing outside the project may change').toEqual({ added: [], removed: [], changed: [] });
        expect(readFakeLog(project.logPath).length, 'refused before any model call').toBe(callsBefore);
        if (kind === 'file') expect(readFileSync(path, 'utf8'), 'the user\'s file is left alone').toBe('precious user data\n');

        // the hostility is lifted: the same command works and builds on a clean slate
        removePath(path);
        removePath(`${path}.loop`);
        const again = await runCli(project, target.args, { overrides: OPTIONS, timeoutMs: 90_000 });
        expect(again.code, cliOutput(again)).toBe(0);
        });
      });
    }
  }

  it.concurrent('review, and prune with a recordings directory that leaves the project: refused, and prune deletes nothing outside', async () => {
    await withSetup(['login'], true, async (project, outside) => {
    expect((await runCli(project, ['run', '--no-compile'], { overrides: OPTIONS })).code).toBe(0);
    // an "orphan" recording that prune would delete if it followed the link
    mkdirSync(join(outside, 'fake'), { recursive: true });
    const victim = join(outside, 'fake', 'orphan-scenario.json');
    writeFileSync(victim, '{"precious":true}');
    removePath(project.recordingsDir);
    symlinkEscape(project.recordingsDir, outside);

    const prune = await runCli(project, ['prune'], { overrides: OPTIONS });
    expect(prune.code, cliOutput(prune)).toBe(2);
    expect(prune.stderr).toContain('POLICY_DENIED');
    expect(existsSync(victim), 'prune must not delete through the link').toBe(true);
    expect(readFileSync(victim, 'utf8')).toBe('{"precious":true}');

    removePath(project.recordingsDir);
    replaceWithFile(project.plansDir);
    const review = await runCli(project, ['review', 'accept', 'docs-login--administrator-sign-in'], { overrides: OPTIONS });
    expect(review.code, cliOutput(review)).toBe(2);
    expect(review.stderr).toMatch(/CONFIG_INVALID/);
    expect(readFileSync(project.plansDir, 'utf8')).toBe('not a directory\n');
    });
  });
});

describe('chaos 8: the directory is swapped while a scenario is running', () => {
  /** Runs the upgrade scenario; `swap` fires when the first confirm session is about to open (after characterization, before the recording is committed). */
  async function runWithSwap(swap: (project: Project, outside: string) => void, then: (r: Awaited<ReturnType<typeof runOnce>>) => void): Promise<void> {
    await withSetup(['billing'], true, async (project, outside) => {
      then(await runOnce(project, outside, swap));
    });
  }

  async function runOnce(project: Project, outside: string, swap: (project: Project, outside: string) => void) {
    const outsideBefore = snapshotTree(outside);
    const ce = await chaosEngine(project, {
      driverPlan: { seed: 'swap', rules: [{ at: 'openSession', nth: 2, fault: { kind: 'latency', ms: 1 } }] },
      chaosOptions: { sleep: async () => swap(project, outside) },
    });
    const result = await ce.h.runScenario(T.upgrade);
    await ce.h.close();
    return { project, outside, outsideBefore, result, ce };
  }

  it('recordings directory replaced by a file: the scenario ends in error, nothing is half-written, the session is closed', async () => {
    await runWithSwap((p) => replaceWithFile(p.recordingsDir), ({ project, result, ce }) => {
      expect(result.recording).toBe('discarded');
      expect(result.status).toBe('error');
      expect(result.error?.message).toMatch(/ENOTDIR|not a directory/);
      expect(readdirSync(project.aiBddDir)).toContain('recordings');
      expect(readFileSync(project.recordingsDir, 'utf8')).toBe('not a directory\n');
      expect(ce.driver?.stats.openSessions()).toEqual([]);
    });
  });

  it('recordings directory replaced by a symlink out of the project: POLICY_DENIED, nothing written outside', async () => {
    await runWithSwap(
      (p, o) => {
        removePath(p.recordingsDir);
        symlinkEscape(p.recordingsDir, o);
      },
      ({ outside, outsideBefore, result, ce }) => {
        expect(result.recording).toBe('discarded');
        expect(result.status).toBe('error');
        expect(result.error?.code).toBe('POLICY_DENIED');
        expect(diffSnapshots(outsideBefore, snapshotTree(outside))).toEqual({ added: [], removed: [], changed: [] });
        expect(ce.driver?.stats.openSessions()).toEqual([]);
      },
    );
  });
});
