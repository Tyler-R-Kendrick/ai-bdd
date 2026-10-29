#!/usr/bin/env node
import { verifyBundle } from './statement.mjs';
try {
  if (process.argv[2] !== 'verify')
    throw new Error('Expected verify operation');
  const argumentsByName = {};
  for (let index = 3; index < process.argv.length; index += 2) {
    const name = process.argv[index]?.replace(/^--/, '');
    if (
      !['program', 'input', 'output', 'proof'].includes(name) ||
      argumentsByName[name] ||
      !process.argv[index + 1]
    )
      throw new Error('Invalid verifier arguments');
    argumentsByName[name] = process.argv[index + 1];
  }
  if (Object.keys(argumentsByName).length !== 4)
    throw new Error('Missing verifier arguments');
  process.stdout.write(
    JSON.stringify(await verifyBundle(argumentsByName)) + '\n',
  );
} catch (error) {
  process.stderr.write(`Execution proof rejected: ${error.message}\n`);
  process.exitCode = 1;
}
