import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import type { AccountMachineCredentials } from '../shared/account-machines.ts';
import {
  runAccountPlannerOnce,
  resumeAccountPlanners,
} from '../server/machine/account-planner.ts';
import { privateJson } from '../server/machine/runtime.ts';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture() {
  const stateDirectory = await mkdtemp(
    join(tmpdir(), 'studio-account-planner-'),
  );
  cleanup.push(() => rm(stateDirectory, { recursive: true, force: true }));
  const next = {
    id: crypto.randomUUID(),
    artifactId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    repository: 'https://github.com/example/planner',
    checkoutKey: 'explicit',
    epoch: 1,
    status: 'queued',
    artifactVersion: 3,
    sourceHash: 'a'.repeat(64),
    profile: {
      harness: 'remote-planner' as const,
      provider: 'operator',
      model: 'unknown',
    },
  };
  const token = 'scoped-' + crypto.randomUUID();
  const control: {
    denyRenew: boolean;
    idle: boolean;
    tamper: boolean;
    releaseCode: number;
    lostClaim: boolean;
  } = {
    denyRenew: false,
    idle: true,
    tamper: false,
    releaseCode: 200,
    lostClaim: false,
  };
  const requests: { path: string; body: unknown }[] = [];
  let claims = 0,
    runs = 0;
  const credentials: AccountMachineCredentials = {
    scope: 'account',
    id: crypto.randomUUID(),
    token: 'A'.repeat(43),
    origin: '',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  };
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    expect(request.headers.authorization).toBe('Bearer ' + credentials.token);
    requests.push({ path: request.url, body: request.body });
  });
  const base = '/api/account-machines/:device/planners';
  app.post(base + '/poll', async () => ({ assignments: [next] }));
  app.post(base + '/:assignment/claim', async (_request, reply) => {
    claims++;
    if (control.lostClaim) {
      reply.raw.destroy();
      return reply;
    }
    return {
      assignmentId: next.id,
      epoch: next.epoch,
      artifactId: next.artifactId,
      projectId: next.projectId,
      repository: next.repository,
      checkoutKey: next.checkoutKey,
      profile: next.profile,
      artifactVersion: next.artifactVersion,
      sourceHash: control.tamper ? 'b'.repeat(64) : next.sourceHash,
      token,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };
  });
  app.post(base + '/:assignment/renew', async (_request, reply) =>
    control.denyRenew
      ? reply.code(403).send({ error: 'Fixture revoked' })
      : {
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          idle: control.idle,
        },
  );
  app.post(base + '/:assignment/release', async (_request, reply) =>
    reply.code(control.releaseCode).send({ ok: control.releaseCode === 200 }),
  );
  await app.listen({ host: '127.0.0.1', port: 0 });
  credentials.origin = app.listeningOrigin;
  cleanup.push(() => app.close());
  const checkouts = [
    {
      key: 'explicit',
      path: stateDirectory,
      registration: {
        checkoutKey: 'explicit',
        repository: next.repository,
        sourceCommit: 'c'.repeat(40),
        branch: 'main',
      },
    },
  ];
  const manifest = join(stateDirectory, 'account-planners', next.id + '.json');
  const run = () =>
    runAccountPlannerOnce(credentials, checkouts, {
      command: process.execPath,
      args: ['operator-agent.mjs'],
      stateDirectory,
      signal: AbortSignal.timeout(10000),
      renewMs: 10,
      run: async (options) => {
        runs++;
        expect(options.token).toBe(token);
        expect(await options.getToken()).toBe(token);
        expect(options.cwd).toBe(stateDirectory);
        expect(await readFile(manifest, 'utf8')).not.toContain(token);
        await new Promise<void>((resolve) => {
          options.signal.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
      },
    });
  return {
    stateDirectory,
    next,
    credentials,
    token,
    control,
    requests,
    checkouts,
    manifest,
    run,
    count: () => ({ claims, runs }),
  };
}
describe('Account-device Planner launch receipts', () => {
  it('launches only the registered frozen assignment with a distinct scoped token, renews and releases server-determined idle', async () => {
    const f = await fixture();
    expect(await f.run()).toEqual({
      claimed: true,
      workId: f.next.id,
      status: 'idle',
    });
    expect(f.count()).toEqual({ claims: 1, runs: 1 });
    expect(
      f.requests.find((request) => request.path.endsWith('/release'))?.body,
    ).toEqual({ epoch: 1, reason: 'idle' });
    expect(JSON.stringify(f.requests)).not.toContain(f.token);
    await expect(stat(f.manifest)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects a changed frozen source and unregistered repository before starting an ACP process', async () => {
    const f = await fixture();
    f.control.tamper = true;
    expect((await f.run()).status).toBe('failed');
    expect(f.count().runs).toBe(0);
    f.next.checkoutKey = 'server-outside-local-registry';
    await expect(f.run()).rejects.toThrow('outside');
    expect(f.count().runs).toBe(0);
  });
  it('aborts the local session immediately when fresh renewal authority is revoked', async () => {
    const f = await fixture();
    f.control.denyRenew = true;
    expect((await f.run()).status).toBe('failed');
    expect(f.count().runs).toBe(1);
    expect(f.requests.at(-1)?.body).toEqual({ epoch: 1, reason: 'failed' });
  });
  it('replays only a fenced failed release after a crash and never reruns an uncertain model turn', async () => {
    const f = await fixture();
    await privateJson(f.manifest, {
      version: 1,
      accountMachineId: f.credentials.id,
      origin: f.credentials.origin,
      assignmentId: f.next.id,
      epoch: 1,
      phase: 'running',
      reason: 'failed',
    });
    f.control.releaseCode = 409;
    await resumeAccountPlanners(f.credentials, f.stateDirectory);
    expect(f.count()).toEqual({ claims: 0, runs: 0 });
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.body).toEqual({ epoch: 1, reason: 'failed' });
    await expect(stat(f.manifest)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('does not repeat or execute a claim whose HTTP response was lost', async () => {
    const f = await fixture();
    f.control.lostClaim = true;
    expect((await f.run()).status).toBe('failed');
    expect(f.count()).toEqual({ claims: 1, runs: 0 });
    expect(f.requests.at(-1)?.body).toEqual({ epoch: 1, reason: 'failed' });
  });
});
