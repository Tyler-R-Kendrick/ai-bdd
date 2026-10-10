// Chaos 6: crash consistency. The real CLI is killed with SIGKILL while it compiles, while it writes a recording, a report and a
// manifest, and at random moments. After every kill every file under .ai-bdd that exists must parse and validate (writes are
// temp file + rename, so a file is either the old complete one or the new complete one), a plain rerun must succeed and converge
// to exactly the bytes of an uninterrupted run, and temp files must not pile up in the directories that are committed.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findTempLeftovers, seededRandom, snapshotTree } from '@ai-bdd/testing';
import { CLI_BIN } from '../acceptance/helpers/paths.ts';
import {
  FAST,
  cliOutput,
  compilePlain,
  configArg,
  createProject,
  expectStoreFilesValid,
  planFiles,
  readRecordings,
  runCli,
  runDirs,
  seedFor,
  walkFiles,
  withSeed,
  writeChaosConfig,
  type Project,
} from './helpers/kit.ts';

const DOCS = ['billing', 'login'];

const planBytes = (project: Project): Record<string, string> => Object.fromEntries(Object.entries(planFiles(project)).filter(([k]) => k.endsWith('.plan.json')));
const recordingBytes = (project: Project): Record<string, string> =>
  Object.fromEntries(walkFiles(project.recordingsDir).filter((f) => f.endsWith('.json')).map((f) => [relative(project.recordingsDir, f), readFileSync(f, 'utf8')]));

interface Killed {
  /** The temp file that triggered the kill (undefined for a timed kill). */
  hit: string | undefined;
  code: number | null;
  signal: NodeJS.Signals | null;
  killedAfterMs: number;
}

/** Spawns the CLI and SIGKILLs it as soon as a NEW `.tmp` file matching `match` appears (it is held there by the slow-rename injection), or after `maxMs`. */
function killOnTemp(project: Project, config: string, args: string[], match: RegExp, maxMs = 60_000): Promise<Killed> {
  const known = new Set(findTempLeftovers(project.aiBddDir));
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ['--conditions=source', CLI_BIN, '-c', config, ...args], {
      cwd: project.dir,
      env: { ...process.env, NODE_NO_WARNINGS: '1', ACME_ADMIN_PASSWORD: 'correct-horse-battery', CHAOS_SLOW_RENAME: match.source, CHAOS_SLOW_RENAME_MS: '20000' },
      stdio: 'ignore',
    });
    let hit: string | undefined;
    const poll = setInterval(() => {
      hit = findTempLeftovers(project.aiBddDir).find((f) => !known.has(f) && match.test(f));
      if (hit !== undefined) child.kill('SIGKILL');
    }, 2);
    const timer = setTimeout(() => child.kill('SIGKILL'), maxMs);
    child.on('close', (code, signal) => {
      clearInterval(poll);
      clearTimeout(timer);
      resolve({ hit, code, signal, killedAfterMs: Date.now() - started });
    });
  });
}

/** Spawns the CLI and SIGKILLs it after `ms` (or lets it finish if it is faster). */
function killAfter(project: Project, config: string, args: string[], ms: number): Promise<Killed> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ['--conditions=source', CLI_BIN, '-c', config, ...args], {
      cwd: project.dir,
      env: { ...process.env, NODE_NO_WARNINGS: '1', ACME_ADMIN_PASSWORD: 'correct-horse-battery' },
      stdio: 'ignore',
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), ms);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ hit: undefined, code, signal, killedAfterMs: Date.now() - started });
    });
  });
}

/** An uninterrupted compile + run of the same docs: the bytes every interrupted history must converge to. */
async function reference(): Promise<{ plans: Record<string, string>; recordings: Record<string, string>; runMs: number }> {
  const project = createProject({ docs: DOCS, options: FAST });
  try {
    const compiled = await runCli(project, ['compile'], { overrides: FAST });
    expect(compiled.code, cliOutput(compiled)).toBe(0);
    const t0 = Date.now();
    const run = await runCli(project, ['run', '--no-compile'], { overrides: FAST });
    expect(run.code, cliOutput(run)).toBe(0);
    return { plans: planBytes(project), recordings: recordingBytes(project), runMs: Date.now() - t0 };
  } finally {
    project.cleanup();
  }
}

/** All temp files, split by the directory family they sit in. */
function leftovers(project: Project): { plans: string[]; recordings: string[]; runs: string[] } {
  const all = findTempLeftovers(project.aiBddDir);
  const under = (dir: string): string[] => all.filter((f) => f.startsWith(`${dir}/`));
  return { plans: under(project.plansDir), recordings: under(project.recordingsDir), runs: under(project.runsDir) };
}

const killedBySignal = (k: Killed): boolean => k.signal === 'SIGKILL';

