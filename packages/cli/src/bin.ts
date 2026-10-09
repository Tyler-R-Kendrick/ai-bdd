#!/usr/bin/env node
/**
 * The `ai-bdd` binary (section 9.2).
 *
 * Exit codes: 0 all passed, 1 at least one failure, 2 usage/config/parse error,
 * 3 infrastructure (driver or model unavailable), 4 frozen-lock violation only.
 */
import { Command } from 'commander';
import { AiBddError, EXIT_CODES } from '@ai-bdd/contracts';
import {
  calibrateCommand,
  codegenCommand,
  defaultIo,
  doctor,
  e2eHostGenerate,
  evidenceVerify,
  init,
  lint,
  lockVerify,
  resolveCommand,
  run,
  serveCommand,
  type CliIo,
} from './commands.js';
import { exitCodeFor } from './exit-codes.js';

export const VERSION = '0.1.0';

interface CliRunOptions {
  driver?: string;
  tag?: string;
  grep?: string;
  frozen?: boolean;
  cache?: boolean;
  strictCache?: boolean;
  repeatEach?: number;
  workers?: number;
  reporter?: string[];
  updateLock?: boolean;
  config?: string;
}

export function buildProgram(io: CliIo): Command {
  const program = new Command();
  program
    .name('ai-bdd')
    .description('Driver-agnostic, behavior-driven acceptance testing with semantic step bindings and AI fallback execution')
    .version(VERSION)
    .option('--fake', 'use the deterministic fake driver and models (same as AI_BDD_FAKE=1)');

  // Commander keeps global options on the parent program, so read them at action time.
  const globalFake = (): boolean => program.opts().fake === true || process.env.AI_BDD_FAKE === '1';

  program
    .command('init')
    .description('write a config, an example spec, the gitignore entries and an empty lockfile')
    .option('--yes', 'non-interactive')
    .action(async (options: { yes?: boolean }) => {
      await guard(io, () => init(io, options));
    });

  program
    .command('run')
    .description('run specs natively')
    .argument('[globs...]', 'spec globs (defaults to config.specs)')
    .option('--driver <name>', 'driver to use')
    .option('--tag <expression>', 'Cucumber tag expression')
    .option('--grep <pattern>', 'only steps whose text matches')
    .option('--frozen', 'fail on any resolution that is not locked')
    .option('--no-cache', 'ignore the act/check caches')
    .option('--strict-cache', 'fail when a cached program has to be healed')
    .option('--repeat-each <n>', 'run every scenario n times', (value) => Number(value))
    .option('--workers <n>', 'override concurrency.scenarios', (value) => Number(value))
    .option('--reporter <name...>', 'reporters to write')
    .option('--update-lock', 'write the lockfile')
    .option('--config <path>', 'config file path')
    .action(async (globs: string[], options: CliRunOptions) => {
      await guard(io, () =>
        run(io, {
          globs,
          fake: globalFake(),
          ...(options.driver !== undefined ? { driver: options.driver } : {}),
          ...(options.tag !== undefined ? { tag: options.tag } : {}),
          ...(options.grep !== undefined ? { grep: options.grep } : {}),
          ...(options.frozen !== undefined ? { frozen: options.frozen } : {}),
          ...(options.cache === false ? { noCache: true } : {}),
          ...(options.strictCache !== undefined ? { strictCache: options.strictCache } : {}),
          ...(options.repeatEach !== undefined ? { repeatEach: options.repeatEach } : {}),
          ...(options.workers !== undefined ? { workers: options.workers } : {}),
          ...(options.reporter !== undefined ? { reporter: options.reporter } : {}),
          ...(options.updateLock !== undefined ? { updateLock: options.updateLock } : {}),
          ...(options.config !== undefined ? { config: options.config } : {}),
        }),
      );
    });

  program
    .command('resolve')
    .description('resolve steps without opening a driver session')
    .argument('[globs...]')
    .option('--json', 'print JSON')
    .option('--update-lock', 'write the lockfile')
    .option('--frozen', 'do not use the model to extract parameters')
    .action(async (globs: string[], options: { json?: boolean; updateLock?: boolean; frozen?: boolean }) => {
      await guard(io, () => resolveCommand(io, { globs, fake: globalFake(), ...options }));
    });

  program
    .command('lint')
    .description('parser diagnostics, inferred kinds and vague-step warnings')
    .argument('[globs...]')
    .action(async (globs: string[]) => {
      await guard(io, () => lint(io, { globs, fake: globalFake() }));
    });

  const lock = program.command('lock').description('lockfile operations');
  lock
    .command('verify')
    .description('fail when the lockfile is stale relative to the specs and bindings')
    .argument('[globs...]')
    .action(async (globs: string[]) => {
      await guard(io, () => lockVerify(io, { globs, fake: globalFake() }));
    });

  program
    .command('codegen')
    .description('emit step-definition source from locked resolutions and cached programs')
    .option('--framework <name>', 'cucumber-js or playwright', 'cucumber-js')
    .option('--out <dir>', 'output directory (default .ai-bdd/generated)')
    .action(async (options: { framework?: 'cucumber-js' | 'playwright'; out?: string; cacheDir?: string }) => {
      await guard(io, () => codegenCommand(io, options));
    });

  program
    .command('verify-evidence')
    .description('re-hash a run directory, verify the chain and the signature')
    .argument('<runDir>')
    .action(async (runDir: string) => {
      await guard(io, () => evidenceVerify(io, runDir));
    });

  program
    .command('calibrate')
    .description('compute the expected calibration error and recommend judge thresholds')
    .requiredOption('--labels <file>', 'JSONL file of {judgmentId, truth}')
    .option('--json', 'print JSON')
    .action(async (options: { labels: string; json?: boolean }) => {
      await guard(io, () => calibrateCommand(io, options));
    });

  program
    .command('doctor')
    .description('check Node, config, drivers and models')
    .option('--offline', 'skip model reachability')
    .option('--config <path>', 'config file path')
    .action(async (options: { offline?: boolean; config?: string }) => {
      await guard(io, () => doctor(io, { ...options, fake: globalFake() }));
    });

  program
    .command('serve')
    .description('run the orchestrator daemon (MCP stdio or the HTTP JSON mirror)')
    .option('--stdio', 'serve MCP over stdio')
    .option('--http', 'serve the HTTP JSON mirror (default)')
    .option('--port <n>', 'port for --http (default 0 = ephemeral)', (value) => Number(value))
    .option('--config <path>', 'config file path')
    .option('--fake-script', 'serve the plugin conformance kit script instead of a real runtime')
    .action(
      async (options: { stdio?: boolean; http?: boolean; port?: number; config?: string; fakeScript?: boolean }) => {
        await guard(io, () => serveCommand(io, { ...options, fake: globalFake() }));
      },
    );

  program
    .command('e2e-host')
    .description('e2e host integration helpers')
    .command('generate')
    .description('write the static e2e registration file (VERIFY V2 fallback)')
    .argument('[globs...]')
    .option('--out <file>', 'output file (default tests/ai-bdd.generated.e2e.ts)')
    .action(async (globs: string[], options: { out?: string }) => {
      await guard(io, () => e2eHostGenerate(io, { globs, ...options }));
    });

  return program;
}

