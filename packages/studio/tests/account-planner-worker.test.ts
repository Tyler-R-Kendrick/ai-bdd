import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  mkdir,
  writeFile,
} from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import type { AccountMachineCredentials } from '../shared/account-machines.ts';
import {
  runAccountPlannerOnce,
  resumeAccountPlanners,
} from '../server/machine/account-planner.ts';
import { privateJson } from '../server/machine/runtime.ts';
const cleanup: (() => Promise<unknown>)[] = [];
const execute = promisify(execFile);
beforeAll(async () => {
  await execute(process.execPath, ['scripts/build-connector.mjs'], {
    timeout: 30000,
  });
});
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
    deviceId: crypto.randomUUID(),
    artifactId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    repository: 'https://github.com/example/planner',
    checkoutKey: 'explicit',
    epoch: 1,
    status: 'queued',
    artifactVersion: 3,
    expiresAt: null,
    idleExpiresAt: new Date(Date.now() + 120000).toISOString(),
    sourceHash: 'a'.repeat(64),
    profile: {
      harness: 'remote-planner' as const,
      provider: 'operator',
      model: 'unknown',
    },
  };
  const checkout = join(stateDirectory, 'checkout');
  await mkdir(checkout);
  await execute('git', ['init', checkout]);
  await writeFile(join(checkout, 'source.txt'), 'Synthetic approved source\n');
  await execute('git', ['-C', checkout, 'add', 'source.txt']);
  await execute('git', [
    '-C',
    checkout,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-m',
    'Fixture baseline',
  ]);
  await execute('git', [
    '-C',
    checkout,
    'remote',
    'add',
    'origin',
    next.repository,
  ]);
  const sourceCommit = (
    await execute('git', ['-C', checkout, 'rev-parse', 'HEAD'])
  ).stdout.trim();
  await writeFile(
    join(checkout, 'source.txt'),
    'Operator dirty edit remains untouched\n',
  );
  const token = 'scoped-' + crypto.randomUUID();
  const control: {
    denyRenew: boolean;
    idle: boolean;
    tamper: boolean;
    releaseCode: number;
    lostClaim: boolean;
    expiryMs: number;
    renewalDelayMs: number;
    renewMs: number;
  } = {
    denyRenew: false,
    idle: true,
    tamper: false,
    releaseCode: 200,
    lostClaim: false,
    expiryMs: 60000,
    renewalDelayMs: 0,
    renewMs: 100,
  };
  const requests: { path: string; body: unknown }[] = [];
  const outputs: unknown[] = [];
  let claims = 0,
    runs = 0;
  const credentials: AccountMachineCredentials = {
    scope: 'account',
    id: next.deviceId,
    token: 'A'.repeat(43),
    origin: '',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  };
  const app = Fastify();
  await app.register(websocket);
  app.addHook('preHandler', async (request) => {
    expect(request.headers.authorization).toBe(
      'Bearer ' +
        (request.url === '/api/planner/connect' ? token : credentials.token),
    );
    requests.push({ path: request.url, body: request.body });
  });
  app.get('/api/planner/connect', { websocket: true }, (socket) => {
    socket.on('message', (bytes) => {
      const message = JSON.parse(bytes.toString());
      if (message.type === 'attach') {
        expect(message.artifactId).toBe(next.artifactId);
        socket.send(JSON.stringify({ type: 'attached', features: [] }));
        socket.send(
          JSON.stringify({
            type: 'turn',
            requestId: crypto.randomUUID(),
            input: {
              profile: next.profile,
              artifactId: next.artifactId,
              threadId: crypto.randomUUID(),
              intent: 'chat',
              context: 'Local HTTP/WS fixture',
              brief: 'Return a synthetic connector observation',
              sources: [],
              repository: next.repository,
            },
          }),
        );
      } else if (message.type === 'result') outputs.push(message.output);
    });
  });
  app.post('/api/account-machines/:device/assignments', async () => ({
    assignments: [],
    blocked: [],
    capabilities: ['planner-assignments-v1'],
  }));
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
      expiresAt: new Date(Date.now() + control.expiryMs).toISOString(),
      idleExpiresAt: next.idleExpiresAt,
    };
  });
  app.post(base + '/:assignment/renew', async (_request, reply) => {
    if (control.renewalDelayMs)
      await new Promise((resolve) =>
        setTimeout(resolve, control.renewalDelayMs),
      );
    return control.denyRenew
      ? reply.code(403).send({ error: 'Fixture revoked' })
      : {
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          idle: control.idle,
        };
  });
  app.post(base + '/:assignment/release', async (_request, reply) =>
    reply.code(control.releaseCode).send({ ok: control.releaseCode === 200 }),
  );
  await app.listen({ host: '127.0.0.1', port: 0 });
  credentials.origin = app.listeningOrigin;
  cleanup.push(() => app.close());
  const checkouts = [
    {
      key: 'explicit',
      path: checkout,
      registration: {
        checkoutKey: 'explicit',
        repository: next.repository,
        sourceCommit,
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
      renewMs: control.renewMs,
      run: async (options) => {
        runs++;
        expect(options.token).toBe(token);
        expect(await options.getToken()).toBe(token);
        expect(options.cwd).toContain(
          join(stateDirectory, 'planner-worktrees', 'worktrees'),
        );
        expect(await readFile(join(options.cwd, 'source.txt'), 'utf8')).toBe(
          'Synthetic approved source\n',
        );
        expect(await readFile(join(checkout, 'source.txt'), 'utf8')).toBe(
          'Operator dirty edit remains untouched\n',
        );
        expect(
          (
            await execute('git', [
              '-C',
              options.cwd,
              'remote',
              'get-url',
              '--push',
              'origin',
            ])
          ).stdout.trim(),
        ).toBe('file:///dev/null');
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
    outputs,
    run,
    count: () => ({ claims, runs }),
  };
}
describe('Account-device Planner launch receipts', () => {
  it('launches the built standalone account connector through actual Git, HTTP, scoped WebSocket and ACP, then stops without replay', async () => {
    const f = await fixture();
    const checkout = f.checkouts[0]!.path;
    const agent = join(f.stateDirectory, 'operator-agent.cjs');
    await writeFile(
      agent,
      `const r=require('node:readline');const send=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');r.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1}});else if(m.method==='session/new')send({id:m.id,result:{sessionId:'fixture'}});else if(m.method==='session/prompt'){if(Object.keys(process.env).some(k=>k.startsWith('STUDIO_')))process.exit(2);send({method:'session/update',params:{sessionId:'fixture',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify({summary:'Actual standalone local ACP Planner fixture'})}}}});send({id:m.id,result:{stopReason:'end_turn'}});}});`,
    );
    const credentialFile = join(f.stateDirectory, 'device.json');
    await privateJson(credentialFile, f.credentials);
    const child = spawn(process.execPath, ['dist/connector.mjs', '--once'], {
      env: {
        ...process.env,
        STUDIO_API_URL: f.credentials.origin,
        STUDIO_MACHINE_SCOPE: 'account',
        STUDIO_MACHINE_CREDENTIALS: credentialFile,
        STUDIO_MACHINE_STATE_DIR: f.stateDirectory,
        STUDIO_MACHINE_CHECKOUTS: JSON.stringify([
          { key: 'explicit', path: checkout },
        ]),
        STUDIO_MACHINE_AGENT_COMMAND: process.execPath,
        STUDIO_MACHINE_AGENT_ARGS: JSON.stringify([agent]),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stopped = once(child, 'close');
    let output = '',
      error = '';
    child.stdout.on('data', (value) => {
      output += String(value);
    });
    child.stderr.on('data', (value) => {
      error += String(value);
    });
    try {
      const deadline = Date.now() + 5000;
      while (!f.outputs.length) {
        if (Date.now() > deadline)
          throw new Error(
            'The standalone Planner fixture did not publish a result',
          );
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      child.kill('SIGTERM');
      expect((await stopped)[0], error).toBe(0);
      expect(f.outputs).toEqual([
        { text: 'Actual standalone local ACP Planner fixture', content: null },
      ]);
      expect(JSON.parse(output)).toMatchObject({
        claimed: true,
        workId: f.next.id,
        status: 'stopped',
      });
      expect(f.requests.at(-1)?.body).toEqual({ epoch: 1, reason: 'stopped' });
      expect(f.count().claims).toBe(1);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }, 15000);
  it('enforces token expiry even while a renewal HTTP request is stalled', async () => {
    const f = await fixture();
    f.control.expiryMs = 500;
    f.control.renewalDelayMs = 1000;
    f.control.renewMs = 10;
    f.control.idle = false;
    const started = Date.now();
    expect((await f.run()).status).toBe('failed');
    expect(Date.now() - started).toBeLessThan(900);
    expect(f.count().runs).toBe(1);
  });
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
