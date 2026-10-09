import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** Attack 11: daemon auth bypass, path traversal through aibdd_get_evidence. */
const REPO = fileURLToPath(new URL('../../', import.meta.url));

let child: ChildProcess | undefined;
let url = '';
let token = '';

beforeAll(async () => {
  const project = mkdtempSync(join(tmpdir(), 'aibdd-adv-daemon-'));
  child = spawn('node', [join(REPO, 'packages/cli/dist/bin.js'), 'serve', '--fake-script', '--port', '0'], {
    cwd: project,
    stdio: 'ignore',
  });
  const { readFileSync } = await import('node:fs');
  const daemonFile = join(project, '.ai-bdd', 'daemon.json');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const payload = JSON.parse(readFileSync(daemonFile, 'utf8')) as { url: string; token: string };
      url = payload.url;
      token = payload.token;
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('the scripted daemon never wrote daemon.json');
}, 120_000);

afterAll(() => child?.kill());

async function call(tool: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; payload: Record<string, unknown> }> {
  const response = await fetch(`${url}/v1/${tool}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, payload: (await response.json()) as Record<string, unknown> };
}

describe('attack 11: daemon surface', () => {
  it('rejects a theless request on a stateful tool', async () => {
    const result = await call('open_session', { scenarioId: 's', scenarioName: 'n', tags: [], plugin: { name: 'p', version: '1', language: 'ts' } });
    expect(result.status).toBe(401);
  });

  it('rejects a forged bearer token', async () => {
    const result = await call('open_session', { scenarioId: 's', scenarioName: 'n', tags: [], plugin: { name: 'p', version: '1', language: 'ts' } }, { authorization: 'Bearer not-the-token' });
    expect(result.status).toBe(401);
  });

  it('rejects unknown fields instead of ignoring them', async () => {
    const result = await call('health', { unexpected: true }, { authorization: `Bearer ${token}` });
    expect(result.status).toBe(400);
    expect((result.payload.error as { code: string }).code).toBe('INVALID_ARGUMENT');
  });

  it('refuses an evidence id that tries to traverse out of the run directory', async () => {
    const result = await call('get_evidence', { evidenceId: '../../../etc/passwd' }, { authorization: `Bearer ${token}` });
    expect(result.status).toBeGreaterThanOrEqual(400);
    // The response may echo the id it was asked for; what matters is that it never
    // resolves to a path outside the run directory.
    expect(result.payload).not.toHaveProperty('absolutePath');
    expect(JSON.stringify(result.payload)).toContain('unknown evidence id');
  });

  it('refuses an absolute path as an evidence id', async () => {
    const result = await call('get_evidence', { evidenceId: '/etc/passwd' }, { authorization: `Bearer ${token}` });
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.payload).not.toHaveProperty('absolutePath');
  });
});
