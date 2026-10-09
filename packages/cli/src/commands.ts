import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Diagnostic, ReporterName } from '@ai-bdd/contracts';
import { AiBddError, EXIT_CODES, TOOL_SHORT_NAMES } from '@ai-bdd/contracts';
import { verifyEvidence } from '@ai-bdd/evidence';
import { calibrate } from '@ai-bdd/judge';
import type { CalibrationLabel } from '@ai-bdd/contracts';
import { createRuntime, resolveAll, loadConfig } from '@ai-bdd/runtime';
import { discover } from '@ai-bdd/runtime';
import { lintSteps } from '@ai-bdd/spec-directives';
import { generate } from '@ai-bdd/codegen';
import { loadCliContext, type CliContext } from './context.js';

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  cwd: string;
}

export const defaultIo: CliIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  cwd: process.cwd(),
};

const CONFIG_TEMPLATE_JSON = {
  specs: ['specs/**/*.spec.md', 'features/**/*.feature'],
  concepts: ['specs/**/*.cpt'],
  bindings: ['bindings/**/*.ts'],
  drivers: { web: { use: '@ai-bdd/driver-playwright' } },
  defaultDriver: 'web',
  models: {
    act: { use: '@ai-bdd/models/ai-sdk', options: { model: 'openai/gpt-5-mini' } },
    judge: { use: '@ai-bdd/models/ai-sdk', options: { model: 'anthropic/claude-sonnet-4.5' } },
    extract: { use: '@ai-bdd/models/ai-sdk', options: { model: 'openai/gpt-5-mini' } },
    embed: { use: '@ai-bdd/models/ai-sdk', options: { model: 'openai/text-embedding-3-small' } },
  },
  reporters: ['json', 'junit', 'markdown', 'cucumber-messages'],
};

const EXAMPLE_SPEC = `# Example spec

## A first scenario
* Seed a workspace "Acme" on the "free" plan
* Open billing settings
* The plan badge reads "Pro"
`;

export async function init(io: CliIo, options: { yes?: boolean } = {}): Promise<number> {
  const root = io.cwd;
  const configPath = join(root, 'ai-bdd.config.json');
  if (!existsSync(configPath)) {
    write(configPath, `${JSON.stringify(CONFIG_TEMPLATE_JSON, null, 2)}\n`);
    io.out(`wrote ${relative(root, configPath)}`);
  }
  const specPath = join(root, 'specs', 'example.spec.md');
  if (!existsSync(specPath)) {
    write(specPath, EXAMPLE_SPEC);
    io.out(`wrote ${relative(root, specPath)}`);
  }
  const lockPath = join(root, 'ai-bdd.lock.json');
  if (!existsSync(lockPath)) {
    write(lockPath, `${JSON.stringify({ version: 1, generator: 'ai-bdd', entries: [] }, null, 2)}\n`);
    io.out(`wrote ${relative(root, lockPath)}`);
  }
  const gitignorePath = join(root, '.gitignore');
  const entries = ['# ai-bdd generated output', '.ai-bdd/runs/', '.ai-bdd/sessions/', '.ai-bdd/daemon.json', '.ai-bdd/cache/judge/', '.ai-bdd/cache/embeddings/'];
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  const missing = entries.filter((entry) => !existing.includes(entry));
  if (missing.length > 0) {
    write(gitignorePath, `${existing}${existing.endsWith('\n') || existing === '' ? '' : '\n'}${missing.join('\n')}\n`);
    io.out(`updated .gitignore (${missing.length} entries)`);
  }
  io.out(options.yes ? 'ai-bdd is ready (non-interactive init)' : 'ai-bdd is ready: run `ai-bdd run`');
  return EXIT_CODES.ok;
}

export interface RunFlags {
  globs: string[];
  driver?: string;
  tag?: string;
  grep?: string;
  frozen?: boolean;
  noCache?: boolean;
  strictCache?: boolean;
  repeatEach?: number;
  workers?: number;
  reporter?: string[];
  updateLock?: boolean;
  fake?: boolean;
  config?: string;
}

