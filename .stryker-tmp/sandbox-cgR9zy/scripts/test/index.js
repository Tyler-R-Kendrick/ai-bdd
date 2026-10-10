// @ts-nocheck
// Entry point so that `node --test scripts/test` works on Node 22, where a directory argument is resolved
// as a module path instead of being searched for tests. Loads every `*.test.mjs` file in this directory.
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));
for (const name of fs.readdirSync(dir).sort()) {
  if (name.endsWith('.test.mjs')) await import(pathToFileURL(dir + name).href);
}
