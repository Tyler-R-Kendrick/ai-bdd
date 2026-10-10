// @ts-nocheck
import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@ai-bdd/sdk';
import { cliOutput, runCli } from './helpers/cli.ts';
import { ACME_DEFAULT_ADMIN_PASSWORD } from './helpers/paths.ts';
import { createProject, FAST_REAL, type Project } from './helpers/project.ts';

let project: Project | undefined;
afterEach(() => {
  project?.cleanup();
  project = undefined;
});

/** A project whose config plugs the Cua Driver package in through `drivers: { name: { use, options } }`; no desktop is needed to load it. */
function projectWithCuaDriver(options: Record<string, unknown>): { p: Project; config: string } {
  const p = createProject({ docs: ['billing'], options: FAST_REAL });
  const config = p.path('ai-bdd.config.cua.mjs');
  writeFileSync(
    config,
    [
      "import { createFakeModels } from '@ai-bdd/testing';",
      "import base from './ai-bdd.config.mjs';",
      'export default {',
      '  ...base,',
      `  drivers: { desktop: { use: '@ai-bdd/driver-cua', options: ${JSON.stringify(options)} } },`,
      "  defaultDriver: 'desktop',",
      `  models: createFakeModels(${JSON.stringify({ rulesDir: p.rulesDir, logPath: p.logPath })}),`,
      '};',
      '',
    ].join('\n'),
  );
  return { p, config };
}

describe('M27 the Cua Driver package (@ai-bdd/driver-cua) plugs in through { use, options }', () => {
  it('loads as the driver "cua", with the capabilities of a browser window', async () => {
    const { p, config } = projectWithCuaDriver({ kind: 'browser', launch: { command: 'chromium', args: ['--user-data-dir={profile}', '{url}'] } });
    project = p;
    const loaded = await loadConfig({ cwd: p.dir, configPath: config, env: { ACME_ADMIN_PASSWORD: ACME_DEFAULT_ADMIN_PASSWORD } });
    expect(Object.keys(loaded.drivers)).toEqual(['desktop']);
    expect(loaded.drivers['desktop']?.id).toBe('cua');
    const driver = await loaded.drivers['desktop']?.create({ projectRoot: p.dir, policy: { allowHosts: [], denyVerbs: [] }, artifactsDir: p.dir });
    expect(driver?.capabilities.verbs).toEqual(['click', 'fill', 'press', 'check', 'scroll', 'wait', 'navigate', 'back']);
    expect(driver?.capabilities).toMatchObject({ maxSessions: 1, exclusiveResource: 'cua-desktop', maskingProven: false, request: false });
    await driver?.dispose();
  });

  it('rejects unknown or ill-typed options as a config error (exit 2) that names the package and the option', async () => {
    const { p, config } = projectWithCuaDriver({ kind: 'browser', launch: { command: 'chromium' }, delivery: 'sometimes' });
    project = p;
    const r = await runCli(p, ['status'], { config });
    expect(r.code, cliOutput(r)).toBe(2);
    expect(r.stderr).toContain('driver-cua');
    expect(r.stderr).toContain('delivery');
  });

  it('a config that names neither an app to launch nor a window to drive is rejected', async () => {
    const { p, config } = projectWithCuaDriver({ kind: 'browser' });
    project = p;
    const r = await runCli(p, ['status'], { config });
    expect(r.code, cliOutput(r)).toBe(2);
    expect(r.stderr).toContain('launch');
  });

  it('without Cua Driver installed, doctor reports the driver as unavailable with the install link instead of crashing', async () => {
    const { p, config } = projectWithCuaDriver({
      kind: 'browser', launch: { command: 'chromium' }, cuaDriver: { command: '/definitely/not/installed/cua-driver' },
    });
    project = p;
    const r = await runCli(p, ['doctor'], { config });
    expect(r.code, cliOutput(r)).not.toBe(0);
    expect(cliOutput(r)).toContain('cua.ai/docs/cua-driver');
  });
});