export async function run(io: CliIo, flags: RunFlags): Promise<number> {
  const context = await loadCliContext({
    projectRoot: io.cwd,
    ...(flags.config !== undefined ? { configPath: join(io.cwd, flags.config) } : {}),
    env: process.env,
    ...(flags.fake !== undefined ? { fake: flags.fake } : {}),
    ...(flags.driver !== undefined ? { driverOverride: flags.driver } : {}),
  });
  if (flags.fake) io.out('running with the deterministic fakes (AI_BDD_FAKE=1)');

  const runtime = createRuntime(context.config, {
    projectRoot: io.cwd,
    models: context.models,
    drivers: context.drivers,
    env: process.env,
  });
  const report = await runtime.run({
    ...(flags.globs.length > 0 ? { globs: flags.globs } : {}),
    ...(flags.driver !== undefined ? { driver: flags.driver } : {}),
    ...(flags.tag !== undefined ? { tags: flags.tag } : {}),
    ...(flags.frozen !== undefined ? { frozen: flags.frozen } : {}),
    ...(flags.noCache !== undefined ? { noCache: flags.noCache } : {}),
    ...(flags.strictCache !== undefined ? { strictCache: flags.strictCache } : {}),
    ...(flags.repeatEach !== undefined ? { repeatEach: flags.repeatEach } : {}),
    ...(flags.updateLock !== undefined ? { updateLock: flags.updateLock } : {}),
    onEvent: (event) => {
      if (event.type === 'scenario:end') io.out(`  ${event.result.status.padEnd(8)} ${event.result.name}`);
      if (event.type === 'log' && event.level !== 'debug') io.err(`  ${event.level}: ${event.message}`);
    },
  });
  io.out('');
  io.out(
    `${report.stats.scenarios} scenario(s): ${report.stats.passed} passed, ${report.stats.failed} failed, ${report.stats.healed} healed`,
  );
  io.out(`${report.stats.steps} step(s), ${report.stats.modelCalls} model call(s)`);
  if (report.lock) {
    io.out(
      `lock: ${report.lock.added} added, ${report.lock.changed} changed, ${report.lock.revalidated} revalidated, ${report.lock.unchanged} unchanged`,
    );
  }
  if (report.runDir) io.out(`evidence: ${report.runDir}`);
  if (report.exitCode !== 0) {
    for (const scenario of report.scenarios.filter((entry) => entry.status === 'failed')) {
      const failure = scenario.steps.find((step) => step.status !== 'passed');
      io.err(`  ${scenario.name}: ${failure?.error?.code ?? 'failed'} ${failure?.error?.message ?? ''}`);
    }
  }
  return report.exitCode;
}

export async function resolveCommand(io: CliIo, options: { globs: string[]; json?: boolean; updateLock?: boolean; frozen?: boolean; fake?: boolean }): Promise<number> {
  const context = await loadCliContext({ projectRoot: io.cwd, env: process.env, ...(options.fake !== undefined ? { fake: options.fake } : {}) });
  const { rows, diagnostics, lock } = await resolveAll(context.config, context.models, {
    ...(options.globs.length > 0 ? { globs: options.globs } : {}),
    ...(options.frozen !== undefined ? { frozen: options.frozen } : {}),
  });
  if (options.json) {
    io.out(JSON.stringify({ rows, diagnostics }, null, 2));
  } else {
    for (const row of rows) {
      const score = row.score !== undefined ? ` ${row.score.toFixed(2)}/${(row.margin ?? 0).toFixed(2)}` : '';
      io.out(`${row.resolution.type.padEnd(9)} ${row.kind.padEnd(9)} ${row.kindSource.padEnd(8)}${score}  ${row.text}`);
    }
  }
  if (options.updateLock) {
    await lock.save();
    io.out(`updated ${join(io.cwd, 'ai-bdd.lock.json')}`);
  }
  const unresolved = rows.filter((row) => row.resolution.type === 'ambiguous');
  for (const row of unresolved) io.err(`ambiguous: ${row.text}`);
  return unresolved.length > 0 ? EXIT_CODES.failure : EXIT_CODES.ok;
}

export async function lint(io: CliIo, options: { globs: string[]; fake?: boolean }): Promise<number> {
  const context = await loadCliContext({ projectRoot: io.cwd, env: process.env, ...(options.fake !== undefined ? { fake: options.fake } : {}) });
  const discovery = discover(context.config.projectRoot, options.globs.length > 0 ? options.globs : context.config.specs, context.config.concepts);
  const diagnostics: Diagnostic[] = [...discovery.diagnostics];
  for (const document of discovery.documents) diagnostics.push(...lintSteps(document));
  const { rows } = await resolveAll(context.config, context.models, {
    ...(options.globs.length > 0 ? { globs: options.globs } : {}),
  });

  for (const diagnostic of diagnostics) {
    const where = diagnostic.location ? `${relative(io.cwd, diagnostic.location.uri)}:${diagnostic.location.line}` : '';
    io.out(`${diagnostic.severity.padEnd(7)} ${diagnostic.code.padEnd(26)} ${where} ${diagnostic.message}`);
  }
  io.out('');
  io.out('inferred kinds:');
  for (const row of rows.filter((entry) => entry.kindSource !== 'keyword')) {
    io.out(`  ${row.kind.padEnd(9)} ${row.kindSource.padEnd(8)} ${row.text}`);
  }
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  io.out('');
  io.out(`${discovery.documents.length} spec(s), ${errors.length} error(s), ${diagnostics.length - errors.length} warning(s)`);
  return errors.length > 0 ? EXIT_CODES.usage : EXIT_CODES.ok;
}

