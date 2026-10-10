#!/usr/bin/env node
// @ts-nocheck
import { main } from './main.ts';

const controller = new AbortController();
let interrupted = false;
process.on('SIGINT', () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  process.stderr.write('\nai-bdd: interrupted, finishing up (press Ctrl+C again to force quit)\n');
  controller.abort();
});

process.exitCode = await main(process.argv.slice(2), {}, { signal: controller.signal });
