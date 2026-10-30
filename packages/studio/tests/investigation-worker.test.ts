import { afterEach, describe, it, expect } from 'vitest';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  writeFile,
  rm,
  symlink,
  stat,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import { Store } from '../server/store.ts';
import { MachineService } from '../server/integrations/machines.ts';
import { registerInvestigationRoutes } from '../server/integrations/investigations.ts';
import { DiskObjectStore } from '../server/hosting/disk-objects.ts';
import {
  runInvestigationOnce,
  resumeInvestigationReports,
  type MachineCredentials,
} from '../server/machine-worker.ts';
import {
  DurableMachineReports,
  inspectCheckout,
  localImage,
  prepareWorktree,
  reconnect,
  MachineTransportError,
} from '../server/machine/runtime.ts';
import {
  investigationResultSchema,
  type InvestigationResult,
} from '../shared/investigations.ts';
const execute = promisify(execFile),
  require = createRequire(import.meta.url),
  cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const result: InvestigationResult = {
  title: 'Connector protocol observations',
  report: 'The explicit protocol fixture returned two synthetic observations.',
  method:
    'A scripted ACP process used actual MCP stdio transport, local worktree files and HTTP uploads.',
  limitations:
    'This exercises the connector contract; it does not measure an actual application or represent a live model account.',
  datasets: [
    {
      id: 'observations',
      title: 'Synthetic observations',
      columns: [
        { id: 'name', label: 'Name', type: 'string' },
        { id: 'value', label: 'Value', type: 'number' },
      ],
      rows: [
        { id: 'a', values: { name: 'First', value: 4 } },
        { id: 'b', values: { name: 'Second', value: 7 } },
      ],
    },
  ],
  views: [
    {
      id: 'bars',
      title: 'Protocol fixture values',
      type: 'bar',
      datasetId: 'observations',
      columns: ['name', 'value'],
      x: 'name',
      y: 'value',
    },
  ],
  evidence: [],
  images: [],
};
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+kH9sAAAAASUVORK5CYII=';
async function checkout() {
  const dir = await mkdtemp(join(tmpdir(), 'studio-connector-git-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  await execute('git', ['init', dir]);
  await execute('git', [
    '-C',
    dir,
    'config',
    'user.email',
    'fixture@example.test',
  ]);
  await execute('git', ['-C', dir, 'config', 'user.name', 'Fixture']);
  await execute('git', [
    '-C',
    dir,
    'remote',
    'add',
    'origin',
    'https://github.com/example/investigation',
  ]);
  await writeFile(join(dir, 'source.txt'), 'approved baseline\n');
  await execute('git', ['-C', dir, 'add', 'source.txt']);
  await execute('git', ['-C', dir, 'commit', '-m', 'Fixture baseline']);
  await writeFile(join(dir, 'source.txt'), 'operator dirty edit preserved\n');
  return { dir, ...(await inspectCheckout(dir)) };
}
async function httpFixture() {
  const git = await checkout(),
    state = await mkdtemp(join(tmpdir(), 'studio-connector-state-'));
  cleanup.push(() => rm(state, { recursive: true, force: true }));
  const store = await Store.open(':memory:');
  cleanup.push(() => store.close());
  const user = await store.createUser(
      'connector@example.test',
      'Connector owner',
      null,
    ),
    project = (await store.createProject(
      user,
      'Connector fixture',
      '',
      git.repository,
    ))!,
    artifact = await store.createArtifact(
      user,
      project.id,
      'design',
      'Protocol design',
    );
  const machines = new MachineService(store, { notify() {} } as any);
  await machines.initialize();
  const paired = await machines.pair(
    (await machines.pairing(user, project.id, 'Actual ACP fixture')).code,
  );
  const app = Fastify({ bodyLimit: 2100000 });
  app.setErrorHandler((error, _, reply) =>
    reply
      .code((error as any).statusCode ?? 500)
      .send({ error: (error as Error).message }),
  );
  const service = await registerInvestigationRoutes(app, {
    store,
    auth: {} as any,
    machines,
    objects: new DiskObjectStore(join(state, 'objects')),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  cleanup.push(() => app.close());
  const credentials: MachineCredentials = {
    ...paired,
    origin: app.listeningOrigin,
  };
  await service.registerCheckout(
    await store.one('SELECT * FROM studio_machines WHERE id=?', paired.id),
    {
      repository: git.repository,
      sourceCommit: git.sourceCommit,
      branch: git.branch,
    },
  );
  return {
    git,
    state,
    store,
    user,
    project,
    artifact,
    machines,
    service,
    app,
    credentials,
  };
}
function acpScript() {
  return `
import readline from 'node:readline';
import {readFile,writeFile} from 'node:fs/promises';
import {Client} from ${JSON.stringify(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href)};
import {StdioClientTransport} from ${JSON.stringify(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href)};
let session='fixture-session',mcp,transport;const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
for await(const line of readline.createInterface({input:process.stdin})){
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1,agentCapabilities:{mcpCapabilities:{http:false}}}});
 else if(m.method==='session/new'){
  if(m.params.mcpServers.length!==1)process.exit(4);
  const server=m.params.mcpServers[0];transport=new StdioClientTransport({command:server.command,args:server.args,stderr:'pipe'});mcp=new Client({name:'explicit-acp-fixture',version:'1.0.0'});await mcp.connect(transport);
  if((await readFile(m.params.cwd+'/source.txt','utf8'))!=='approved baseline\\n')process.exit(5);
  send({id:m.id,result:{sessionId:session}});
 }else if(m.method==='session/prompt'){
  await mcp.callTool({name:'read_investigation',arguments:{}});
  await writeFile('evidence.png',Buffer.from(${JSON.stringify(png)},'base64'));
  const image=JSON.parse((await mcp.callTool({name:'upload_image_file',arguments:{path:'evidence.png'}})).content[0].text);
  const result=${JSON.stringify(result)};result.images=[{fileId:image.fileId,caption:'Explicit single-pixel screenshot fixture'}];
  const submitted=await mcp.callTool({name:'submit_investigation_result',arguments:{result}});if(submitted.isError)process.exit(6);
  await mcp.close();await transport.close();send({id:m.id,result:{stopReason:'end_turn'}});
 }else if(m.method==='session/cancel')process.exit(0);
}
`;
}
describe('exact-checkout ACP investigation connector', () => {
  it('uses an isolated baseline worktree, real MCP screenshot upload, and atomically publishes the staged typed candidate', async () => {
    const c = await httpFixture(),
      agent = join(c.state, 'explicit-acp.mjs');
    await writeFile(agent, acpScript());
    const record = await c.service.propose(c.user, c.artifact.id, {
      version: c.artifact.version,
      brief: 'Exercise the protocol against the sealed baseline',
    });
    await c.service.run(c.user, record.id);
    const outcome = await runInvestigationOnce(c.credentials, {
      command: process.execPath,
      diagnostic: (text) => process.stderr.write(text),
      args: [agent],
      cwd: c.git.dir,
      stateDirectory: c.state,
      bridgeEntry: resolve('server/machine-worker.ts'),
      signal: AbortSignal.timeout(20000),
    });
    expect(outcome).toMatchObject({ claimed: true, status: 'completed' });
    const published = await c.service.get(c.user, record.id);
    expect(published.result?.images).toHaveLength(1);
    expect(published.childArtifactId).toBeTruthy();
    expect(await readFile(join(c.git.dir, 'source.txt'), 'utf8')).toBe(
      'operator dirty edit preserved\n',
    );
    expect((await c.store.all('SELECT * FROM runs')).length).toBe(0);
    expect(
      await c.service.claim(
        await c.store.one(
          'SELECT * FROM studio_machines WHERE id=?',
          c.credentials.id,
        ),
      ),
    ).toEqual({ work: null });
  });
  it('persists outgoing reports privately and resubmits a completed receipt after reconnect without rerunning ACP', async () => {
    const c = await httpFixture(),
      record = await c.service.propose(c.user, c.artifact.id, {
        version: c.artifact.version,
        brief: 'Durable receipt',
      });
    await c.service.run(c.user, record.id);
    const principal = await c.store.one(
        'SELECT * FROM studio_machines WHERE id=?',
        c.credentials.id,
      ),
      claimed = await c.service.claim(principal),
      body = {
        leaseToken: claimed.leaseToken!,
        generation: claimed.work!.generation,
        result: investigationResultSchema.parse(result),
      };
    const first = await c.service.complete(principal, record.id, body);
    const reports = new DurableMachineReports(join(c.state, 'outbox'));
    await reports.save({
      version: 1,
      workId: record.id,
      generation: body.generation,
      route: `/machines/${c.credentials.id}/investigations/${record.id}/complete`,
      body,
      phase: 'report',
      worktree: 'retained inspection path',
    });
    expect((await stat(reports.path(record.id))).mode & 0o077).toBe(0);
    await resumeInvestigationReports(c.credentials, c.state);
    await expect(reports.read(record.id)).rejects.toThrow();
    expect((await c.service.get(c.user, record.id)).childArtifactId).toBe(
      first.childArtifactId,
    );
  });
  it('never repeats uncertain work after a connector process interruption', async () => {
    const c = await httpFixture(),
      record = await c.service.propose(c.user, c.artifact.id, {
        version: c.artifact.version,
        brief: 'Interrupted process',
      });
    await c.service.run(c.user, record.id);
    const claimed = await c.service.claim(
        await c.store.one(
          'SELECT * FROM studio_machines WHERE id=?',
          c.credentials.id,
        ),
      ),
      reports = new DurableMachineReports(join(c.state, 'outbox'));
    await reports.save({
      version: 1,
      workId: record.id,
      generation: claimed.work!.generation,
      route: `/machines/${c.credentials.id}/investigations/${record.id}/complete`,
      body: {
        leaseToken: claimed.leaseToken!,
        generation: claimed.work!.generation,
      },
      phase: 'started',
      worktree: 'retained',
    });
    await resumeInvestigationReports(c.credentials, c.state);
    expect((await c.service.get(c.user, record.id)).status).toBe('failed');
    expect(
      (
        await c.service.claim(
          await c.store.one(
            'SELECT * FROM studio_machines WHERE id=?',
            c.credentials.id,
          ),
        )
      ).work,
    ).toBeNull();
  });
  it('rejects traversal and symlink images and cleans an explicitly consented non-push prototype worktree', async () => {
    const git = await checkout(),
      state = await mkdtemp(join(tmpdir(), 'studio-spike-worktree-'));
    cleanup.push(() => rm(state, { recursive: true, force: true }));
    const tree = await prepareWorktree({
      cwd: git.dir,
      stateDirectory: state,
      workId: crypto.randomUUID(),
      generation: 1,
      repository: git.repository,
      sourceCommit: git.sourceCommit,
      spike: true,
    });
    await writeFile(join(tree.path, 'ok.png'), Buffer.from(png, 'base64'));
    await writeFile(join(state, 'outside.png'), Buffer.from(png, 'base64'));
    await symlink(join(state, 'outside.png'), join(tree.path, 'linked.png'));
    expect((await localImage(tree.path, 'ok.png')).mime).toBe('image/png');
    await expect(localImage(tree.path, '../outside.png')).rejects.toThrow();
    await expect(localImage(tree.path, 'linked.png')).rejects.toThrow(
      'symlinks',
    );
    await expect(
      execute('git', ['push', 'origin', 'HEAD:refs/heads/fixture'], {
        cwd: tree.path,
        timeout: 5000,
      }),
    ).rejects.toThrow();
    await tree.cleanup();
    await expect(stat(tree.path)).rejects.toThrow();
    expect(await readFile(join(git.dir, 'source.txt'), 'utf8')).toContain(
      'dirty',
    );
  });
  it('retries transient failures with bounded reconnect while refusing revoked credentials immediately', async () => {
    let calls = 0;
    await expect(
      reconnect(
        async () => {
          if (++calls < 3) throw new MachineTransportError(502);
          return 'restored';
        },
        { sleep: async () => {} },
      ),
    ).resolves.toBe('restored');
    expect(calls).toBe(3);
    calls = 0;
    await expect(
      reconnect(
        async () => {
          calls++;
          throw new MachineTransportError(401);
        },
        { sleep: async () => {} },
      ),
    ).rejects.toThrow('HTTP 401');
    expect(calls).toBe(1);
  });
  it('fails a server-rejected candidate visibly without retaining a poisoned completion outbox', async () => {
    const c = await httpFixture(),
      agent = join(c.state, 'rejected-candidate-acp.mjs');
    const script = acpScript().replace(
      'fileId:image.fileId',
      "fileId:'00000000-0000-4000-8000-000000000001'",
    );
    expect(script).toContain("fileId:'00000000-0000-4000-8000-000000000001'");
    await writeFile(agent, script);
    const record = await c.service.propose(c.user, c.artifact.id, {
      version: c.artifact.version,
      brief: 'Exercise candidate ownership rejection',
    });
    await c.service.run(c.user, record.id);
    await expect(
      runInvestigationOnce(c.credentials, {
        command: process.execPath,
        args: [agent],
        cwd: c.git.dir,
        stateDirectory: c.state,
        bridgeEntry: resolve('server/machine-worker.ts'),
        signal: AbortSignal.timeout(20000),
      }),
    ).rejects.toThrow('HTTP 400');
    expect((await c.service.get(c.user, record.id)).status).toBe('failed');
    expect(await readdir(join(c.state, 'outbox'))).toEqual([]);
  });
});
