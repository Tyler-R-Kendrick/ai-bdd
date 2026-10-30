import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Auth } from '../server/auth.ts';
import { hash } from '../server/store.ts';
import { MachineService } from '../server/integrations/machines.ts';
import { InvestigationService } from '../server/integrations/investigations.ts';
import { registerAccountMachineRoutes } from '../server/integrations/account-machines.ts';
import { registerAccountPlannerRoutes } from '../server/integrations/account-planners.ts';
import { runAccountPlannerOnce } from '../server/machine/account-planner.ts';
import { runRemotePlanner } from '../server/machine/planner-client.ts';
import { inspectCheckout } from '../server/machine/runtime.ts';
import { remoteFixture, until } from './remote-fixture.ts';
const execute = promisify(execFile);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
describe('Real account assignment, scoped Planner and ACP publication', () => {
  it('publishes an actual scoped remote turn from the sealed checkout and fences its device token on explicit stop', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'studio-planner-domain-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    await execute('git', ['init', directory]);
    await writeFile(
      join(directory, 'source.txt'),
      'Sealed repository source\n',
    );
    await execute('git', ['-C', directory, 'add', 'source.txt']);
    await execute('git', [
      '-C',
      directory,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'Sealed fixture',
    ]);
    await execute('git', [
      '-C',
      directory,
      'remote',
      'add',
      'origin',
      'https://github.com/example/account-planner',
    ]);
    const checkout = await inspectCheckout(directory);
    await writeFile(join(directory, 'source.txt'), 'Operator dirty edit\n');
    let context!: {
      service: Awaited<ReturnType<typeof registerAccountPlannerRoutes>>;
      accounts: Awaited<ReturnType<typeof registerAccountMachineRoutes>>;
      credential: any;
      principal: any;
      browserToken: string;
      machines: MachineService;
      child: any;
      ordinary: any;
    };
    const w = await remoteFixture({
      configure: async ({
        app,
        store,
        agent,
        remote,
        user,
        project,
        artifact,
        settings,
      }) => {
        await store.exec(
          'UPDATE projects SET repository=? WHERE id=?',
          checkout.repository,
          project.id,
        );
        const repositoryRead = async (
          actor: { id: string },
          repository: string,
          input: { kind: string },
        ) => {
          expect(actor.id).toBe(user.id);
          expect(repository).toBe(checkout.repository);
          if (input.kind === 'commits') return [{ sha: checkout.sourceCommit }];
          throw new Error(
            'This local fixture permits only its measured Git revision read',
          );
        };
        agent.options.repositoryRead = repositoryRead;
        remote.options.repositoryRead = repositoryRead;
        const auth = new Auth(store, settings);
        await auth.initialize();
        const machines = new MachineService(store, { notify() {} } as any);
        await machines.initialize();
        const investigations = new InvestigationService({
          store,
          auth,
          machines,
          objects: {} as any,
        });
        await investigations.ready;
        const accounts = await registerAccountMachineRoutes(app, {
          store,
          auth,
        });
        const credential = await accounts.pair(
          (await accounts.pairing(user, 'Actual local fixture')).code,
        );
        const principal = await accounts.authenticate(
          { headers: { authorization: 'Bearer ' + credential.token } } as any,
          credential.id,
        );
        const registered = await accounts.assignments(principal, [
          {
            checkoutKey: 'sealed',
            repository: checkout.repository,
            sourceCommit: checkout.sourceCommit,
            branch: checkout.branch,
          },
        ]);
        machines.hooks.authorizeMachine = (machine) =>
          accounts.assertCurrentMachine(machine);
        machines.hooks.otherWorkActive = (id) => accounts.otherWorkActive(id);
        const child = await store.one(
          'SELECT * FROM studio_machines WHERE id=?',
          registered.assignments[0]!.credential.id,
        );
        await machines.queue(user, artifact.id, {
          version: artifact.version,
          kind: 'investigation',
          brief: 'Explicit synthetic ordinary job occupies this fixture device',
        });
        const ordinary = await machines.claim(child);
        expect(ordinary.work).not.toBeNull();
        const service = await registerAccountPlannerRoutes(app, {
          store,
          auth,
          accounts,
          profiles: agent.profiles,
          enabled: true,
          hasLiveActivity: (artifactId, userId, scope) =>
            remote.activity.hasLiveActivity(artifactId, userId, scope),
        });
        remote.options.authenticateScoped = (request) =>
          service.authenticatePlanner(request);
        remote.options.assertScoped = (scope) => service.assertPlanner(scope);
        const browserToken = randomBytes(32).toString('base64url');
        await store.exec(
          "INSERT INTO sessions(token,user_id,expires,kind) VALUES(?,?,?,'api')",
          hash(browserToken),
          user.id,
          Date.now() + 600000,
        );
        context = {
          service,
          accounts,
          credential,
          principal,
          browserToken,
          machines,
          child,
          ordinary,
        };
      },
    });
    const assigned = await fetch(
      w.origin + `/api/artifacts/${w.artifact.id}/planners`,
      {
        method: 'POST',
        headers: {
          Origin: w.origin,
          Authorization: 'Bearer ' + context.browserToken,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          deviceId: context.credential.id,
          artifactVersion: w.artifact.version,
        }),
      },
    );
    expect(assigned.status, await assigned.clone().text()).toBe(200);
    const assignment = (await assigned.json()) as any;
    expect(assignment).toMatchObject({ status: 'queued', idleExpiresAt: null });
    const agent = join(directory, 'operator-agent.cjs');
    await writeFile(
      agent,
      `const fs=require('node:fs'),rl=require('node:readline');const send=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');rl.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1}});else if(m.method==='session/new'){if(fs.readFileSync(m.params.cwd+'/source.txt','utf8')!=='Sealed repository source\\n')process.exit(2);send({id:m.id,result:{sessionId:'sealed'}});}else if(m.method==='session/prompt'){send({method:'session/update',params:{sessionId:'sealed',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify({summary:'Actual account-scoped ACP publication'})}}}});send({id:m.id,result:{stopReason:'end_turn'}});}});`,
    );
    const controller = new AbortController();
    const credentials = { ...context.credential, origin: w.origin };
    const registry = [
      {
        key: 'sealed',
        path: directory,
        registration: {
          checkoutKey: 'sealed',
          repository: checkout.repository,
          sourceCommit: checkout.sourceCommit,
          branch: checkout.branch,
        },
      },
    ];
    const options = {
      command: process.execPath,
      args: [agent],
      stateDirectory: join(directory, 'private-state'),
      signal: controller.signal,
      renewMs: 100,
      run: runRemotePlanner,
    };
    expect(await runAccountPlannerOnce(credentials, registry, options)).toEqual(
      { claimed: false },
    );
    await context.machines.fail(
      context.child,
      context.ordinary.work.id,
      context.ordinary.leaseToken,
    );
    const running = runAccountPlannerOnce(credentials, registry, options);
    try {
      await until(
        async () =>
          !!(await w.store.one(
            'SELECT artifact_id FROM studio_remote_planners WHERE artifact_id=? AND expires>?',
            w.artifact.id,
            Date.now(),
          )),
      );
      const turn = await w.start();
      await turn.done;
      const job = await w.runtime.get(turn.job.id);
      const requests = await w.store.all(
        'SELECT status,output_json FROM studio_remote_requests WHERE artifact_id=?',
        w.artifact.id,
      );
      expect(job?.status, JSON.stringify({ error: job?.error, requests })).toBe(
        'completed',
      );
      expect(
        (await w.store.messages(w.artifact.id)).some(
          (message) =>
            message.role === 'assistant' &&
            message.body.includes('Actual account-scoped ACP publication'),
        ),
      ).toBe(true);
      const activity = await w.store.one(
        'SELECT a.assignment_id,a.assignment_epoch FROM studio_remote_activity a JOIN studio_remote_requests r ON r.id=a.request_id WHERE r.artifact_id=?',
        w.artifact.id,
      );
      expect(activity).toMatchObject({
        assignment_id: assignment.id,
        assignment_epoch: assignment.epoch,
      });
      expect(await readFile(join(directory, 'source.txt'), 'utf8')).toBe(
        'Operator dirty edit\n',
      );
      await context.service.stop(
        w.user,
        w.artifact.id,
        assignment.id,
        assignment.epoch,
      );
      const result = await running;
      expect(result).toMatchObject({
        claimed: true,
        workId: assignment.id,
        status: 'failed',
      });
      expect(
        (await context.service.exportState(w.artifact.id))[0]!.status,
      ).toBe('stopped');
    } finally {
      controller.abort();
      await running.catch(() => {});
    }
  }, 30000);
});
