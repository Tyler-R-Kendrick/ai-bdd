// @ts-nocheck
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@ai-bdd/sdk';
import { cliOutput, runCli } from './helpers/cli.ts';
import { ACME_DEFAULT_ADMIN_PASSWORD, REPO_ROOT } from './helpers/paths.ts';
import { createProject, FAST_REAL, type Project } from './helpers/project.ts';
import { readRecordings } from './helpers/plans.ts';
import { latestRunDir, readRunReport } from './helpers/runs.ts';

const FIXTURE_DIR = `${REPO_ROOT}/tests/acceptance/fixtures/vendor-driver`;
const PACKAGE_NAME = 'ai-bdd-driver-vendor-fixture';

let project: Project | undefined;
afterEach(() => {
  project?.cleanup();
  project = undefined;
});

/** A project whose config plugs the vendor fixture in through `drivers: { name: { use, options } }`; the models are the deterministic test models. */
function projectWithVendorDriver(use: 'package' | 'path', flags: string[]): { p: Project; config: string; logFile: string } {
  const p = createProject({ docs: ['billing'], options: FAST_REAL });
  const logFile = p.path('vendor-driver.jsonl');
  let spec: string;
  if (use === 'package') {
    // installed like any third-party package: <project>/node_modules/<name>
    cpSync(FIXTURE_DIR, p.path('node_modules', PACKAGE_NAME), { recursive: true });
    spec = PACKAGE_NAME;
  } else {
    cpSync(FIXTURE_DIR, p.path('vendor', 'driver'), { recursive: true });
    spec = './vendor/driver/index.mjs';
  }
  const config = p.path('ai-bdd.config.vendor.mjs');
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(
    config,
    [
      "import { createFakeModels } from '@ai-bdd/testing';",
      "import base from './ai-bdd.config.mjs';",
      'export default {',
      '  ...base,',
      `  drivers: { 'vendor-fixture': { use: ${JSON.stringify(spec)}, options: ${JSON.stringify({ flags, logFile })} } },`,
      "  defaultDriver: 'vendor-fixture',",
      `  models: createFakeModels(${JSON.stringify({ rulesDir: p.rulesDir, logPath: p.logPath })}),`,
      '};',
      '',
    ].join('\n'),
  );
  return { p, config, logFile };
}

describe('M26 pluggable drivers', () => {
  it.each(['package', 'path'] as const)('pluggable drivers load through { use, options } (%s)', async (use) => {
    const { p, config, logFile } = projectWithVendorDriver(use, ['bug-upgrade-noop']);
    project = p;

    // the SDK resolves the entry into a driver factory built by the package from `options`
    const loaded = await loadConfig({ cwd: p.dir, configPath: config, env: { ACME_ADMIN_PASSWORD: ACME_DEFAULT_ADMIN_PASSWORD } });
    expect(Object.keys(loaded.drivers)).toEqual(['vendor-fixture']);
    expect(typeof loaded.drivers['vendor-fixture']?.create).toBe('function');
    expect(loaded.defaultDriver).toBe('vendor-fixture');

    // and the CLI runs what the loaded config registers, nothing else
    const compiled = await runCli(p, ['compile'], { config });
    expect(compiled.code, cliOutput(compiled)).toBe(0);
    const run = await runCli(p, ['run', 'docs/billing.md', '--grep', 'Upgrade from Free'], { config });
    // the option `flags: ['bug-upgrade-noop']` reached the factory: the upgrade no longer works, so the scenario fails
    expect(run.code, cliOutput(run)).toBe(1);
    expect(readFileSync(logFile, 'utf8')).toContain('"created":"vendor-fixture"');
    const report = readRunReport(latestRunDir(p));
    expect(report.scenarios.some((s) => s.status === 'failed')).toBe(true);

    // other options, same package: the upgrade works and the run passes
    writeFileSync(config, readFileSync(config, 'utf8').replace('"bug-upgrade-noop"', ''));
    const passing = await runCli(p, ['run', 'docs/billing.md', '--grep', 'Upgrade from Free'], { config: 'ai-bdd.config.vendor.mjs' });
    expect(passing.code, cliOutput(passing)).toBe(0);
    const passedReport = readRunReport(latestRunDir(p));
    expect(passedReport.scenarios.length).toBeGreaterThan(0);
    expect(passedReport.scenarios.every((s) => s.status === 'passed')).toBe(true);
    expect(readRecordings(p).length).toBeGreaterThan(0);
    expect(readFileSync(logFile, 'utf8').trim().split('\n')).toHaveLength(2); // one driver per CLI process, none in compile
  });

  it('M26: a driver package without createDriverFactory(options) is a config error (exit 2)', async () => {
    const p = createProject({ docs: ['billing'], options: FAST_REAL });
    project = p;
    mkdirSync(p.path('vendor'), { recursive: true });
    writeFileSync(p.path('vendor', 'broken.mjs'), 'export const notAFactory = 1;\n');
    const config = p.path('ai-bdd.config.broken.mjs');
    writeFileSync(
      config,
      "import base from './ai-bdd.config.mjs';\nexport default { ...base, drivers: { broken: { use: './vendor/broken.mjs', options: {} } }, defaultDriver: 'broken' };\n",
    );
    const r = await runCli(p, ['status'], { config });
    expect(r.code, cliOutput(r)).toBe(2);
    expect(r.stderr).toContain('createDriverFactory');
  });
});
