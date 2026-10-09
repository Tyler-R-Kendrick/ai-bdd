import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { StepResult } from '@ai-bdd/contracts';
import { createSessionManager, resolveConfig } from '@ai-bdd/runtime';
import { startDaemon, type DaemonHandle } from '@ai-bdd/daemon';
import { createFakeModelSet } from '@ai-bdd/models/fake';
import { fake } from '@ai-bdd/driver-fake';
import { DaemonClient } from '../../src/client.js';
import { Given, localBindings, Then, When } from '../../src/registry.js';
import { catchAllPattern, register, type CucumberApi, type CucumberWorld } from '../../src/register.js';

const REPO = fileURLToPath(new URL('../../../../..', import.meta.url));
const handles: DaemonHandle[] = [];

afterEach(async () => {
  while (handles.length > 0) await handles.pop()!.close();
});

async function startDaemonForFixtureProject(): Promise<{ url: string; token: string; projectRoot: string }> {
  const projectRoot = mkdtempSync(join(tmpdir(), 'aibdd-cuke-'));
  cpSync(join(REPO, 'fixtures', 'specs'), join(projectRoot, 'fixtures', 'specs'), { recursive: true });
  cpSync(join(REPO, 'fixtures', 'bindings'), join(projectRoot, 'fixtures', 'bindings'), { recursive: true });
  mkdirSync(join(projectRoot, 'fixtures', 'app'), { recursive: true });
  cpSync(join(REPO, 'fixtures', 'app', 'model.json'), join(projectRoot, 'fixtures', 'app', 'model.json'));
  mkdirSync(join(projectRoot, 'fixtures', 'fake-model'), { recursive: true });
  for (const file of ['rules.json', 'synonyms.json']) {
    cpSync(join(REPO, 'fixtures', 'fake-model', file), join(projectRoot, 'fixtures', 'fake-model', file));
  }
  const models = createFakeModelSet({ rulesPath: join(projectRoot, 'fixtures', 'fake-model', 'rules.json') });
  const config = resolveConfig(
    {
      specs: ['fixtures/specs/**/*.spec.md'],
      bindings: ['fixtures/bindings/**/*.ts'],
      drivers: { fake: { use: '@ai-bdd/driver-fake' } },
      defaultDriver: 'fake',
      evidence: { dir: '.ai-bdd/runs', video: 'off', requireSettled: true, settle: { quietMs: 20, intervalMs: 10, timeoutMs: 300 } },
    },
    projectRoot,
  );
  const handle = await startDaemon({
    sessionManager: createSessionManager({
      config,
      models,
      drivers: { fake: fake({ modelPath: join(projectRoot, 'fixtures', 'app', 'model.json') }) },
    }),
    projectRoot,
    host: '127.0.0.1',
    port: 0,
    token: 'plugin-test-token',
  });
  handles.push(handle);
  return { url: handle.url!, token: handle.token, projectRoot };
}

/** A minimal stand-in for the cucumber-js support API. */
function fakeCucumber(): { api: CucumberApi; steps: Array<{ pattern: RegExp; run: (text: string) => Promise<unknown> }>; before: Array<() => Promise<void>>; after: Array<() => Promise<void>> } {
  const steps: Array<{ pattern: RegExp; run: (text: string) => Promise<unknown> }> = [];
  const before: Array<() => Promise<void>> = [];
  const after: Array<() => Promise<void>> = [];
  const api: CucumberApi = {
    defineStep: (pattern, fn) => {
      steps.push({
        pattern,
        run: async (text: string) =>
          (fn as (this: CucumberWorld, ...args: unknown[]) => Promise<unknown>).call(
            { pickle: { name: 'Member upgrades to Pro', uri: 'specs/billing.feature', tags: [{ name: '@billing' }] } },
            text,
          ),
      });
    },
    Before: (fn) => {
      before.push(() => (fn as (this: CucumberWorld) => Promise<void>).call({ pickle: { name: 'Member upgrades to Pro', uri: 'specs/billing.feature' } }));
    },
    After: (fn) => {
      after.push(() => (fn as (this: CucumberWorld) => Promise<void>).call({ pickle: { name: 'Member upgrades to Pro', uri: 'specs/billing.feature' } }));
    },
  };
  return { api, steps, before, after };
}

/**
 * The cucumber-js plugin conformance-style test.
 *
 * `@cucumber/cucumber` itself is not installed here, so the plugin is driven
 * through a stand-in for the three hooks it uses (`defineStep`, `Before`,
 * `After`). Everything else — the daemon protocol, the catch-all, resolve,
 * invoke-local, agent fallback and evidence — is real.
 */
