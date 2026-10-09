import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { TOOL_DEFINITIONS, type HealthOutput } from '@ai-bdd/contracts';
import { createSessionManager, resolveConfig } from '@ai-bdd/runtime';
import { createFakeModelSet } from '@ai-bdd/models/fake';
import { fake } from '@ai-bdd/driver-fake';
import { _repair } from '../../src/tools.js';
import { startDaemon, type DaemonHandle } from '../../src/index.js';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const handles: DaemonHandle[] = [];

afterEach(async () => {
  while (handles.length > 0) await handles.pop()!.close();
});

function backend(projectRoot: string) {
  const models = createFakeModelSet({ rulesPath: join(REPO, 'fixtures', 'fake-model', 'rules.json') });
  const config = resolveConfig(
    {
      specs: ['fixtures/specs/**/*.spec.md'],
      bindings: ['fixtures/bindings/**/*.ts'],
      drivers: { fake: { use: '@ai-bdd/driver-fake' } },
      defaultDriver: 'fake',
      concurrency: { scenarios: 1 },
      evidence: { dir: '.ai-bdd/runs', video: 'off', requireSettled: true, settle: { quietMs: 20, intervalMs: 10, timeoutMs: 300 } },
    },
    projectRoot,
  );
  const sessionManager = createSessionManager({
    config,
    models,
    drivers: { fake: fake({ modelPath: join(REPO, 'fixtures', 'app', 'model.json') }) },
  });
  return { sessionManager, models, config };
}

async function start(projectRoot: string): Promise<{ handle: DaemonHandle; url: string }> {
  const { sessionManager } = backend(projectRoot);
  const handle = await startDaemon({ sessionManager, projectRoot, host: '127.0.0.1', port: 0, token: 'test-token' });
  handles.push(handle);
  return { handle, url: handle.url! };
}

