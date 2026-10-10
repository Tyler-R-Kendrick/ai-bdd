// Chaos 8: hostile file system. Output directories turned into files, symlink loops and symlinks that lead out of the project:
// the tool must refuse before it spends model calls, with exit 2 and a message that names the directory; nothing outside the
// project may be written or deleted; and once the hostility is removed the very same command works again.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, type TestContext } from 'vitest';
import {
  diffSnapshots,
  findTempLeftovers,
  lockDirectory,
  makeOutsideDir,
  mountTinyTmpfs,
  removePath,
  replaceWithFile,
  snapshotTree,
  symlinkEscape,
  symlinkLoop,
} from '@ai-bdd/testing';
import { FAST, T, chaosEngine, cliOutput, compilePlain, createProject, expectStoreFilesValid, planFiles, runCli, type Project } from './helpers/kit.ts';
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

/** A real, tiny file system mounted over `dir`, or a visible skip (with the reason) when this machine cannot mount one. */
function tinyDiskOrSkip(ctx: TestContext, dir: string, kib = 16): Extract<ReturnType<typeof mountTinyTmpfs>, { ok: true }> {
  const mount = mountTinyTmpfs(dir, kib);
  if (!mount.ok) return ctx.skip(`cannot emulate a full/read-only disk here: ${mount.reason}`) as never;
  return mount;
}

describe('chaos 8: the disk fills up, or is read-only, or refuses writes', () => {
  it.concurrent('plans on a full disk (16 KiB tmpfs): the failure is reported, no partial temp file eats the remaining space, no plan is torn, and a rerun on a healthy disk converges', async (ctx) => {
    await withSetup(['billing', 'login'], false, async (project) => {
      const reference = createProject({ docs: ['billing', 'login'], options: OPTIONS });
      try {
        await compilePlain(reference);
        const mount = tinyDiskOrSkip(ctx, project.plansDir);
        try {
          const r = await runCli(project, ['compile'], { overrides: OPTIONS, timeoutMs: 90_000 });
          expect(r.code, cliOutput(r)).toBe(3);
          expect(r.stderr, cliOutput(r)).toMatch(/no space left on device/i);
          expect(r.stderr).not.toMatch(/Unhandled|TypeError/);
          expect(findTempLeftovers(project.plansDir), 'a failed write removed its own temp file').toEqual([]);
          for (const file of Object.keys(planFiles(project))) JSON.parse(readFileSync(join(project.plansDir, file), 'utf8'));
        } finally {
          mount.unmount();
        }
        const again = await runCli(project, ['compile'], { overrides: OPTIONS, timeoutMs: 90_000 });
        expect(again.code, cliOutput(again)).toBe(0);
        expect(planFiles(project)).toEqual(planFiles(reference));
      } finally {
        reference.cleanup();
      }
    });
  });

  it.concurrent('recordings on a full disk: each scenario that cannot save ends in error (exit 3), the ones that fit are complete files, nothing partial remains', async (ctx) => {
    await withSetup(['billing'], true, async (project) => {
      const mount = tinyDiskOrSkip(ctx, project.recordingsDir, 12);
      try {
        const r = await runCli(project, ['run', '--no-compile'], { overrides: OPTIONS, timeoutMs: 120_000 });
        expect(r.code, cliOutput(r)).toBe(3);
        expect(r.stdout).toMatch(/^ERROR /m);
        expect(r.stdout + r.stderr).toMatch(/no space left on device/i);
        expect(r.stderr).not.toMatch(/Unhandled|TypeError|internal error/);
        expect(findTempLeftovers(project.recordingsDir)).toEqual([]);
        await expectStoreFilesValid(project);
      } finally {
        mount.unmount();
      }
      const again = await runCli(project, ['run', '--no-compile'], { overrides: OPTIONS, timeoutMs: 120_000 });
      expect(again.code, cliOutput(again)).toBe(0);
    });
  });

  it.concurrent('run evidence on a full disk: the CLI ends with a documented code and a message, leaves no partial temp files and no unhandled error', async (ctx) => {
    await withSetup(['login'], true, async (project) => {
      const mount = tinyDiskOrSkip(ctx, project.runsDir, 8);
      try {
        const r = await runCli(project, ['run', '--no-compile'], { overrides: OPTIONS, timeoutMs: 120_000 });
        expect([0, 1, 2, 3], cliOutput(r)).toContain(r.code);
        expect(r.stderr).not.toMatch(/Unhandled|TypeError/);
        expect(findTempLeftovers(project.runsDir), 'no partial temp file in the full run directory').toEqual([]);
      } finally {
        mount.unmount();
      }
    });
  });

  it.concurrent('a read-only plans directory is refused up front: exit 2, "read-only file system", before any model call', async (ctx) => {
    await withSetup(['login'], false, async (project) => {
      const mount = tinyDiskOrSkip(ctx, project.plansDir);
      try {
        mount.remountReadOnly();
        const r = await runCli(project, ['compile'], { overrides: OPTIONS });
        expect(r.code, cliOutput(r)).toBe(2);
        expect(r.stderr).toMatch(/CONFIG_INVALID.*plans directory.*read-only file system/);
        expect(readFakeLog(project.logPath), 'no model call was spent').toEqual([]);
        // reading is still fine
        expect((await runCli(project, ['compile', '--check'], { overrides: OPTIONS })).code).toBe(4);
      } finally {
        mount.unmount();
      }
    });
  });

  it.concurrent('a read-only recordings directory stops a characterization before it spends model calls; with read-only recordings mode (CI) the same disk is fine', async (ctx) => {
    await withSetup(['login'], true, async (project) => {
      const mount = tinyDiskOrSkip(ctx, project.recordingsDir);
      try {
        mount.remountReadOnly();
        const callsBefore = readFakeLog(project.logPath).length;
        const r = await runCli(project, ['run', '--no-compile'], { overrides: OPTIONS });
        expect(r.code, cliOutput(r)).toBe(2);
        expect(r.stderr).toMatch(/CONFIG_INVALID.*recordings directory.*read-only file system/);
        expect(readFakeLog(project.logPath).length).toBe(callsBefore);

        const ci = await runCli(project, ['run', '--no-compile'], { overrides: OPTIONS, env: { AI_BDD_RECORDINGS: 'read-only' } });
        expect(ci.code, cliOutput(ci)).toBe(0);
        expect(ci.stdout).toContain('Recordings (read-only): 1 discarded');
      } finally {
        mount.unmount();
      }
    });
  });

  it.concurrent('a directory the user may not write to (permission bits; they do not bind root, so this is skipped as root, with the reason)', async (ctx) => {
    await withSetup(['login'], false, async (project) => {
      mkdirSync(project.plansDir, { recursive: true });
      const lock = lockDirectory(project.plansDir);
      try {
        if (!lock.effective) return ctx.skip(`permission bits are not enforced here: ${lock.reason}`);
        const r = await runCli(project, ['compile'], { overrides: OPTIONS });
        expect(r.code, cliOutput(r)).toBe(2);
        expect(r.stderr).toMatch(/CONFIG_INVALID.*plans directory.*not writable/);
        expect(readdirSync(project.plansDir)).toEqual([]);
      } finally {
        lock.restore();
      }
      expect((await runCli(project, ['compile'], { overrides: OPTIONS })).code).toBe(0);
    });
  });
});
