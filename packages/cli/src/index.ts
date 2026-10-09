/**
 * @ai-bdd/cli — the command line and its programmatic entry point.
 *
 * The commands are exported as functions so tests (and the daemon) can drive them
 * in-process: no child process, no shell, deterministic exit codes.
 */
export { runCli, buildProgram, VERSION } from './bin.js';
export * from './commands.js';
export { loadCliContext, type CliContext } from './context.js';
export { exitCodeFor } from './exit-codes.js';
export { EXIT_CODES } from '@ai-bdd/contracts';
