// @ts-nocheck
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url)).replace(/\/$/, '');

export const REPO_ROOT = here('../../../');
export const CORPUS_DIR = `${REPO_ROOT}/packages/testing/corpus`;
/** The complete base rule set of the deterministic fake models (the `rulesDir` option of `createFakeModels` / `writeTestConfig`). */
export const RULES_BASE_DIR = `${CORPUS_DIR}/fake-model`;
/** Overlays layered in front of the base set, one directory per scenario variant. */
export const VARIANTS_DIR = `${CORPUS_DIR}/fake-model-variants`;
export const CLI_BIN = `${REPO_ROOT}/packages/cli/src/bin.ts`;
/**
 * Temporary projects live INSIDE the repository so that `import '@ai-bdd/testing'` in the corpus config resolves through
 * the workspace links of the root node_modules (a project under os.tmpdir() could not resolve it).
 */
export const WORK_ROOT = `${REPO_ROOT}/tests/acceptance/.work`;

export const PW_BROWSERS_PATH = process.env['PLAYWRIGHT_BROWSERS_PATH'] ?? (existsSync('/opt/pw-browsers') ? '/opt/pw-browsers' : undefined);
if (process.env['PLAYWRIGHT_BROWSERS_PATH'] === undefined && PW_BROWSERS_PATH !== undefined) process.env['PLAYWRIGHT_BROWSERS_PATH'] = PW_BROWSERS_PATH;

export const ACME_DEFAULT_ADMIN_PASSWORD = 'correct-horse-battery';
export const ACME_DEFAULT_TEST_TOKEN = 'acme-test';
export const CANARY = 'CANARY-7f3a';