async function guard(io: CliIo, action: () => Promise<number>): Promise<void> {
  try {
    const code = await action();
    process.exitCode = code;
  } catch (error) {
    const payload = AiBddError.payload(error);
    io.err(`${payload.code}: ${payload.message}`);
    process.exitCode = exitCodeFor(error);
  }
}

/** Programmatic entry point: the tests call this instead of spawning a process. */
export async function runCli(argv: string[], io: CliIo = defaultIo): Promise<number> {
  process.exitCode = undefined;
  const program = buildProgram(io);
  program.exitOverride();
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (error) {
    const commanderError = error as { code?: string; message?: string; exitCode?: number };
    if (commanderError.code === 'commander.helpDisplayed' || commanderError.code === 'commander.version') {
      return EXIT_CODES.ok;
    }
    if (commanderError.code?.startsWith('commander.')) {
      io.err(commanderError.message ?? 'invalid usage');
      return commanderError.exitCode === 0 ? EXIT_CODES.ok : EXIT_CODES.usage;
    }
    throw error;
  }
  return typeof process.exitCode === 'number' ? process.exitCode : EXIT_CODES.ok;
}

const invokedDirectly = process.argv[1] !== undefined && /bin\.(js|ts)$/u.test(process.argv[1]);
if (invokedDirectly) {
  const code = await runCli(process.argv.slice(2), defaultIo);
  process.exitCode = code;
}

export { EXIT_CODES };