describe('chaos 6: SIGKILL in the middle of a write', () => {
  it.concurrent('during the plan write of a first compile: no torn plan, the temp file is debris, a rerun converges to the reference plans and sweeps the debris', async () => {
    const ref = await reference();
    const project = createProject({ docs: DOCS, options: FAST });
    try {
      const config = writeChaosConfig(project);
      const killed = await killOnTemp(project, config, ['compile'], /plans\//);
      expect(killedBySignal(killed), 'the process was killed mid-write').toBe(true);
      expect(killed.hit).toMatch(/\.plan\.json\.\d+\.[0-9a-f-]{36}\.tmp$/);
      const state = await expectStoreFilesValid(project);
      expect(state.plans, 'the plan that was being written does not exist half-written; earlier plans are intact').toBeLessThan(DOCS.length);
      expect(leftovers(project).plans).toHaveLength(1);

      const rerun = await runCli(project, ['compile'], { config: configArg(project, config) });
      expect(rerun.code, cliOutput(rerun)).toBe(0);
      expect(planBytes(project)).toEqual(ref.plans);
      expect(leftovers(project).plans, 'the debris of the interrupted write was swept').toEqual([]);
      await expectStoreFilesValid(project);
    } finally {
      project.cleanup();
    }
  });

  it.concurrent('during the overwrite of an existing plan: the old complete plan is still there, byte for byte', async () => {
    const project = createProject({ docs: ['billing'], options: FAST });
    try {
      await compilePlain(project);
      const before = planBytes(project);
      project.editDoc('billing', 'The upgrade button is visible while the account is on the Free plan.', 'The upgrade button is always visible while the account is on the Free plan.');
      const config = writeChaosConfig(project);
      const killed = await killOnTemp(project, config, ['compile'], /plans\//);
      expect(killedBySignal(killed)).toBe(true);
      expect(planBytes(project), 'rename never happened: the previous plan is untouched').toEqual(before);
      await expectStoreFilesValid(project);
      const rerun = await runCli(project, ['compile'], { config: configArg(project, config) });
      expect(rerun.code, cliOutput(rerun)).toBe(0);
      expect(planBytes(project)).not.toEqual(before);
      expect(leftovers(project).plans).toEqual([]);
    } finally {
      project.cleanup();
    }
  });

  it.concurrent('during a recording write: no torn recording, the scenario is characterized again by the rerun, and the recordings equal an uninterrupted run\'s', async () => {
    const ref = await reference();
    const project = createProject({ docs: DOCS, options: FAST });
    try {
      await compilePlain(project);
      const config = writeChaosConfig(project);
      const killed = await killOnTemp(project, config, ['run', '--no-compile', '--workers', '1'], /recordings\//);
      expect(killedBySignal(killed)).toBe(true);
      expect(killed.hit).toMatch(/\.json\.\d+\.[0-9a-f-]{36}\.tmp$/);
      const state = await expectStoreFilesValid(project);
      expect(state.recordings).toBeLessThan(Object.keys(ref.recordings).length);
      expect(leftovers(project).recordings).toHaveLength(1);

      const rerun = await runCli(project, ['run', '--no-compile'], { config: configArg(project, config), timeoutMs: 120_000 });
      expect(rerun.code, cliOutput(rerun)).toBe(0);
      expect(recordingBytes(project)).toEqual(ref.recordings);
      expect(leftovers(project).recordings, 'debris swept by the write that replaced it').toEqual([]);
      const again = await runCli(project, ['run', '--no-compile'], { config: configArg(project, config), timeoutMs: 120_000 });
      expect(again.code, cliOutput(again)).toBe(0);
      expect(again.stdout, 'a second run writes nothing').toContain('Recordings: read-write, none written');
    } finally {
      project.cleanup();
    }
  });

  it.concurrent('while -u overwrites a recording: the previous recording survives intact', async () => {
    const project = createProject({ docs: ['login'], options: FAST });
    try {
      await compilePlain(project);
      const config = writeChaosConfig(project);
      expect((await runCli(project, ['run', '--no-compile'], { config: configArg(project, config) })).code).toBe(0);
      const before = recordingBytes(project);
      expect(Object.keys(before)).toHaveLength(1);
      // make the file differ from what -u will write (valid, but not canonical), so that -u really rewrites it
      const file = walkFiles(project.recordingsDir).find((f) => f.endsWith('.json')) as string;
      const tampered = JSON.parse(readFileSync(file, 'utf8')) as { steps: { stats: { healCount: number } }[] };
      (tampered.steps[0] as { stats: { healCount: number } }).stats.healCount = 7;
      writeFileSync(file, `${JSON.stringify(tampered)}\n`);
      const tamperedBytes = recordingBytes(project);
      const killed = await killOnTemp(project, config, ['run', '--no-compile', '-u'], /recordings\//);
      expect(killedBySignal(killed)).toBe(true);
      expect(recordingBytes(project), 'rename never happened: the previous file is untouched').toEqual(tamperedBytes);
      await expectStoreFilesValid(project);
    } finally {
      project.cleanup();
    }
  });

  for (const [label, pattern] of [
    ['the run report', /runs\/[^/]+\/report\.json/],
    ['the run manifest', /runs\/[^/]+\/manifest\.json/],
    ['an evidence artifact', /runs\/[^/]+\/artifacts\//],
  ] as const) {
    it.concurrent(`during the write of ${label}: the run directory is reported as not finalized (or complete), everything else is intact, and a rerun succeeds`, async () => {
      const project = createProject({ docs: ['login'], options: FAST });
      try {
        await compilePlain(project);
        const config = writeChaosConfig(project);
        const killed = await killOnTemp(project, config, ['run', '--no-compile'], pattern);
        expect(killedBySignal(killed), `${killed.hit}`).toBe(true);
        const state = await expectStoreFilesValid(project);
        expect(state.runs).toBe(1);
        if (label !== 'the run report') expect(state.unfinalizedRuns, 'no manifest was written, so the run is not finalized').toBe(1);
        const [dir] = runDirs(project);
        const verify = await runCli(project, ['verify-run', dir as string], { config: configArg(project, config) });
        if (state.unfinalizedRuns === 1) {
          expect(verify.code, cliOutput(verify)).toBe(1);
          expect(`${verify.stdout}${verify.stderr}`).toMatch(/manifest|not finalized/i);
        }
        const rerun = await runCli(project, ['run', '--no-compile'], { config: configArg(project, config), timeoutMs: 120_000 });
        expect(rerun.code, cliOutput(rerun)).toBe(0);
        const final = await expectStoreFilesValid(project);
        expect(final.runs).toBe(2);
        expect(readRecordings(project)).toHaveLength(1);
      } finally {
        project.cleanup();
      }
    });
  }
});

describe('chaos 6: SIGKILL at random moments', () => {
  it('a seeded series of kills during compile and run, then one plain rerun: every state valid, same bytes as an uninterrupted run, bounded debris', async () => {
    await withSeed('crash-series', async (seed) => {
      const ref = await reference();
      const rng = seededRandom(seed);
      const project = createProject({ docs: DOCS, options: FAST });
      try {
        const config = writeChaosConfig(project);
        const commands: string[][] = [['compile'], ['run'], ['run', '--workers', '3'], ['run', '-u']];
        const kills = 10;
        let killed = 0;
        const log: string[] = [];
        for (let i = 0; i < kills; i += 1) {
          const args = rng.pick(commands);
          const after = rng.range(60, Math.round(ref.runMs * 1.5) + 400);
          const result = await killAfter(project, config, args, after);
          if (killedBySignal(result)) killed += 1;
          log.push(`${args.join(' ')} @${after}ms -> ${result.signal ?? result.code}`);
          try {
            await expectStoreFilesValid(project);
          } catch (err) {
            throw new Error(`state invalid after kill ${i}: ${log.join(' | ')}\n${String(err)}`);
          }
        }
        expect(killed, `at least some kills must land mid-run (${log.join(' | ')})`).toBeGreaterThan(2);

        const rerun = await runCli(project, ['run'], { config: configArg(project, config), timeoutMs: 180_000 });
        expect(rerun.code, `${log.join(' | ')}\n${cliOutput(rerun)}`).toBe(0);
        expect(planBytes(project), 'converges to the uninterrupted plans').toEqual(ref.plans);
        expect(recordingBytes(project), 'and to the uninterrupted recordings').toEqual(ref.recordings);
        const left = leftovers(project);
        expect(left.plans, 'no debris accumulates in the committed plan directory').toEqual([]);
        expect(left.recordings, 'nor in the recordings directory').toEqual([]);
        expect(left.runs.length, 'debris inside killed run directories is bounded by the number of kills').toBeLessThanOrEqual(kills * 4);
        const state = await expectStoreFilesValid(project);
        expect(state.plans).toBe(DOCS.length);
        expect(state.unfinalizedRuns).toBeLessThanOrEqual(killed);
        // an uninterrupted second run is a pure replay
        const replay = await runCli(project, ['run', '--no-compile'], { config: configArg(project, config) });
        expect(replay.code, cliOutput(replay)).toBe(0);
        expect(replay.stdout, 'a second run writes nothing').toContain('none written');
        expect(snapshotTree(project.recordingsDir).size).toBeGreaterThan(0);
      } finally {
        project.cleanup();
      }
    });
  });

  it('the series is replayable: the same seed picks the same commands and delays', () => {
    const pick = (seed: string): string => {
      const rng = seededRandom(seed);
      return Array.from({ length: 8 }, () => `${rng.pick(['compile', 'run', 'run -u'])}@${rng.range(60, 5000)}`).join(',');
    };
    expect(pick(seedFor('crash-series'))).toBe(pick(seedFor('crash-series')));
    expect(pick('a')).not.toBe(pick('b'));
    expect(join('a', 'b')).toBe('a/b');
  });
});