export async function lockVerify(io: CliIo, options: { globs: string[]; fake?: boolean }): Promise<number> {
  const context = await loadCliContext({ projectRoot: io.cwd, env: process.env, ...(options.fake !== undefined ? { fake: options.fake } : {}) });
  const { rows } = await resolveAll(context.config, context.models, {
    ...(options.globs.length > 0 ? { globs: options.globs } : {}),
    frozen: true,
  });
  const stale = rows.filter((row) => row.lockStatus === 'changed' || row.lockStatus === 'new');
  const failed = rows.filter((row) => row.resolution.type === 'unbound' && row.resolution.message.includes('RESOLUTION_NOT_LOCKED'));
  for (const row of [...stale, ...failed]) io.err(`stale: ${row.text}`);
  if (stale.length + failed.length === 0) {
    io.out(`lockfile is up to date (${rows.length} step(s) checked)`);
    return EXIT_CODES.ok;
  }
  io.err(`${stale.length + failed.length} step(s) are not locked; run \`ai-bdd resolve --update-lock\``);
  return EXIT_CODES.frozen;
}

export async function evidenceVerify(io: CliIo, runDir: string): Promise<number> {
  const target = runDir.startsWith('/') ? runDir : join(io.cwd, runDir);
  const result = await verifyEvidence(target);
  if (result.ok) {
    io.out(`ok: ${result.count} record(s), root hash ${result.rootHash}`);
    return EXIT_CODES.ok;
  }
  for (const problem of result.problems) {
    io.err(`${problem.kind}: ${problem.detail}${problem.record ? ` [${problem.record}]` : ''}`);
  }
  io.err(`${result.problems.length} problem(s) found in ${target}`);
  return EXIT_CODES.failure;
}

export async function calibrateCommand(
  io: CliIo,
  options: { labels: string; write?: boolean; json?: boolean },
): Promise<number> {
  const labelsPath = options.labels.startsWith('/') ? options.labels : join(io.cwd, options.labels);
  if (!existsSync(labelsPath)) {
    throw new AiBddError('CONFIG_INVALID', `the labels file does not exist: ${options.labels}`);
  }
  const labels = readFileSync(labelsPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CalibrationLabel);
  const judgmentsPath = join(io.cwd, '.ai-bdd', 'calibration', 'judgments.jsonl');
  const judgments = existsSync(judgmentsPath)
    ? readFileSync(judgmentsPath, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { judgmentId: string; score: number })
    : [];
  const report = calibrate(judgments, labels);
  if (options.json) {
    io.out(JSON.stringify(report, null, 2));
  } else {
    io.out(`labeled judgments: ${report.count}`);
    io.out(`expected calibration error: ${report.ece.toFixed(3)}`);
    io.out(`brier score: ${report.brier.toFixed(3)}`);
    io.out(`recommended thresholds: pass >= ${report.recommended.passThreshold}, fail <= ${report.recommended.failThreshold}`);
  }
  void options.write;
  return report.count === 0 ? EXIT_CODES.usage : EXIT_CODES.ok;
}

export async function doctor(io: CliIo, options: { offline?: boolean; fake?: boolean; config?: string }): Promise<number> {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const nodeOk = (major ?? 0) > 22 || ((major ?? 0) === 22 && (minor ?? 0) >= 22);
  io.out(`${nodeOk ? 'ok  ' : 'FAIL'} node ${process.versions.node} (requires ^22.22.3 || >=24.8.0)`);

  let configOk = true;
  let context: CliContext | undefined;
  try {
    context = await loadCliContext({
      projectRoot: io.cwd,
      env: process.env,
      ...(options.config !== undefined ? { configPath: join(io.cwd, options.config) } : {}),
      ...(options.fake !== undefined ? { fake: options.fake } : {}),
    });
    io.out(`ok   config loaded (${Object.keys(context.drivers).length} driver(s), fake=${context.fake})`);
  } catch (error) {
    configOk = false;
    io.out(`FAIL config: ${AiBddError.payload(error).message}`);
  }

  let driversOk = true;
  if (context) {
    for (const [name, factory] of Object.entries(context.drivers)) {
      try {
        const driver = await factory.create({ sessionId: 'doctor', scenarioId: 'doctor', config: {} });
        const result = await driver.selfCheck();
        io.out(`${result.ok ? 'ok  ' : 'FAIL'} driver ${name}: ${result.ok ? 'available' : result.problems.join('; ')}`);
        driversOk = driversOk && result.ok;
      } catch (error) {
        driversOk = false;
        io.out(`FAIL driver ${name}: ${AiBddError.payload(error).message}`);
      }
    }
  }

  if (options.offline) {
    io.out('ok   models: skipped (--offline)');
  } else if (context) {
    io.out(`ok   models: ${(context.models.act as { id?: string }).id ?? 'configured'}, ${(context.models.embed as { id?: string }).id ?? 'configured'}`);
  }

  io.out('');
  const ok = nodeOk && configOk && driversOk;
  io.out(ok ? 'doctor: everything looks usable' : 'doctor: problems found');
  return ok ? EXIT_CODES.ok : EXIT_CODES.usage;
}

