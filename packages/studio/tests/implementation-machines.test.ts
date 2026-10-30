import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import { Store } from '../server/store.ts';
import { openDatabase } from '../server/persistence/index.ts';
import { MachineService } from '../server/integrations/machines.ts';
import {
  InvestigationService,
  registerInvestigationRoutes,
} from '../server/integrations/investigations.ts';
import { ImplementationGraphs } from '../server/integrations/implementation.ts';
import { registerImplementationMachineRoutes } from '../server/integrations/implementation-machines.ts';
import { DiskObjectStore } from '../server/hosting/disk-objects.ts';
import {
  implementationPointer,
  type ImplementationReport,
} from '../shared/implementation.ts';
import { inspectCheckout, privateJson } from '../server/machine/runtime.ts';
import {
  runImplementationOnce,
  resumeImplementationRuns,
} from '../server/machine/implementation-worker.ts';
import type { MachineCredentials } from '../server/machine-worker.ts';
import {
  sendImplementationReport,
  resumeImplementationReports,
} from '../server/machine/implementation-bridge.ts';
const execute = promisify(execFile),
  require = createRequire(import.meta.url),
  close: (() => Promise<unknown>)[] = [],
  url =
    process.env.STUDIO_IMPLEMENTATION_TEST_POSTGRES_URL ??
    process.env.STUDIO_TEST_POSTGRES_URL;
