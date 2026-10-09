/**
 * @ai-bdd/codegen — emits real step-definition source from what the run recorded.
 *
 * Inputs are the committed caches (`act/<key>.json`, `check/<key>.json`) and the
 * lockfile. Output is deterministic: files are sorted, headers carry the source
 * cache keys, and judge-only assertions keep calling the daemon because there is
 * no deterministic program to emit for them (G13, section 7.2).
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ActProgram, CheckProgram, JsonValue, LockFile } from '@ai-bdd/contracts';
import { HEADER, emitActions, emitPredicate, paramSignature } from './emit.js';

export * from './emit.js';

export interface CodegenOptions {
  /** Project root; caches and the lockfile are resolved relative to it. */
  projectRoot: string;
  outDir: string;
  cacheDir?: string;
  lockPath?: string;
  framework?: 'cucumber-js' | 'playwright';
}

export interface CodegenResult {
  files: string[];
  /** Program keys that were emitted. */
  actKeys: string[];
  checkKeys: string[];
  /** Assertions that can only run on the daemon. */
  judgeOnly: string[];
}

export async function generate(options: CodegenOptions): Promise<CodegenResult> {
  const cacheDir = join(options.projectRoot, options.cacheDir ?? '.ai-bdd/cache');
  const lockPath = join(options.projectRoot, options.lockPath ?? 'ai-bdd.lock.json');
  const framework = options.framework ?? 'cucumber-js';
  const acts = readPrograms<ActProgram>(join(cacheDir, 'act'));
  const checks = readPrograms<CheckProgram>(join(cacheDir, 'check'));
  const lock = readLock(lockPath);

  const judgeOnly = judgeOnlyCriteria(lock, checks);
  const files: string[] = [];

  if (framework === 'cucumber-js') {
    files.push(write(join(options.outDir, 'ai-bdd.steps.ts'), cucumberSteps(acts, checks, judgeOnly)));
    files.push(write(join(options.outDir, 'ai-bdd.support.ts'), supportModule()));
  } else {
    files.push(write(join(options.outDir, 'ai-bdd.spec.ts'), playwrightSpec(acts, checks, judgeOnly)));
  }
  files.push(write(join(options.outDir, 'ai-bdd.evidence.json'), evidenceIndex(acts, checks)));

  return {
    files,
    actKeys: acts.map((program) => program.key).sort(),
    checkKeys: checks.map((program) => program.key).sort(),
    judgeOnly,
  };
}

export const generateCucumberJs = (options: Omit<CodegenOptions, 'framework'>): Promise<CodegenResult> =>
  generate({ ...options, framework: 'cucumber-js' });
export const generatePlaywright = (options: Omit<CodegenOptions, 'framework'>): Promise<CodegenResult> =>
  generate({ ...options, framework: 'playwright' });

function readPrograms<T extends { key: string; text: string }>(dir: string): T[] {
  if (!existsSync(dir)) return [];
  const programs: T[] = [];
  for (const file of readdirSync(dir).filter((entry) => entry.endsWith('.json')).sort()) {
    const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { program?: T };
    // The cache stores an envelope; a bare program is accepted for hand-written cases.
    const program = parsed.program ?? (parsed as unknown as T);
    if (program && typeof program.key === 'string') programs.push(program);
  }
  return programs.sort((a, b) => (a.text === b.text ? (a.key < b.key ? -1 : 1) : a.text < b.text ? -1 : 1));
}

function readLock(path: string): LockFile | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as LockFile;
  } catch {
    return undefined;
  }
}

/**
 * Assertions that have no deterministic program: they are emitted as daemon calls
 * with an explicit marker so a reviewer can see which assertions stayed agentic.
 */
function judgeOnlyCriteria(lock: LockFile | undefined, checks: CheckProgram[]): string[] {
  if (!lock) return [];
  const covered = new Set(checks.map((program) => program.text));
  const criteria = new Set<string>();
  for (const entry of lock.entries) {
    if (entry.kind !== 'assertion') continue;
    if (covered.has(entry.stepText)) continue;
    if (entry.resolution.type === 'agent' || entry.resolution.type === 'ambiguous') criteria.add(entry.stepText);
  }
  return [...criteria].sort();
}

