#!/usr/bin/env node
import { main } from './main.ts';

const controller = new AbortController();
let interrupted = false;
process.on('SIGINT', () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  process.stderr.write('\nai-bdd: interrupted, finishing up (press Ctrl+C again to force quit)\n');
  controller.abort();
});

const code = await main(process.argv.slice(2), {}, { signal: controller.signal });
process.exitCode = code;
// A driver that leaked a handle (a stuck connection, a child process it never reaped) must not keep a finished CLI alive forever:
// the timer is unref'd, so a clean process still exits at once, and only a lingering one is ended after the grace period.
setTimeout(() => process.exit(code), 5_000).unref();