afterEach(async () => {
  for (const fn of close.splice(0).reverse()) await fn();
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'studio-graph-machine-'));
  close.push(() => rm(dir, { recursive: true, force: true }));
  const cwd = join(dir, 'repo');
  await execute('git', ['init', cwd]);
  for (const [key, value] of [
    ['user.email', 'fixture@example.test'],
    ['user.name', 'Fixture'],
    ['remote.origin.url', 'https://github.com/example/graph-fixture'],
  ])
    await execute('git', ['-C', cwd, 'config', key!, value!]);
  await writeFile(join(cwd, 'source.txt'), 'approved baseline\n');
  await execute('git', ['-C', cwd, 'add', 'source.txt']);
  await execute('git', ['-C', cwd, 'commit', '-m', 'Fixture baseline']);
  const checkout = await inspectCheckout(cwd);
  await writeFile(join(cwd, 'source.txt'), 'operator dirty edit\n');
  const store = await Store.open(
    url
      ? await openDatabase({
          adapter: 'postgres',
          url,
          schema: 'machine_graph_' + crypto.randomUUID().replaceAll('-', ''),
        })
      : ':memory:',
  );
  close.push(() => store.close());
  const user = await store.createUser(
      'graph-owner@example.test',
      'Graph owner',
      null,
    ),
    project = (await store.createProject(
      user,
      'Graph machine',
      '',
      checkout.repository,
    ))!,
    artifact = await store.createArtifact(
      user,
      project.id,
      'design',
      'Approved graph plan',
    ),
    machines = new MachineService(store, { notify() {} } as any);
  await machines.initialize();
  const paired = await machines.pair(
      (await machines.pairing(user, project.id, 'Selected machine')).code,
    ),
    principal = await store.one(
      'SELECT * FROM studio_machines WHERE id=?',
      paired.id,
    );
  const investigations = new InvestigationService({
    store,
    auth: {} as any,
    machines,
    objects: new DiskObjectStore(join(dir, 'objects')),
  });
  await investigations.ready;
  await investigations.registerCheckout(principal, {
    repository: checkout.repository,
    sourceCommit: checkout.sourceCommit,
    branch: checkout.branch,
  });
  const graphs = new ImplementationGraphs({ store });
  await graphs.initialize();
  const draft = await graphs.edit({ user, kind: 'human' }, artifact.id, {
    expected: null,
    planRevision: artifact.version,
    definition: {
      tasks: [
        {
          id: 'inspect',
          title: 'Inspect sealed baseline',
          description: 'Inspect this exact source commit',
          acceptanceCriteria: [
            'The isolated worktree source matches the approved baseline',
          ],
        },
      ],
      edges: [],
    },
  });
  const app = Fastify();
  app.setErrorHandler((error, _, reply) =>
    reply
      .code((error as any).statusCode ?? 500)
      .send({ error: (error as Error).message }),
  );
  await registerInvestigationRoutes(app, {
    store,
    auth: {} as any,
    machines,
    objects: new DiskObjectStore(join(dir, 'objects')),
  });
  const service = await registerImplementationMachineRoutes(app, {
    store,
    auth: { user: async () => user, assertOrigin: () => {} } as any,
    machines,
    graphs,
    otherWorkActive: (id) => investigations.activeOnMachine(id),
  });
  graphs.options.externalEditingLock = (id) => service.editingLock(id);
  machines.hooks.otherWorkActive = async (id) =>
    (await service.activeOnMachine(id)) ||
    (await investigations.activeOnMachine(id));
  store.artifactWriteGuard = (artifact) =>
    graphs.assertPlanEditable(artifact.id);
  await app.listen({ host: '127.0.0.1', port: 0 });
  close.push(() => app.close());
  const credentials: MachineCredentials = {
    ...paired,
    origin: app.listeningOrigin,
  };
  const queue = () =>
    service.queue(user, artifact.id, {
      expected: implementationPointer(draft),
      machineId: principal.id,
    });
  return {
    dir,
    cwd,
    checkout,
    store,
    user,
    project,
    artifact,
    machines,
    principal,
    graphs,
    draft,
    service,
    app,
    credentials,
    queue,
  };
}
async function started(c: Awaited<ReturnType<typeof fixture>>) {
  const queued = await c.queue(),
    claimed = await c.service.claim(c.principal),
    lease = {
      leaseToken: claimed.leaseToken!,
      generation: claimed.work!.generation,
    },
    work = claimed.work!,
    run = await c.service.start(c.principal, queued.id, {
      ...lease,
      checkout: {
        expected: work.expected,
        repository: work.repository,
        commit: work.sourceCommit,
        branch: work.branch,
      },
    });
  return { queued, lease, run };
}
async function completeTask(
  c: Awaited<ReturnType<typeof fixture>>,
  state: Awaited<ReturnType<typeof started>>,
) {
  for (const [key, command] of [
    ['start', { kind: 'start_task', taskId: 'inspect' }],
    [
      'complete',
      {
        kind: 'complete_task',
        taskId: 'inspect',
        summary: 'Inspected sealed fixture source',
        noChange: {
          reason: 'This protocol inspection requires no source change',
          evidence: 'Read source.txt in the detached fixture baseline worktree',
        },
      },
    ],
  ] as const)
    await c.service.report(c.principal, state.queued.id, {
      ...state.lease,
      report: { runId: state.run.id, idempotencyKey: key, command },
    });
}
describe(`machine-bound approved graph lifecycle (${url ? 'PostgreSQL' : 'SQLite'})`, () => {
  it('atomically approves the exact graph, reserves its plan, and admits only its own machine', async () => {
    const c = await fixture(),
      queued = await c.queue();
    const picker = await c.app.inject({
      method: 'GET',
      url: `/api/artifacts/${c.artifact.id}/implementation/machines`,
    });
    expect(picker.statusCode, picker.body).toBe(200);
    expect(picker.json()).toMatchObject([
      { id: c.principal.id, commit: c.checkout.sourceCommit, connected: true },
    ]);
    expect((await c.graphs.read(c.user, c.artifact.id)).graph!.status).toBe(
      'approved',
    );
    expect(await c.graphs.editingLock(c.artifact.id)).toMatchObject({
      runId: queued.id,
    });
    await expect(
      c.store.updateArtifact(
        c.user,
        c.artifact.id,
        c.artifact.version,
        c.artifact.content,
      ),
    ).rejects.toThrow('locked');
    await expect(c.queue()).rejects.toThrow('already');
    const other = await c.store.createUser(
      'other-machine@example.test',
      'Other',
      null,
    );
    await c.store.exec(
      'INSERT INTO memberships VALUES(?,?,?)',
      c.project.id,
      other.id,
      'editor',
    );
    await expect(
      c.service.claim({ ...c.principal, user_id: other.id }),
    ).rejects.toThrow('revoked');
  });
  it('requires the sealed checkout, scopes task reports, and accepts whole-graph verification only through a separate credential', async () => {
    const c = await fixture(),
      queued = await c.queue(),
      claimed = await c.service.claim(c.principal),
      work = claimed.work!,
      lease = { leaseToken: claimed.leaseToken!, generation: work.generation };
    await expect(
      c.service.start(c.principal, queued.id, {
        ...lease,
        checkout: {
          expected: work.expected,
          repository: work.repository,
          branch: work.branch,
          commit: 'b'.repeat(40),
        },
      }),
    ).rejects.toThrow('sealed');
    const run = await c.service.start(c.principal, queued.id, {
        ...lease,
        checkout: {
          expected: work.expected,
          repository: work.repository,
          branch: work.branch,
          commit: work.sourceCommit,
        },
      }),
      state = { queued, run, lease };
    await expect(
      c.service.verifier(c.principal, queued.id, lease),
    ).rejects.toThrow('Complete every');
    await completeTask(c, state);
    const verification: ImplementationReport = {
      runId: run.id,
      idempotencyKey: 'independent-review',
      command: {
        kind: 'report_verification',
        verification: {
          summary: 'Independent explicit protocol review',
          tasks: [
            {
              taskId: 'inspect',
              criteria: [
                {
                  index: 0,
                  passed: true,
                  evidence:
                    'Separate verifier inspected the same sealed Git fixture',
                },
              ],
            },
          ],
        },
      },
    };
    await expect(
      c.service.report(c.principal, queued.id, {
        ...lease,
        report: verification,
      }),
    ).rejects.toThrow('separate verifier');
    const { verifierToken } = await c.service.verifier(
      c.principal,
      queued.id,
      lease,
    );
    await expect(
      c.service.report(c.principal, queued.id, {
        ...lease,
        verifierToken,
        report: {
          runId: run.id,
          idempotencyKey: 'wrong-scope',
          command: { kind: 'start_task', taskId: 'inspect' },
        },
      }),
    ).rejects.toThrow('cannot mutate');
    const accepted = await c.service.report(c.principal, queued.id, {
      ...lease,
      verifierToken,
      report: verification,
    });
    expect(accepted.status).toBe('implemented');
    expect(accepted.verification!.reviewedBy.agentId).not.toBe(
      accepted.claimedBy.agentId,
    );
    expect(
      await c.service.report(c.principal, queued.id, {
        ...lease,
        verifierToken,
        report: verification,
      }),
    ).toEqual(accepted);
    expect(await c.graphs.editingLock(c.artifact.id)).toBeNull();
    expect(await c.store.runs(c.artifact.id)).toEqual([]);
  });
  it('rolls approval and queue publication back together when durable metadata cannot commit', async () => {
    const c = await fixture(),
      audit = c.store.audit.bind(c.store);
    c.store.audit = async (...args) => {
      if (args[3] === 'implementation.machine.queued')
        throw new Error('Explicit queue metadata failure');
      return audit(...args);
    };
    await expect(c.queue()).rejects.toThrow('metadata failure');
    expect((await c.graphs.read(c.user, c.artifact.id)).graph!.status).toBe(
      'draft',
    );
    expect(await c.service.editingLock(c.artifact.id)).toBeNull();
    expect(await c.service.list(c.user, c.artifact.id)).toEqual([]);
  });
  it('releases a revoked owner’s graph through trusted fenced interruption and never replays that work', async () => {
    const c = await fixture(),
      state = await started(c);
    await c.store.exec(
      'DELETE FROM memberships WHERE project_id=? AND user_id=?',
      c.project.id,
      c.user.id,
    );
    await c.service.expire();
    expect(await c.graphs.editingLock(c.artifact.id)).toBeNull();
    const row = await c.store.one(
      'SELECT status FROM studio_implementation_machine_queue WHERE id=?',
      state.queued.id,
    );
    expect(row.status).toBe('interrupted');
    const run = JSON.parse(
      (
        await c.store.one(
          'SELECT payload FROM implementation_runs WHERE id=?',
          state.run.id,
        )
      ).payload,
    );
    expect(run.status).toBe('revision_requested');
    await expect(
      c.service.heartbeat(c.principal, state.queued.id, state.lease),
    ).rejects.toThrow();
  });
  it('reports interrupted connector state after a crash without starting an ACP process again', async () => {
    const c = await fixture(),
      state = await started(c),
      directory = join(c.dir, 'connector');
    await privateJson(
      join(directory, 'graph-runs', state.queued.id + '.json'),
      {
        version: 1,
        queueId: state.queued.id,
        generation: state.lease.generation,
        leaseToken: state.lease.leaseToken,
        machineId: c.credentials.id,
        origin: c.credentials.origin,
        phase: 'executing',
        worktree: 'retained inspection path',
      },
    );
    await resumeImplementationRuns(c.credentials, directory);
    expect((await c.service.list(c.user, c.artifact.id))[0]!.status).toBe(
      'interrupted',
    );
    expect(await c.graphs.editingLock(c.artifact.id)).toBeNull();
  });
  it('runs actual ACP/MCP task lifecycle and a fresh independent verifier session in a pinned worktree', async () => {
    const c = await fixture(),
      agent = join(c.dir, 'graph-acp-fixture.mjs');
    await writeFile(agent, acpScript());
    const queued = await c.queue();
    const actual = await runImplementationOnce(c.credentials, {
      command: process.execPath,
      args: [agent],
      cwd: c.cwd,
      stateDirectory: join(c.dir, 'connector'),
      bridgeEntry: resolve('server/machine-worker.ts'),
      signal: AbortSignal.timeout(20000),
      diagnostic: (text) => process.stderr.write(text),
    });
    expect(actual).toMatchObject({
      claimed: true,
      workId: queued.id,
      status: 'implemented',
    });
    const snapshot = await c.graphs.read(c.user, c.artifact.id),
      run = snapshot.runs[0]!;
    expect(run.tasks[0]!.status).toBe('complete');
    expect(run.verification!.passed).toBe(true);
    expect(run.verification!.reviewedBy.agentId).toContain(':verifier:');
    expect(run.claimedBy.agentId).toContain(':implementer:');
    expect(await readFile(join(c.cwd, 'source.txt'), 'utf8')).toBe(
      'operator dirty edit\n',
    );
    expect(await c.store.runs(c.artifact.id)).toEqual([]);
  });
  it('does not retain explicitly rejected reports and replays only ambiguous accepted receipts', async () => {
    const c = await fixture(),
      state = await started(c),
      outbox = join(c.dir, 'report-outbox'),
      bridge = {
        version: 1 as const,
        origin: c.credentials.origin,
        machineId: c.credentials.id,
        token: c.credentials.token,
        queueId: state.queued.id,
        generation: state.lease.generation,
        leaseToken: state.lease.leaseToken,
        runId: state.run.id,
        outboxDirectory: outbox,
      };
    const denied: ImplementationReport = {
      runId: state.run.id,
      idempotencyKey: 'invalid-implementer-verification',
      command: {
        kind: 'report_verification',
        verification: {
          summary: 'Explicit rejected transport fixture',
          tasks: [
            {
              taskId: 'inspect',
              criteria: [
                {
                  index: 0,
                  passed: true,
                  evidence: 'This implementer lacks a verifier credential',
                },
              ],
            },
          ],
        },
      },
    };
    await expect(sendImplementationReport(bridge, denied)).rejects.toThrow(
      'HTTP 403',
    );
    expect(await readdir(outbox)).toEqual([]);
    const report: ImplementationReport = {
      runId: state.run.id,
      idempotencyKey: 'accepted-start',
      command: { kind: 'start_task', taskId: 'inspect' },
    };
    await sendImplementationReport(bridge, report);
    const revision = (await c.graphs.read(c.user, c.artifact.id)).revision;
    await privateJson(join(outbox, crypto.randomUUID() + '.json'), {
      version: 1,
      createdAt: new Date().toISOString(),
      origin: c.credentials.origin,
      machineId: c.credentials.id,
      queueId: state.queued.id,
      body: { ...state.lease, report },
    });
    await resumeImplementationReports(c.credentials, outbox);
    expect((await c.graphs.read(c.user, c.artifact.id)).revision).toBe(
      revision,
    );
    expect(await readdir(outbox)).toEqual([]);
    const huge: ImplementationReport = {
      runId: state.run.id,
      idempotencyKey: 'oversized-review',
      command: {
        kind: 'report_verification',
        verification: {
          summary: 'Explicit bounded-output fixture',
          tasks: Array.from({ length: 15 }, (_, i) => ({
            taskId: 'task-' + i,
            criteria: Array.from({ length: 30 }, (_, index) => ({
              index,
              passed: false,
              evidence: 'x'.repeat(5000),
            })),
          })),
        },
      },
    };
    await expect(sendImplementationReport(bridge, huge)).rejects.toThrow(
      '2 MiB',
    );
    expect(await readdir(outbox)).toEqual([]);
  });
});
function acpScript() {
  return `
import readline from 'node:readline';
import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {Client} from ${JSON.stringify(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href)};
import {StdioClientTransport} from ${JSON.stringify(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href)};
const execute=promisify(execFile);let session='fresh-'+Math.random(),mcp,transport;const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
for await(const line of readline.createInterface({input:process.stdin})){
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1,agentCapabilities:{}}});
 else if(m.method==='session/new'){const server=m.params.mcpServers[0];transport=new StdioClientTransport({command:server.command,args:server.args,stderr:'pipe'});mcp=new Client({name:'explicit-graph-acp-fixture',version:'1.0.0'});await mcp.connect(transport);send({id:m.id,result:{sessionId:session}});}
 else if(m.method==='session/prompt'){
  const data=JSON.parse((await mcp.callTool({name:'read_implementation',arguments:{}})).content[0].text),tools=(await mcp.listTools()).tools.map(t=>t.name),run=data.snapshot.runs.find(r=>r.id===data.runId);
  const source=await readFile('source.txt','utf8'),commit=(await execute('git',['rev-parse','HEAD'])).stdout.trim(),passed=source==='approved baseline\\n'&&commit===run.checkout.commit;
  const call=async(name,args)=>{const r=await mcp.callTool({name,arguments:args});if(r.isError)throw new Error(JSON.stringify(r));};
  if(tools.includes('start_task')){if(!passed)process.exit(5);await call('start_task',{taskId:'inspect',idempotencyKey:'fixture-start'});await call('complete_task',{taskId:'inspect',idempotencyKey:'fixture-complete',summary:'Inspected captured source commit in actual detached worktree',noChange:{reason:'The acceptance criterion verifies the connector baseline and needs no application source change',evidence:'Read source.txt and git rev-parse HEAD: '+commit}});}
  else {if(tools.includes('complete_task'))process.exit(6);await call('report_verification',{idempotencyKey:'fixture-independent-review',verification:{summary:'Fresh ACP session independently read the worktree and executed git rev-parse HEAD',tasks:[{taskId:'inspect',criteria:[{index:0,passed,evidence:'Observed source.txt='+JSON.stringify(source)+'; git HEAD='+commit}]}]}});}
  await mcp.close();await transport.close();send({id:m.id,result:{stopReason:'end_turn'}});
 }else if(m.method==='session/cancel')process.exit(0);
}
`;
}