function cucumberSteps(acts: ActProgram[], checks: CheckProgram[], judgeOnly: string[]): string {
  const lines: string[] = [...HEADER, '', "import { When, Then } from '@cucumber/cucumber';", "import { expect } from '@playwright/test';", "import { aiBdd, typeSecret, type AiBddWorld, type AiBddParams } from './ai-bdd.support.js';", ''];
  for (const program of acts) {
    const { lines: body, params } = emitActions(program);
    lines.push(`// source: act cache ${program.key}`);
    lines.push(`When(${pattern(program.text)}, async function (${paramSignature(params)}) {`);
    lines.push(...body);
    lines.push('});');
    lines.push('');
  }
  for (const program of checks) {
    const params = new Set<string>();
    const body = program.predicates.map((predicate) => `  ${emitPredicate(predicate, params)}`);
    const list = [...params].sort();
    lines.push(`// source: check cache ${program.key}${program.invariant ? ' (invariant)' : ''}`);
    lines.push(`Then(${pattern(program.text)}, async function (${paramSignature(list)}) {`);
    lines.push(...(body.length > 0 ? body : ['  // the program has no predicates']));
    lines.push('});');
    lines.push('');
  }
  for (const criterion of judgeOnly) {
    lines.push('// judge-only: this assertion has no deterministic program and stays on the daemon');
    lines.push(`Then(${pattern(criterion)}, async function (this: AiBddWorld) {`);
    lines.push(`  await aiBdd.assert(${quote(criterion)});`);
    lines.push('});');
    lines.push('');
  }
  return lines.join('\n');
}

function playwrightSpec(acts: ActProgram[], checks: CheckProgram[], judgeOnly: string[]): string {
  const lines: string[] = [
    ...HEADER,
    '',
    "import { test, expect } from '@playwright/test';",
    "import { baseURL, secrets, typeSecret } from './ai-bdd.support.js';",
    '',
    "test.describe('ai-bdd generated suite', () => {",
    "  test('recorded scenario', async ({ page }) => {",
  ];
  for (const program of acts) {
    lines.push(`    // source: act cache ${program.key}`);
    lines.push(...emitActions(program).lines);
  }
  for (const program of checks) {
    const parameters = new Set<string>();
    for (const predicate of program.predicates) {
      lines.push(`    ${emitPredicate(predicate, parameters)}`);
    }
    lines.push(`    // source: check cache ${program.key}`);
  }
  lines.push('  });');
  for (const criterion of judgeOnly) {
    lines.push(`  // judge-only: ${criterion} (keep this assertion on the daemon)`);
  }
  lines.push('});');
  return lines.join('\n');
}

function supportModule(): string {
  return [
    ...HEADER,
    '',
    "/**\n * Support module for generated step definitions.\n *\n * Deterministic steps run against Playwright directly. Assertions without a\n * deterministic program (`judge-only`) call the ai-bdd daemon, which owns the\n * judge. Start it with `ai-bdd serve --http` before running the generated suite.\n */\n",
    'export interface AiBddWorld {',
    '  world: unknown;',
    '}',
    '',
    'export type AiBddParams = Record<string, string>;',
    '',
    'export const baseURL = process.env.AI_BDD_BASE_URL ?? \'http://localhost:3000\';',
    '',
    'export const secrets: Record<string, string> = new Proxy({}, {',
    '  get(_target, name: string) {',
    '    const value = process.env[`AI_BDD_SECRET_${name.toUpperCase()}`];',
    '    if (value === undefined) throw new Error(`secret ${name} is not set in the environment`);',
    '    return value;',
    '  },',
    '});',
    '',
    'export async function typeSecret(locator: { fill(value: string): Promise<void> }, value: string): Promise<void> {',
    '  await locator.fill(value);',
    '}',
    '',
    'async function daemon<T>(tool: string, body: unknown): Promise<T> {',
    "  const url = process.env.AI_BDD_DAEMON_URL ?? 'http://127.0.0.1:4321';",
    '  const token = process.env.AI_BDD_DAEMON_TOKEN ?? \'\';',
    '  const response = await fetch(`${url}/v1/${tool}`, {',
    '    method: \'POST\',',
    "    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },",
    '    body: JSON.stringify(body),',
    '  });',
    "  if (!response.ok) throw new Error(`${tool} failed with ${response.status}: ${await response.text()}`);",
    '  return (await response.json()) as T;',
    '}',
    '',
    'export const aiBdd = {',
    '  async assert(criterion: string): Promise<void> {',
    '    await daemon(\'run_step\', { sessionId: process.env.AI_BDD_SESSION_ID ?? \'generated\', step: { text: criterion, kind: \'assertion\' } });',
    '  },',
    '  async runStep(text: string): Promise<void> {',
    '    await daemon(\'run_step\', { sessionId: process.env.AI_BDD_SESSION_ID ?? \'generated\', step: { text } });',
    '  },',
    '};',
    '',
  ].join('\n');
}

function evidenceIndex(acts: ActProgram[], checks: CheckProgram[]): string {
  return `${JSON.stringify(
    {
      generatedBy: '@ai-bdd/codegen',
      actKeys: acts.map((program) => program.key),
      checkKeys: checks.map((program) => program.key),
    },
    null,
    2,
  )}\n`;
}

function pattern(text: string): string {
  return `/^${text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$/`;
}

function quote(value: string): string {
  return `'${value.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'")}'`;
}

function write(path: string, contents: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

export type { JsonValue };
