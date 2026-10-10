// @ts-nocheck
import { readFileSync } from 'node:fs';
import { Command, CommanderError, Option } from 'commander';
import { AiBddError, type ExitCode } from '@ai-bdd/sdk/contracts';
import { createCtx, type Ctx } from './context.ts';
import { runCompile } from './commands/compile.ts';
import { runDoctor } from './commands/doctor.ts';
import { runInit } from './commands/init.ts';
import { runPrune } from './commands/prune.ts';
import { runReview } from './commands/review.ts';
import { runRun } from './commands/run.ts';
import { runShow } from './commands/show.ts';
import { runStatus } from './commands/status.ts';
import { runVerifyRun } from './commands/verify-run.ts';
import { describeError, exitCodeForError } from './exit.ts';
import { parseReporters, parseWorkers, splitList } from './parse.ts';
import type { CliDeps, CliIo } from './types.ts';

export type { CliDeps, CliIo } from './types.ts';

function collect(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

function readVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof v === 'string' ? v : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Builds the commander program. `result.code` receives the exit code of the executed action. */
export function buildProgram(ctx: Ctx, result: { code: ExitCode }): Command {
  const program = new Command();
  program
    .name('ai-bdd')
    .description('Turn plain markdown documents into executable acceptance tests.')
    .version(readVersion(), '-V, --version', 'print the version')
    .option('-c, --config <path>', 'path to the config file (default: ai-bdd.config.{ts,mjs,js,json})')
    .exitOverride()
    .showHelpAfterError('(run with --help for usage)')
    .configureOutput({
      writeOut: (s) => void ctx.io.stdout.write(s),
      writeErr: (s) => void ctx.io.stderr.write(s),
      // Deterministic help layout unless writing to a real terminal.
      getOutHelpWidth: () => (ctx.io.stdout === process.stdout && process.stdout.isTTY ? process.stdout.columns : 80),
      getErrHelpWidth: () => (ctx.io.stderr === process.stderr && process.stderr.isTTY ? process.stderr.columns : 80),
    });
  program.hook('preAction', (thisCommand) => {
    ctx.configPath = thisCommand.opts<{ config?: string }>().config;
  });

  program
    .command('init')
    .description('write ai-bdd.config.ts (or .json), docs/example.md, .gitignore entries and .ai-bdd/plans/')
    .option('--yes', 'overwrite existing files')
    .option('--json', 'write ai-bdd.config.json instead of ai-bdd.config.ts')
    .action(async (opts: { yes?: boolean; json?: boolean }) => {
      result.code = await runInit(ctx, opts);
    });

  program
    .command('compile')
    .description('extract features and scenarios from stale docs into reviewable plans')
    .argument('[docs...]', 'doc paths or globs (default: all configured docs)')
    .option('--full', 're-extract every section, ignoring staleness')
    .option('--dry-run', 'extract but write nothing')
    .option('--check', 'write nothing; exit 4 if any plan is stale')
    .action(async (docs: string[], opts: { full?: boolean; dryRun?: boolean; check?: boolean }) => {
      result.code = await runCompile(ctx, { docs, ...opts });
    });

  program
    .command('status')
    .description('show plan freshness, coverage and review state (no model calls)')
    .option('--json', 'print machine-readable JSON')
    .action(async (opts: { json?: boolean }) => {
      result.code = await runStatus(ctx, opts);
    });

  program
    .command('show')
    .description('render plan elements as Gherkin-like text with source quotes')
    .argument('[id|docUri]', 'feature id, scenario id (or id prefix), or doc path')
    .option('--json', 'print machine-readable JSON')
    .option('--recordings', 'add determinism and fuzzy reasons per step')
    .action(async (query: string | undefined, opts: { json?: boolean; recordings?: boolean }) => {
      result.code = await runShow(ctx, query, opts);
    });

  program
    .command('review')
    .description('accept, reject, pin or unpin features and scenarios')
    .argument('<action>', 'accept | reject | pin | unpin')
    .argument('<ids...>', 'feature or scenario ids')
    .action(async (action: string, ids: string[]) => {
      result.code = await runReview(ctx, action, ids);
    });

  program
    .command('run')
    .description('run scenarios; the first run characterizes, later runs replay recordings')
    .argument('[selectors...]', 'scenario ids, id prefixes, or doc globs')
    .addOption(new Option('--tag <tags>', 'only scenarios with any of these tags (comma-separated or repeatable)').argParser(collect))
    .option('--grep <text>', 'only scenarios whose title contains this text (case-insensitive)')
    .option('--driver <name>', 'driver to use (overrides defaultDriver)')
    .option('--frozen', 'fail with exit 4 instead of compiling when a plan is stale (default when CI=1)')
    .option('--no-compile', 'do not compile stale docs before running')
    .option('--strict', 'fail healed steps (REPLAY_DIVERGED)')
    .option('-u, --update-recordings', 're-characterize and overwrite recordings')
    .option('--no-agent', 'fail any step that needs the agent (ACT_NO_AGENT)')
    .option('--audit', 're-run the judge next to deterministic checks and fail on disagreement')
    .addOption(new Option('--workers <n>', 'number of scenarios to run in parallel').argParser(parseWorkers))
    .addOption(new Option('--reporter <names>', 'reporters to run: json, junit, markdown (comma-separated or repeatable)').argParser(collect))
    .action(
      async (
        selectors: string[],
        opts: {
          tag?: string[]; grep?: string; driver?: string; frozen?: boolean; compile?: boolean; strict?: boolean;
          updateRecordings?: boolean; agent?: boolean; audit?: boolean; workers?: number; reporter?: string[];
        },
      ) => {
        result.code = await runRun(ctx, {
          selectors,
          tags: splitList(opts.tag),
          grep: opts.grep,
          driver: opts.driver,
          frozen: opts.frozen,
          compile: opts.compile,
          strict: opts.strict,
          updateRecordings: opts.updateRecordings,
          agent: opts.agent,
          audit: opts.audit,
          workers: opts.workers,
          reporters: parseReporters(opts.reporter),
        });
      },
    );

  program
    .command('verify-run')
    .description('recompute artifact hashes and the manifest digest of a run directory')
    .argument('<runDir>', 'run directory, e.g. .ai-bdd/runs/<runId>')
    .action(async (runDir: string) => {
      result.code = await runVerifyRun(ctx, runDir);
    });

  program
    .command('prune')
    .description('delete recordings whose scenario no longer exists in any plan')
    .option('--dry-run', 'list what would be deleted')
    .action(async (opts: { dryRun?: boolean }) => {
      result.code = await runPrune(ctx, opts);
    });

  program
    .command('doctor')
    .description('check Node, config, drivers, model reachability and plan freshness')
    .option('--offline', 'skip checks that need the network')
    .action(async (opts: { offline?: boolean }) => {
      result.code = await runDoctor(ctx, opts);
    });

  return program;
}

/**
 * Runs the CLI. Never throws: every failure is mapped to an exit code (§5.1) and printed to stderr.
 * Built only on the public SDK; `deps` replaces the SDK defaults (used by tests).
 */
export async function main(argv: string[], io: Partial<CliIo> = {}, deps: CliDeps = {}): Promise<ExitCode> {
  const full: CliIo = {
    stdout: io.stdout ?? process.stdout,
    stderr: io.stderr ?? process.stderr,
    env: io.env ?? process.env,
    cwd: io.cwd ?? process.cwd(),
  };
  const ctx = createCtx(full, deps);
  const result: { code: ExitCode } = { code: 0 };
  const program = buildProgram(ctx, result);
  try {
    await program.parseAsync(argv, { from: 'user' });
    return result.code;
  } catch (e) {
    if (e instanceof CommanderError) {
      // Help and version are successful exits; commander already printed any message for real usage errors.
      if (e.code === 'commander.helpDisplayed' || e.code === 'commander.version') return 0;
      return 2;
    }
    if (e instanceof AiBddError || e instanceof Error) {
      ctx.err(describeError(e, full.env['AI_BDD_DEBUG'] === '1'));
      return exitCodeForError(e);
    }
    ctx.err(describeError(e, false));
    return 3;
  }
}