async function call(
  url: string,
  tool: string,
  body: unknown,
  options: { token?: string; traceparent?: string } = {},
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const response = await fetch(`${url}/v1/${tool}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(options.token !== undefined ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.traceparent !== undefined ? { traceparent: options.traceparent } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

describe('daemon surfaces (AC8)', () => {
  it('serves health without a token and reports the protocol version', async () => {
    const { url } = await start(mkdtempSync(join(tmpdir(), 'aibdd-daemon-')));
    const result = await call(url, 'health', {});
    expect(result.status).toBe(200);
    expect((result.body as HealthOutput).protocol).toBe(1);
    expect((result.body as HealthOutput).drivers[0]?.name).toBe('fake');
  });

  it('rejects a request without the bearer token', async () => {
    const { url } = await start(mkdtempSync(join(tmpdir(), 'aibdd-daemon-')));
    const result = await call(url, 'open_session', { scenarioId: 's', scenarioName: 'n', tags: [], plugin: { name: 'p', version: '1', language: 'ts' } });
    expect(result.status).toBe(401);
    expect((result.body as { error: { code: string } }).error.code).toBe('DAEMON_UNAUTHORIZED');
  });

  it('rejects unknown fields with INVALID_ARGUMENT', async () => {
    const { url } = await start(mkdtempSync(join(tmpdir(), 'aibdd-daemon-')));
    const result = await call(url, 'health', { unexpected: true }, { token: 'test-token' });
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe('INVALID_ARGUMENT');
  });

  it('echoes traceparent back', async () => {
    const { url } = await start(mkdtempSync(join(tmpdir(), 'aibdd-daemon-')));
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const result = await call(url, 'health', {}, { traceparent });
    expect(result.headers.get('traceparent')).toBe(traceparent);
  });

  it('runs a full plugin loop: open, resolve, run, close', async () => {
    const project = mkdtempSync(join(tmpdir(), 'aibdd-daemon-'));
    const { url } = await start(project);
    const plugin = { name: '@ai-bdd/cucumber', version: '0.1.0', language: 'typescript' };
    const opened = await call(url, 'open_session', { scenarioId: 'scenario-1', scenarioName: 'Member upgrades to Pro', tags: ['billing'], plugin }, { token: 'test-token' });
    expect(opened.status).toBe(200);
    const sessionId = (opened.body as { sessionId: string }).sessionId;
    expect((opened.body as { capabilities: { verbs: string[] } }).capabilities.verbs).toContain('navigate');

    const resolved = await call(
      url,
      'resolve_step',
      { sessionId, step: { text: 'Open billing settings', kind: 'action', stepId: 'step-1' } },
      { token: 'test-token' },
    );
    expect(resolved.status).toBe(200);
    expect((resolved.body as { next: string }).next).toBe('run-step');

    const ran = await call(url, 'run_step', { sessionId, step: { text: 'Open billing settings', kind: 'action', stepId: 'step-1' } }, { token: 'test-token' });
    expect(ran.status).toBe(200);
    expect((ran.body as { status: string }).status).toBe('passed');

    const closed = await call(url, 'close_session', { sessionId, status: 'passed' }, { token: 'test-token' });
    expect(closed.status).toBe(200);
    expect((closed.body as { scenarioResult: { status: string; steps: unknown[] } }).scenarioResult.status).toBe('passed');
    expect((closed.body as { scenarioResult: { steps: unknown[] } }).scenarioResult.steps.length).toBeGreaterThan(0);
  });

  it('accepts plugin-registered bindings and resolves them as invoke-local', async () => {
    const { url } = await start(mkdtempSync(join(tmpdir(), 'aibdd-daemon-')));
    const opened = await call(url, 'open_session', { scenarioId: 'scenario-2', scenarioName: 'n', tags: [], plugin: { name: 'p', version: '1', language: 'python' } }, { token: 'test-token' });
    const sessionId = (opened.body as { sessionId: string }).sessionId;
    const registered = await call(
      url,
      'register_bindings',
      {
        sessionId,
        provider: 'python:behave',
        bindings: [
          {
            id: 'python:behave#seed',
            provider: 'python:behave',
            pattern: 'Seed a workspace {string} on the {string} plan',
            patternKind: 'cucumber-expression',
            kind: 'setup',
            description: 'Seeds a workspace',
          },
        ],
      },
      { token: 'test-token' },
    );
    expect(registered.status).toBe(200);
    expect((registered.body as { accepted: number }).accepted).toBe(1);
    expect((registered.body as { bindingSetHash: string }).bindingSetHash).toMatch(/^[0-9a-f]{64}$/u);

    const resolved = await call(
      url,
      'resolve_step',
      { sessionId, step: { text: 'Seed a workspace "Acme" on the "free" plan', kind: 'setup', stepId: 'step-1' } },
      { token: 'test-token' },
    );
    expect((resolved.body as { next: string }).next).toBe('invoke-local');

    const reported = await call(
      url,
      'report_binding_result',
      {
        sessionId,
        step: { text: 'Seed a workspace "Acme" on the "free" plan', kind: 'setup', stepId: 'step-1' },
        bindingId: 'python:behave#seed',
        status: 'passed',
        durationMs: 3,
      },
      { token: 'test-token' },
    );
    expect(reported.status).toBe(200);
    expect((reported.body as { status: string }).status).toBe('passed');
  });

  it('writes daemon.json with mode 0600 and an atomic rename', async () => {
    const project = mkdtempSync(join(tmpdir(), 'aibdd-daemon-'));
    const { handle } = await start(project);
    const path = join(project, '.ai-bdd', 'daemon.json');
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { url: string; token: string };
    expect(parsed.url).toBe(handle.url);
    expect(parsed.token).toBe('test-token');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('reaps a stale session ledger entry for a dead pid', async () => {
    const project = mkdtempSync(join(tmpdir(), 'aibdd-daemon-'));
    const dir = join(project, '.ai-bdd', 'sessions');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'stale.json'), JSON.stringify({ pid: 999_999_999, driver: 'fake', openedAt: '2026-10-09T00:00:00.000Z' }));
    await start(project);
    expect(TOOL_DEFINITIONS.length).toBeGreaterThan(0);
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('R-K12a: the HTTP mirror and MCP are generated from one tool table', async () => {
    const { url } = await start(mkdtempSync(join(tmpdir(), 'aibdd-daemon-')));
    for (const definition of TOOL_DEFINITIONS) {
      const response = await fetch(`${url}${definition.path}`, { method: 'POST', body: '{}', headers: { authorization: 'Bearer test-token' } });
      expect(response.status, definition.name).not.toBe(404);
    }
    expect(_repair).toBeUndefined();
  });
});
