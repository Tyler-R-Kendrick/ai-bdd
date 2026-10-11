#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { acceptReceived, findReceived } from './files.ts';
import { isCI } from './verify.ts';

const USAGE = `ai-bdd-verify <command> [dir]

  list     print the received snapshot files that wait for review
  check    like list, but exit 1 when there are any (for CI)
  accept   approve every received snapshot (received -> verified); refused when CI is set`;

export function run(argv: string[], log: Pick<Console, 'log' | 'error'> = console, env: Record<string, string | undefined> = process.env): number {
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
      if (isCI(env)) {
        log.error('verify: accept is refused in CI (CI is set); approve snapshots locally and commit them');
        return 1;
      }
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

/** True when this module is the program being run, also when it is reached through a symlink (a package manager's bin shim) or a path with special characters. */
function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return pathToFileURL(fs.realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMain()) process.exitCode = run(process.argv.slice(2));
