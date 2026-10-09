/**
 * CLI wrapper: `pnpm -F @ai-bdd/contracts gen:schemas`.
 * Uses tsx so that the TypeScript sources resolve without a prior build.
 */
import { generateSchemas } from '../src/schemas-gen.js';

const written = generateSchemas();
process.stdout.write(`wrote ${written.length} schema files
`);