describe('@ai-bdd/cucumber plugin', () => {
  it('declares a catch-all that never shadows native steps in coexist mode', () => {
    const plain = catchAllPattern(['I open the settings page'], false);
    expect(plain.test('anything at all')).toBe(true);
    const coexist = catchAllPattern(['I open the settings page'], true);
    expect(coexist.test('I open the settings page')).toBe(false);
    expect(coexist.test('Open billing settings')).toBe(true);
  });

  it('runs a bound setup step locally and an unbound action through the daemon', async () => {
    const daemon = await startDaemonForFixtureProject();
    const cucumber = fakeCucumber();
    let boundCalls = 0;
    // A distinct pattern: the fixture project already binds the plain seed sentence,
    // and two exact matches must be reported as STEP_AMBIGUOUS rather than guessed.
    Given('Seed a demo workspace {string} on the {string} plan', async () => {
      boundCalls += 1;
    });
    const world = register({
      url: daemon.url,
      token: daemon.token,
      cucumber: cucumber.api,
      projectRoot: daemon.projectRoot,
    });

    for (const hook of cucumber.before) await hook();
    expect(world.sessionId).toBeDefined();
    expect(cucumber.steps).toHaveLength(1);

    // A bound step: the daemon answers invoke-local and the plugin reports back.
    await cucumber.steps[0]!.run('Seed a demo workspace "Acme" on the "free" plan');
    expect(boundCalls).toBe(1);

    // An unbound action: the daemon runs the act loop itself.
    await cucumber.steps[0]!.run('Open billing settings');

    for (const hook of cucumber.after) await hook();
    expect(world.sessionId).toBeUndefined();
  });

  it('surfaces a failing step as a thrown error so cucumber-js reports FAILED', async () => {
    const daemon = await startDaemonForFixtureProject();
    const cucumber = fakeCucumber();
    register({ url: daemon.url, token: daemon.token, cucumber: cucumber.api, projectRoot: daemon.projectRoot });
    for (const hook of cucumber.before) await hook();
    await expect(cucumber.steps[0]!.run('Seed an empty workspace')).rejects.toThrow(/SETUP_UNBOUND|STEP_AMBIGUOUS/u);
    for (const hook of cucumber.after) await hook();
  });

  it('reports a missing daemon with an actionable message', async () => {
    const client = new DaemonClient({ projectRoot: mkdtempSync(join(tmpdir(), 'aibdd-nodaemon-')) });
    expect(client.available()).toBe(false);
    await expect(client.call('health', {})).rejects.toThrow(/no daemon is running/u);
  });

  it('maps a daemon error payload onto a typed error', async () => {
    const daemon = await startDaemonForFixtureProject();
    const client = new DaemonClient({ url: daemon.url, token: daemon.token });
    await expect(client.call('resolve_step', { sessionId: 'nope', step: { text: 'x' } })).rejects.toMatchObject({
      code: 'NO_SESSION',
    });
  });

  it('publishes local bindings to the daemon with the hashes stripped', async () => {
    const daemon = await startDaemonForFixtureProject();
    const cucumber = fakeCucumber();
    When('Publish the release notes', async () => undefined, { description: 'Publishes the release notes' });
    const published = localBindings.publish();
    expect(published.length).toBeGreaterThan(0);
    expect(Object.keys(published[0]!)).not.toContain('hash');

    const client = new DaemonClient({ url: daemon.url, token: daemon.token });
    const opened = await client.call<{ sessionId: string }>('open_session', {
      scenarioId: 's',
      scenarioName: 'n',
      tags: [],
      plugin: { name: '@ai-bdd/cucumber', version: '0.1.0', language: 'typescript' },
    });
    const registered = await client.call<{ accepted: number; bindingSetHash: string }>('register_bindings', {
      sessionId: opened.sessionId,
      provider: 'ts:cucumber',
      bindings: published,
    });
    expect(registered.accepted).toBe(published.length);
    expect(registered.bindingSetHash).toMatch(/^[0-9a-f]{64}$/u);

    const resolved = await client.call<{ next: string }>('resolve_step', {
      sessionId: opened.sessionId,
      step: { text: 'Publish the release notes', kind: 'action' },
    });
    expect(resolved.next).toBe('invoke-local');
    void cucumber;
  });

  it('records evidence for a locally executed binding', async () => {
    const daemon = await startDaemonForFixtureProject();
    const cucumber = fakeCucumber();
    Then('The release notes are published', async () => undefined);
    register({ url: daemon.url, token: daemon.token, cucumber: cucumber.api, projectRoot: daemon.projectRoot });
    for (const hook of cucumber.before) await hook();
    await cucumber.steps[0]!.run('The release notes are published');
    for (const hook of cucumber.after) await hook();

    // The daemon wrote an evidence record for the reported local binding.
    const runs = readdirSync(join(daemon.projectRoot, '.ai-bdd', 'runs'));
    expect(runs.length).toBeGreaterThan(0);
    const manifest = readFileSync(join(daemon.projectRoot, '.ai-bdd', 'runs', runs[0]!, 'manifest.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { kind: string; chainHash: string });
    expect(manifest.length).toBeGreaterThan(0);
    expect(manifest.every((record) => /^[0-9a-f]{64}$/u.test(record.chainHash))).toBe(true);
  });
});

export type { StepResult };
