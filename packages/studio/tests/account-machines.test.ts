import { afterEach, beforeAll, describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import { Store, HttpError } from '../server/store.ts';
import { openDatabase } from '../server/persistence/index.ts';
import { MachineService } from '../server/integrations/machines.ts';
import { registerInvestigationRoutes } from '../server/integrations/investigations.ts';
import { registerAccountMachineRoutes } from '../server/integrations/account-machines.ts';
import { ImplementationGraphs } from '../server/integrations/implementation.ts';
import { registerImplementationMachineRoutes } from '../server/integrations/implementation-machines.ts';
import { registerConnectorDownload } from '../server/connector-download.ts';
import { DiskObjectStore } from '../server/hosting/disk-objects.ts';
import {
  connectAccountMachine,
  accountAssignments,
  explicitCheckoutRegistry,
} from '../server/machine/account-worker.ts';
import { inspectCheckout } from '../server/machine/runtime.ts';
import { implementationPointer } from '../shared/implementation.ts';
const execute = promisify(execFile),
  require = createRequire(import.meta.url),
  cleanup: (() => Promise<unknown>)[] = [],
  url =
    process.env.STUDIO_ACCOUNT_MACHINE_TEST_POSTGRES_URL ??
    process.env.STUDIO_TEST_POSTGRES_URL;
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
beforeAll(async () => {
  await execute(process.execPath, ['scripts/build-connector.mjs'], {
    cwd: process.cwd(),
    timeout: 30000,
    maxBuffer: 10000,
  });
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'studio-account-machines-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const store = await Store.open(
    url
      ? await openDatabase({
          adapter: 'postgres',
          url,
          schema: 'account_machine_' + crypto.randomUUID().replaceAll('-', ''),
        })
      : ':memory:',
  );
  cleanup.push(() => store.close());
  const user = await store.createUser(
      'account-owner@example.test',
      'Device owner',
      null,
    ),
    other = await store.createUser(
      'other-account@example.test',
      'Other account',
      null,
    ),
    projects = [],
    checkouts = [];
  for (const suffix of ['a', 'b']) {
    const cwd = join(dir, 'repo-' + suffix);
    await execute('git', ['init', cwd]);
    for (const [key, value] of [
      ['user.name', 'Fixture'],
      ['user.email', 'fixture@example.test'],
      ['remote.origin.url', 'https://github.com/example/device-' + suffix],
    ])
      await execute('git', ['-C', cwd, 'config', key!, value!]);
    await writeFile(
      join(cwd, 'source.txt'),
      'approved baseline ' + suffix + '\n',
    );
    await execute('git', ['-C', cwd, 'add', 'source.txt']);
    await execute('git', ['-C', cwd, 'commit', '-m', 'Fixture baseline']);
    const checkout = await inspectCheckout(cwd);
    checkouts.push({ key: suffix, path: cwd, ...checkout });
    projects.push(
      (await store.createProject(
        user,
        'Project ' + suffix,
        '',
        checkout.repository,
      ))!,
    );
    await writeFile(
      join(cwd, 'source.txt'),
      'operator dirty edit ' + suffix + '\n',
    );
  }
  const app = Fastify({ bodyLimit: 2100000 });
  app.setErrorHandler((error, _, reply) =>
    reply
      .code((error as any).statusCode ?? 500)
      .send({ error: (error as Error).message }),
  );
  const auth = { user: async () => user, assertOrigin: () => {} } as any;
  const machines = new MachineService(store, { notify() {} } as any);
  await machines.initialize();
  const graphs = new ImplementationGraphs({ store });
  await graphs.initialize();
  const investigations = await registerInvestigationRoutes(app, {
    store,
    auth,
    machines,
    objects: new DiskObjectStore(join(dir, 'objects')),
  });
  const implementation = await registerImplementationMachineRoutes(app, {
    store,
    auth,
    machines,
    graphs,
  });
  graphs.options.externalEditingLock = (id) => implementation.editingLock(id);
  const accounts = await registerAccountMachineRoutes(app, {
    store,
    auth,
    graphs,
  });
  machines.hooks.authorizeMachine = (machine) =>
    accounts.assertCurrentMachine(machine);
  machines.hooks.otherWorkActive = async (id) =>
    (await accounts.otherWorkActive(id)) ||
    (await investigations.activeOnMachine(id)) ||
    (await implementation.activeOnMachine(id));
  investigations.dependencies.authorizeMachine = (machine) =>
    accounts.assertCurrentMachine(machine);
  investigations.dependencies.otherWorkActive = async (id) =>
    (await accounts.otherWorkActive(id)) ||
    (await implementation.activeOnMachine(id));
  implementation.dependencies.authorizeMachine = (machine) =>
    accounts.assertCurrentMachine(machine);
  implementation.dependencies.otherWorkActive = async (id) =>
    (await accounts.otherWorkActive(id)) ||
    (await investigations.activeOnMachine(id));
  app.post<{ Params: { id: string } }>(
    '/api/machines/:id/claim',
    async (request) =>
      machines.claim(await machines.authenticate(request, request.params.id)),
  );
  registerConnectorDownload(app, { file: resolve('dist/connector.mjs') });
  await app.listen({ host: '127.0.0.1', port: 0 });
  cleanup.push(() => app.close());
  const code = await accounts.pairing(user, 'One account device'),
    credentialFile = join(dir, 'device.json'),
    credentials = await connectAccountMachine(
      app.listeningOrigin,
      code.code,
      credentialFile,
    ),
    principal = await accounts.authenticate(
      { headers: { authorization: 'Bearer ' + credentials.token } } as any,
      credentials.id,
    ),
    env = {
      STUDIO_MACHINE_CHECKOUTS: JSON.stringify(
        checkouts.map(({ key, path }) => ({ key, path })),
      ),
    };
  const assignments = () => accountAssignments(credentials, env, []);
  return {
    dir,
    store,
    user,
    other,
    projects,
    checkouts,
    app,
    graphs,
    machines,
    investigations,
    implementation,
    accounts,
    credentials,
    principal,
    credentialFile,
    env,
    assignments,
  };
}
describe(`account-wide machine delegation (${url ? 'PostgreSQL' : 'SQLite'})`, () => {
  it('discovers only currently authorized attached repositories and fences revoked or unavailable authority before cloning', async () => {
    const c = await fixture();
    const viewerProject = (await c.store.createProject(
      c.user,
      'View only',
      '',
      'https://github.com/example/view-only',
    ))!;
    await c.store.exec(
      "UPDATE memberships SET role='viewer' WHERE project_id=? AND user_id=?",
      viewerProject.id,
      c.user.id,
    );
    await c.store.createProject(
      c.other,
      'Another owner',
      '',
      'https://github.com/example/other-private',
    );
    const get = () =>
      c.app.inject({
        method: 'GET',
        url: `/api/account-machines/${c.credentials.id}/repositories`,
        headers: { authorization: 'Bearer ' + c.credentials.token },
      });
    expect((await get()).json()).toEqual({
      repositories: c.checkouts.map((checkout) => checkout.repository).sort(),
    });
    c.store.repositoryAuthorizer = async (id) => {
      if (id === c.projects[1]!.id) throw new HttpError(403, 'Fixture denied');
    };
    expect((await get()).json()).toEqual({
      repositories: [c.checkouts[0]!.repository],
    });
    c.store.repositoryAuthorizer = async () => {
      throw new HttpError(503, 'Fixture unavailable');
    };
    expect((await get()).statusCode).toBe(503);
    c.store.repositoryAuthorizer = undefined;
    const assignments = await c.assignments();
    const removed = assignments.assignments[0]!;
    await c.machines.revoke(c.user, removed.projectId, removed.credentials.id);
    expect((await get()).json()).toEqual({
      repositories: c.checkouts
        .map((checkout) => checkout.repository)
        .filter((repo) => repo !== removed.repository),
    });
    await c.accounts.revoke(c.user, c.credentials.id);
    expect((await get()).statusCode).toBe(401);
  });
  it('clones attached authorized repositories privately without changing dirty operator checkouts and reuses their exact origins', async () => {
    const c = await fixture();
    const config = join(c.dir, 'clone-git-config');
    for (const checkout of c.checkouts)
      await execute('git', [
        'config',
        '--file',
        config,
        'url.file://' + checkout.path + '.insteadOf',
        checkout.repository + '.git',
      ]);
    const env = {
      ...process.env,
      STUDIO_MACHINE_CLONE_ATTACHED: 'true',
      STUDIO_MACHINE_MANAGED_ROOT: join(c.dir, 'managed'),
      GIT_CONFIG_GLOBAL: config,
    };
    const result = await accountAssignments(c.credentials, env, []);
    expect(result.assignments).toHaveLength(2);
    for (const assignment of result.assignments) {
      const original = c.checkouts.find(
        (checkout) => checkout.repository === assignment.repository,
      )!;
      expect(assignment.cwd).toContain(join(c.dir, 'managed', 'clone-'));
      expect(assignment.cwd).not.toBe(original.path);
      expect((await inspectCheckout(assignment.cwd)).sourceCommit).toBe(
        original.sourceCommit,
      );
      expect(
        await readFile(join(original.path, 'source.txt'), 'utf8'),
      ).toContain('operator dirty edit');
    }
    expect(
      (await accountAssignments(c.credentials, env, [])).assignments.map(
        (entry) => entry.cwd,
      ),
    ).toEqual(result.assignments.map((entry) => entry.cwd));
    expect((await stat(env.STUDIO_MACHINE_MANAGED_ROOT)).mode & 0o077).toBe(0);
    const first = result.assignments[0]!;
    await execute('git', [
      '-C',
      first.cwd,
      'remote',
      'set-url',
      'origin',
      'https://github.com/example/wrong-origin',
    ]);
    await expect(accountAssignments(c.credentials, env, [])).rejects.toThrow(
      'origin changed',
    );
  });
  it('rechecks account revocation after an awaited repository authorization', async () => {
    const c = await fixture();
    let revoked = false;
    c.store.repositoryAuthorizer = async (
      _project,
      _user,
      _action,
      inTransaction,
    ) => {
      if (!revoked && !inTransaction) {
        revoked = true;
        await c.accounts.revoke(c.user, c.credentials.id);
      }
    };
    await expect(c.accounts.repositories(c.principal)).rejects.toMatchObject({
      statusCode: 401,
    });
  });
  it('registers multiple explicit repositories and derives independent project-scoped credentials without exposing the account token', async () => {
    const c = await fixture(),
      result = await c.assignments();
    expect(result.assignments).toHaveLength(2);
    expect(result.blocked).toEqual([]);
    expect(new Set(result.assignments.map((a) => a.credentials.id)).size).toBe(
      2,
    );
    for (const assignment of result.assignments) {
      expect(assignment.credentials.token).not.toBe(c.credentials.token);
      const principal = await c.machines.authenticate(
        {
          headers: { authorization: 'Bearer ' + assignment.credentials.token },
        } as any,
        assignment.credentials.id,
      );
      expect(principal.project_id).toBe(assignment.projectId);
      await expect(
        c.machines.authenticate(
          {
            headers: { authorization: 'Bearer ' + c.credentials.token },
          } as any,
          assignment.credentials.id,
        ),
      ).rejects.toThrow();
      expect(assignment.cwd).toBe(
        c.checkouts.find((checkout) => checkout.key === assignment.checkoutKey)!
          .path,
      );
    }
    expect((await stat(c.credentialFile)).mode & 0o077).toBe(0);
  });
  it('fails closed for viewer membership and unknown upstream authorization instead of assigning an unchecked checkout', async () => {
    const c = await fixture();
    await c.store.exec(
      "UPDATE memberships SET role='viewer' WHERE project_id=? AND user_id=?",
      c.projects[1]!.id,
      c.user.id,
    );
    const result = await c.assignments();
    expect(result.assignments.map((a) => a.projectId)).toEqual([
      c.projects[0]!.id,
    ]);
    expect(result.blocked).toContainEqual({
      projectId: c.projects[1]!.id,
      code: 'permission-denied',
    });
    c.store.repositoryAuthorizer = async () => {
      throw Object.assign(new Error('Explicit upstream unavailable fixture'), {
        statusCode: 503,
      });
    };
    const unavailable = await c.assignments();
    expect(unavailable.assignments).toEqual([]);
    expect(
      unavailable.blocked.some(
        (item) => item.code === 'authorization-unavailable',
      ),
    ).toBe(true);
  });
  it('preserves project-admin revocation as a tombstone and never recreates that assignment during reconnect', async () => {
    const c = await fixture(),
      result = await c.assignments(),
      assignment = result.assignments[0]!;
    await c.machines.revoke(
      c.user,
      assignment.projectId,
      assignment.credentials.id,
    );
    const retried = await c.assignments();
    expect(
      retried.assignments.some((a) => a.projectId === assignment.projectId),
    ).toBe(false);
    expect(retried.blocked).toContainEqual({
      projectId: assignment.projectId,
      code: 'project-device-revoked',
    });
    await expect(
      c.machines.authenticate(
        {
          headers: { authorization: 'Bearer ' + assignment.credentials.token },
        } as any,
        assignment.credentials.id,
      ),
    ).rejects.toThrow();
    await expect(c.accounts.revoke(c.other, c.credentials.id)).rejects.toThrow(
      'Your active',
    );
  });
  it('serializes claims across project shadows of the same physical account device and fences them all on revoke', async () => {
    const c = await fixture(),
      result = await c.assignments(),
      records = [];
    for (const assignment of result.assignments) {
      const project = c.projects.find(
          (project) => project.id === assignment.projectId,
        )!,
        artifact = await c.store.createArtifact(
          c.user,
          project.id,
          'design',
          'Account investigation',
        );
      const record = await c.investigations.propose(c.user, artifact.id, {
        version: artifact.version,
        brief: 'Observe the sealed checkout',
      });
      await c.investigations.run(c.user, record.id);
      records.push({
        record,
        assignment,
        principal: await c.store.one(
          'SELECT * FROM studio_machines WHERE id=?',
          assignment.credentials.id,
        ),
      });
    }
    const claims = await Promise.all(
      records.map((item) => c.investigations.claim(item.principal)),
    );
    expect(claims.filter((claim) => claim.work)).toHaveLength(1);
    const index = claims.findIndex((claim) => claim.work),
      active = claims[index]!;
    await c.accounts.revoke(c.user, c.credentials.id);
    await expect(
      c.investigations.heartbeat(
        records[index]!.principal,
        active.work!.id,
        active.leaseToken!,
        active.work!.generation,
      ),
    ).rejects.toThrow();
    expect(
      (await c.investigations.get(c.user, records[index]!.record.id)).status,
    ).toBe('interrupted');
    expect(
      await c.store.all(
        'SELECT * FROM studio_machines WHERE id IN (?,?)',
        ...result.assignments.map((a) => a.credentials.id),
      ),
    ).toEqual([]);
  });
  it('refuses duplicate repository mappings and never substitutes a server-selected unknown local checkout', async () => {
    const c = await fixture();
    await expect(
      explicitCheckoutRegistry(
        {
          STUDIO_MACHINE_CHECKOUTS: JSON.stringify([
            { key: 'a', path: c.checkouts[0]!.path },
            { key: 'b', path: c.checkouts[0]!.path },
          ]),
        },
        [],
      ),
    ).rejects.toThrow('ambiguous');
    await expect(
      c.accounts.assignments(c.principal, [
        {
          checkoutKey: 'same',
          repository: c.checkouts[0]!.repository,
          sourceCommit: c.checkouts[0]!.sourceCommit,
          branch: 'main',
        },
        {
          checkoutKey: 'same',
          repository: c.checkouts[1]!.repository,
          sourceCommit: c.checkouts[1]!.sourceCommit,
          branch: 'main',
        },
      ]),
    ).rejects.toThrow('unique');
  });
  it('downloads and runs one standalone connector against two explicit checkouts with real ACP/MCP reports and no installed runtime dependencies', async () => {
    const c = await fixture(),
      assigned = await c.assignments(),
      records = [];
    for (const assignment of assigned.assignments) {
      const project = c.projects.find(
          (project) => project.id === assignment.projectId,
        )!,
        artifact = await c.store.createArtifact(
          c.user,
          project.id,
          'design',
          'Portable connector observation',
        ),
        record = await c.investigations.propose(c.user, artifact.id, {
          version: artifact.version,
          brief: 'Read source.txt and Git HEAD from the approved checkout',
        });
      await c.investigations.run(c.user, record.id);
      records.push(record);
    }
    const response = await fetch(c.app.listeningOrigin + '/connector.js');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain(
      'studio-connector.mjs',
    );
    const bundle = join(c.dir, 'downloaded-connector.mjs');
    await writeFile(bundle, await response.text());
    const agent = join(c.dir, 'explicit-account-acp.mjs');
    await writeFile(agent, acpScript());
    const taskEnv = {
      PATH: process.env.PATH,
      STUDIO_API_URL: c.app.listeningOrigin,
      STUDIO_MACHINE_SCOPE: 'account',
      STUDIO_MACHINE_CREDENTIALS: c.credentialFile,
      STUDIO_MACHINE_STATE_DIR: join(c.dir, 'state'),
      STUDIO_MACHINE_AGENT_COMMAND: process.execPath,
      STUDIO_MACHINE_AGENT_ARGS: JSON.stringify([agent]),
    };
    for (let i = 0; i < 2; i++) {
      const outcome = await execute(
        process.execPath,
        [
          bundle,
          '--once',
          '--checkout',
          c.checkouts[0]!.path,
          '--checkout',
          c.checkouts[1]!.path,
        ],
        { env: taskEnv, timeout: 30000, maxBuffer: 100000 },
      );
      expect(outcome.stdout).toContain('"claimed":true');
      expect(outcome.stdout).not.toContain(c.credentials.token);
    }
    for (const record of records)
      expect((await c.investigations.get(c.user, record.id)).status).toBe(
        'completed',
      );
    for (const checkout of c.checkouts)
      expect(
        await readFile(join(checkout.path, 'source.txt'), 'utf8'),
      ).toContain('operator dirty edit');
    expect(await c.store.all('SELECT * FROM runs')).toEqual([]);
  });
  it('fences authority before cleanup and recovers a process-interrupted global revocation durably', async () => {
    const c = await fixture(),
      assigned = await c.assignments(),
      original = (c.accounts as any).interruptChildren.bind(c.accounts);
    (c.accounts as any).interruptChildren = async () => {
      throw new Error('Explicit interrupted cleanup fixture');
    };
    await expect(c.accounts.revoke(c.user, c.credentials.id)).rejects.toThrow(
      'interrupted cleanup',
    );
    expect((await c.accounts.list(c.user))[0]!.status).toBe('revoking');
    await expect(
      c.accounts.authenticate(
        { headers: { authorization: 'Bearer ' + c.credentials.token } } as any,
        c.credentials.id,
      ),
    ).rejects.toThrow('revoked');
    for (const assignment of assigned.assignments)
      await expect(
        c.machines.authenticate(
          {
            headers: {
              authorization: 'Bearer ' + assignment.credentials.token,
            },
          } as any,
          assignment.credentials.id,
        ),
      ).rejects.toThrow();
    (c.accounts as any).interruptChildren = original;
    await expect(c.accounts.cleanupRevoked()).resolves.toEqual({
      recovered: 1,
    });
    expect((await c.accounts.list(c.user))[0]!.status).toBe('revoked');
  });
  it('releases an active graph through trusted global device revocation without inventing a human review', async () => {
    const c = await fixture(),
      assignment = (await c.assignments()).assignments[0]!,
      project = c.projects.find((p) => p.id === assignment.projectId)!,
      artifact = await c.store.artifact(project.mainArtifactId, c.user.id);
    const draft = await c.graphs.edit(
      { user: c.user, kind: 'human' },
      artifact.id,
      {
        expected: null,
        planRevision: artifact.version,
        definition: {
          tasks: [
            {
              id: 'inspect',
              title: 'Inspect baseline',
              description: 'Inspect the selected source',
              acceptanceCriteria: ['Inspect exact commit'],
            },
          ],
          edges: [],
        },
      },
    );
    const queue = await c.implementation.queue(c.user, artifact.id, {
        expected: implementationPointer(draft),
        machineId: assignment.credentials.id,
      }),
      principal = await c.store.one(
        'SELECT * FROM studio_machines WHERE id=?',
        assignment.credentials.id,
      ),
      claimed = await c.implementation.claim(principal),
      work = claimed.work!;
    const run = await c.implementation.start(principal, queue.id, {
      leaseToken: claimed.leaseToken!,
      generation: work.generation,
      checkout: {
        expected: work.expected,
        repository: work.repository,
        branch: work.branch,
        commit: work.sourceCommit,
      },
    });
    await c.accounts.revoke(c.user, c.credentials.id);
    expect(await c.graphs.editingLock(artifact.id)).toBeNull();
    expect(
      (await c.graphs.read(c.user, artifact.id)).runs.find(
        (r) => r.id === run.id,
      )!.status,
    ).toBe('revision_requested');
    expect((await c.implementation.list(c.user, artifact.id))[0]!.status).toBe(
      'interrupted',
    );
  });
});
function acpScript() {
  return `
import readline from 'node:readline';import {readFile} from 'node:fs/promises';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {Client} from ${JSON.stringify(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href)};
import {StdioClientTransport} from ${JSON.stringify(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href)};
const execute=promisify(execFile);let session='account-fixture',mcp,transport;const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1,agentCapabilities:{}}});else if(m.method==='session/new'){const server=m.params.mcpServers[0];transport=new StdioClientTransport({command:server.command,args:server.args,stderr:'pipe'});mcp=new Client({name:'explicit-portable-protocol-fixture',version:'1.0.0'});await mcp.connect(transport);send({id:m.id,result:{sessionId:session}});}else if(m.method==='session/prompt'){const brief=JSON.parse((await mcp.callTool({name:'read_investigation',arguments:{}})).content[0].text),source=await readFile('source.txt','utf8'),commit=(await execute('git',['rev-parse','HEAD'])).stdout.trim();if(!source.startsWith('approved baseline')||commit!==brief.sealed.sealed.sourceCommit)process.exit(5);const result={title:'Portable connector observation',report:'Observed the sealed checkout through a scripted ACP/MCP transport.',method:'Read source.txt and independently executed git rev-parse HEAD in the isolated worktree.',limitations:'This is a connector protocol fixture, not a live model or application performance test.',datasets:[{id:'observation',title:'Measured source length',columns:[{id:'value',label:'Characters',type:'number'}],rows:[{id:'source',values:{value:source.length}}]}],views:[{id:'source',title:'Source observation',datasetId:'observation',type:'metric',columns:['value'],y:'value'}],evidence:[{name:'Git HEAD',text:commit}],images:[]};const r=await mcp.callTool({name:'submit_investigation_result',arguments:{result}});if(r.isError)throw new Error(JSON.stringify(r));await mcp.close();await transport.close();send({id:m.id,result:{stopReason:'end_turn'}});}else if(m.method==='session/cancel')process.exit(0);}
`;
}
