#!/usr/bin/env node
import path from 'node:path';
import { acceptReceived, findReceived } from './files.ts';

const USAGE = `ai-bdd-verify <command> [dir]

  list     print the received snapshot files that wait for review
  check    like list, but exit 1 when there are any (for CI)
  accept   approve every received snapshot (received -> verified)`;

export function run(argv: string[], log: Pick<Console, 'log' | 'error'> = console): number {
  const [command, dir] = argv;
  const root = path.resolve(dir ?? process.cwd());
  switch (command) {
    case 'list':
    case 'check': {
      const files = findReceived(root);
      for (const f of files) log.log(path.relative(process.cwd(), f));
      if (files.length > 0 && command === 'check') {
        log.error(`${files.length} snapshot(s) differ from their verified file; review them and run "ai-bdd-verify accept" or fix the code`);
        return 1;
      }
      return 0;
    }
    case 'accept': {
      const approved = acceptReceived(findReceived(root));
      for (const f of approved) log.log(`approved ${path.relative(process.cwd(), f)}`);
      if (approved.length === 0) log.log('nothing to approve');
      return 0;
    }
    default:
      log.error(USAGE);
      return command === undefined || command === '--help' || command === '-h' ? 0 : 2;
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) process.exitCode = run(process.argv.slice(2));