export async function codegenCommand(
  io: CliIo,
  options: { framework?: 'cucumber-js' | 'playwright'; out?: string; cacheDir?: string },
): Promise<number> {
  const outDir = options.out ? join(io.cwd, options.out) : join(io.cwd, '.ai-bdd', 'generated');
  const result = await generate({
    projectRoot: io.cwd,
    outDir,
    framework: options.framework ?? 'cucumber-js',
    ...(options.cacheDir !== undefined ? { cacheDir: options.cacheDir } : {}),
  });
  for (const file of result.files) io.out(`wrote ${relative(io.cwd, file)}`);
  io.out(`${result.actKeys.length} act program(s), ${result.checkKeys.length} check program(s), ${result.judgeOnly.length} judge-only assertion(s)`);
  return EXIT_CODES.ok;
}

export function parseReporter(value: string[] | undefined): ReporterName[] | undefined {
  if (!value) return undefined;
  return value as ReporterName[];
}

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function relative(root: string, path: string): string {
  return path.startsWith(root) ? path.slice(root.length + 1) : path;
}

export { loadConfig };

export interface ServeOptions {
  stdio?: boolean;
  http?: boolean;
  port?: number;
  config?: string;
  fake?: boolean;
}

/**
 * Runs the orchestrator daemon until the process is interrupted.
 *
 * The URL and the bearer token are written to `.ai-bdd/daemon.json` (mode 0600) so
 * a language plugin can find them; the token is printed once for a human too.
 */
export async function serveCommand(io: CliIo, options: ServeOptions = {}): Promise<number> {
  const context = await loadCliContext({
    projectRoot: io.cwd,
    env: process.env,
    ...(options.config !== undefined ? { configPath: join(io.cwd, options.config) } : {}),
    ...(options.fake !== undefined ? { fake: options.fake } : {}),
  });
  const { createSessionManager } = await import('@ai-bdd/runtime');
  const daemon = (await import('@ai-bdd/daemon' as string)) as {
    startDaemon: (options: unknown) => Promise<{ url?: string; token: string; close(): Promise<void> }>;
  };

  const sessionManager = createSessionManager({
    config: context.config,
    models: context.models,
    drivers: context.drivers,
    reapOrphans: true,
  });
  const handle = await daemon.startDaemon({
    sessionManager,
    projectRoot: io.cwd,
    host: context.config.daemon.host,
    port: options.port ?? context.config.daemon.port,
    stdio: options.stdio === true,
    http: options.http !== false,
  });

  if (handle.url) {
    io.out(`ai-bdd daemon listening on ${handle.url}`);
    io.out(`MCP tools: ${TOOL_SHORT_NAMES.map((short) => `aibdd_${short}`).join(', ')}`);
    io.out('the URL and token are in .ai-bdd/daemon.json (mode 0600)');
  } else {
    io.err('ai-bdd daemon serving MCP over stdio');
  }

  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      resolve();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    if (options.stdio === true) resolve();
  });
  await handle.close();
  return EXIT_CODES.ok;
}

export interface E2eHostGenerateOptions {
  globs?: string[];
  out?: string;
}

/** Writes the static e2e registration file (VERIFY V2 fallback for `@ai-bdd/e2e-host`). */
export async function e2eHostGenerate(io: CliIo, options: E2eHostGenerateOptions = {}): Promise<number> {
  const { defaultOutFile, describeOutput, generateRegistration } = (await import('@ai-bdd/e2e-host')) as {
    defaultOutFile: (root: string) => string;
    describeOutput: (root: string, file: string) => string;
    generateRegistration: (input: { projectRoot: string; globs: string[]; outFile: string }) => { tests: number; documents: number };
  };
  const outFile = options.out ? (options.out.startsWith('/') ? options.out : join(io.cwd, options.out)) : defaultOutFile(io.cwd);
  const result = generateRegistration({
    projectRoot: io.cwd,
    globs: options.globs && options.globs.length > 0 ? options.globs : ['specs/**/*.spec.md', 'specs/**/*.spec', 'features/**/*.feature'],
    outFile,
  });
  io.out(`wrote ${describeOutput(io.cwd, outFile)} (${result.tests} test(s) from ${result.documents} spec(s))`);
  return EXIT_CODES.ok;
}
