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

export type CodegenStyle = 'delegate' | 'inline';
export type CodegenHost = 'cucumber-js' | 'playwright' | 'e2e';

export interface CodegenOptions {
  /** Project root; caches and the lockfile are resolved relative to it. */
  projectRoot: string;
  outDir: string;
  cacheDir?: string;
  lockPath?: string;
  framework?: CodegenHost;
  /**
   * `delegate` (the default) emits the thin binding that calls the agent, so the
   * cached ActProgram stays the single source of the replayed driver actions and
   * heals when the screen changed. `inline` emits the recorded Playwright actions
   * directly, which removes the daemon hop for steps that have not changed.
   */
  style?: CodegenStyle;
}

export interface CodegenResult {
  files: string[];
  /** Program keys that were emitted. */
  actKeys: string[];
  checkKeys: string[];
  /** Assertions that can only run on the daemon. */
  judgeOnly: string[];
  /** The style that was used. */
  style: CodegenStyle;
  /** Step texts that were emitted, with the cache key that backs each one. */
  steps: Array<{ text: string; kind: 'action' | 'assertion'; cacheKey?: string; judgeOnly?: boolean }>;
}

export async function generate(options: CodegenOptions): Promise<CodegenResult> {
  const cacheDir = join(options.projectRoot, options.cacheDir ?? '.ai-bdd/cache');
  const lockPath = join(options.projectRoot, options.lockPath ?? 'ai-bdd.lock.json');
  const framework = options.framework ?? 'cucumber-js';
  const acts = readPrograms<ActProgram>(join(cacheDir, 'act'));
  const checks = readPrograms<CheckProgram>(join(cacheDir, 'check'));
  const lock = readLock(lockPath);

  const judgeOnly = judgeOnlyCriteria(lock, checks);
  const style = options.style ?? 'delegate';
  const files: string[] = [];

  if (framework === 'playwright') {
    files.push(write(join(options.outDir, 'ai-bdd.spec.ts'), playwrightSpec(acts, checks, judgeOnly, style)));
  } else if (style === 'delegate') {
    files.push(write(join(options.outDir, 'ai-bdd.steps.ts'), delegatedSteps(acts, checks, judgeOnly, framework)));
    files.push(write(join(options.outDir, 'ai-bdd.support.ts'), supportModule(framework)));
  } else {
    files.push(write(join(options.outDir, 'ai-bdd.steps.ts'), cucumberSteps(acts, checks, judgeOnly)));
    files.push(write(join(options.outDir, 'ai-bdd.support.ts'), supportModule(framework)));
  }
  files.push(write(join(options.outDir, 'ai-bdd.evidence.json'), evidenceIndex(acts, checks, style, judgeOnly)));

  const steps = [
    ...acts.map((program) => ({ text: program.text, kind: 'action' as const, cacheKey: program.key })),
    ...checks.map((program) => ({ text: program.text, kind: 'assertion' as const, cacheKey: program.key })),
    ...judgeOnly.map((text) => ({ text, kind: 'assertion' as const, judgeOnly: true })),
  ].sort((left, right) => (left.text < right.text ? -1 : 1));

  return {
    files,
    actKeys: acts.map((program) => program.key).sort(),
    checkKeys: checks.map((program) => program.key).sort(),
    judgeOnly,
    style,
    steps,
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

/**
 * Emits the thin bindings: one `When` per recorded action and one `Then` per
 * assertion, each delegating to the daemon.
 *
 * This is the shape that keeps the cached programs authoritative. The binding says
 * *what* the step is; `.ai-bdd/cache/act/<key>.json` holds the recorded, effect-verified
 * driver actions that are replayed on later runs, healed when the screen changed, and
 * re-recorded only when the impact area moved.
 */
function delegatedSteps(acts: ActProgram[], checks: CheckProgram[], judgeOnly: string[], host: string): string {
  const lines: string[] = [...HEADER, '', `// Style: delegate (${host} -> ai-bdd daemon). The cached programs are the replayed driver code.`, '', "import { When, Then } from '@cucumber/cucumber';", "import { aiBdd } from './ai-bdd.support.js';", ''];  for (const program of acts) {
    lines.push(`// cache: act program ${program.key} (driver ${program.driver}, ${program.actions.length} action(s))`);
    lines.push(`When(${pattern(program.text)}, async function () {`);
    lines.push(`  await aiBdd.act(${quote(program.text)});`);
    lines.push('});');
    lines.push('');
  }
  for (const program of checks) {
    lines.push(`// cache: check program ${program.key}${program.invariant ? ' (invariant)' : ''}`);
    lines.push(`Then(${pattern(program.text)}, async function () {`);
    lines.push(`  await aiBdd.assert(${quote(program.text)});`);
    lines.push('});');
    lines.push('');
  }
  for (const criterion of judgeOnly) {
    lines.push('// judge-only: no deterministic program exists, so this stays on the daemon');
    lines.push(`Then(${pattern(criterion)}, async function () {`);
    lines.push(`  await aiBdd.assert(${quote(criterion)});`);
    lines.push('});');
    lines.push('');
  }
  return lines.join('\n');
}

function cucumberSteps(acts: ActProgram[], checks: CheckProgram[], judgeOnly: string[]): string {
  const lines: string[] = [
    ...HEADER,
    '// Style: inline (recorded driver actions; no daemon hop for these steps).',
    '',
    "import { When, Then } from '@cucumber/cucumber';", "import { expect } from '@playwright/test';", "import { aiBdd, baseURL, typeSecret, type AiBddWorld, type AiBddParams } from './ai-bdd.support.js';", ''];
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

function playwrightSpec(acts: ActProgram[], checks: CheckProgram[], judgeOnly: string[], style: CodegenStyle = 'inline'): string {
  const lines: string[] = [
    ...HEADER,
    `// Style: ${style}`,
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

function supportModule(host: string): string {
  return [
    ...HEADER,
    '',
    `// host: ${host}`,
    "import { After, Before, World } from '@cucumber/cucumber';",
    "import { chromium, type Browser, type Page } from 'playwright-core';",
    '',
    '/**',
    ' * Support module for generated step definitions.',
    ' *',
    ' * Every scenario gets its own browser context and page, so generated steps only',
    ' * ever touch `world.page`. Assertions without a deterministic program',
    ' * (judge-only) call the ai-bdd daemon, which owns the judge: start it with',
    ' * `ai-bdd serve --http`.',
    ' */',
    'export interface AiBddWorld extends World {',
    '  page: Page;',
    '  browser: Browser;',
    '  /** Set when a generated step was completed by the agent instead of replaying. */',
    '  healed?: string[];',
    '}',
    '',
    'export type AiBddParams = Record<string, string>;',
    '',
    "export const baseURL = process.env.AI_BDD_BASE_URL ?? 'http://localhost:3000';",
    '',
    "Before(async function (this: AiBddWorld) {",
    '  this.browser = await chromium.launch({ headless: process.env.AI_BDD_HEADED !== \'1\' });',
    '  const context = await this.browser.newContext({ baseURL });',
    '  this.page = await context.newPage();',
    '});',
    '',
    "After(async function (this: AiBddWorld) {",
    '  await this.browser?.close();',
    '});',
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
    "  const token = process.env.AI_BDD_DAEMON_TOKEN ?? '';",
    '  const response = await fetch(`${url}/v1/${tool}`, {',
    "    method: 'POST',",
    "    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },",
    '    body: JSON.stringify(body),',
    '  });',
    "  if (!response.ok) throw new Error(`${tool} failed with ${response.status}: ${await response.text()}`);",
    '  return (await response.json()) as T;',
    '}',
    '',
    'export const aiBdd = {',
    '  /**',
    '   * Runs an action step on the daemon: replay the cached ActProgram, heal when the',
    '   * screen changed, record when nothing was cached yet.',
    '   */',
    '  async act(instruction: string): Promise<void> {',
    "    await daemon('run_step', { sessionId: process.env.AI_BDD_SESSION_ID ?? 'generated', step: { text: instruction, kind: 'action' } });",
    '  },',
    '  /** Judge-only assertion: the criterion has no deterministic program. */',
    '  async assert(criterion: string): Promise<void> {',
    "    await daemon('run_step', { sessionId: process.env.AI_BDD_SESSION_ID ?? 'generated', step: { text: criterion, kind: 'assertion' } });",
    '  },',
    '  async runStep(text: string): Promise<void> {',
    "    await daemon('run_step', { sessionId: process.env.AI_BDD_SESSION_ID ?? 'generated', step: { text } });",
    '  },',
    '};',
    '',
  ].join('\n');
}

function evidenceIndex(acts: ActProgram[], checks: CheckProgram[], style: CodegenStyle, judgeOnly: string[]): string {
  return `${JSON.stringify(
    {
      generatedBy: '@ai-bdd/codegen',
      style,
      actKeys: acts.map((program) => program.key),
      checkKeys: checks.map((program) => program.key),
      judgeOnly,
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
