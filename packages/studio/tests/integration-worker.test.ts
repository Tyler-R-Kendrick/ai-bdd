import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { Store } from '../server/store.ts';
import { Auth, type Settings } from '../server/auth.ts';
import { Collaboration } from '../server/collaboration.ts';
import { Agent } from '../server/agent.ts';
import { DurableJobCoordinator } from '../server/runtime/jobs.ts';
import { registerIntegrationRoutes } from '../server/integrations/routes.ts';
import {
  AcpClient,
  connectMachine,
  readMachineCredentials,
  runMachineOnce,
} from '../server/machine-worker.ts';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const agentScript = `
import readline from 'node:readline';
let promptId; let sessionId='fixture-session';
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
for await(const line of readline.createInterface({input:process.stdin})) {
 const m=JSON.parse(line);
 if(m.method==='initialize') {
   if(m.params.protocolVersion!==1||m.params.clientCapabilities.terminal!==false)process.exit(2);
   send({id:m.id,result:{protocolVersion:1,agentCapabilities:{}}});
 } else if(m.method==='session/new')send({id:m.id,result:{sessionId}});
 else if(m.method==='session/prompt') {
   promptId=m.id;
   send({id:'permission',method:'session/request_permission',params:{sessionId,toolCall:{toolCallId:'fixture-tool',kind:'execute'},options:[{kind:'allow_once',optionId:'once',name:'Run once'}]}});
 } else if(m.id==='permission') {
   if(m.result.outcome.outcome!=='cancelled')process.exit(3);
   const text=JSON.stringify({summary:'Fixture ACP result after denied execution permission',content:{files:{'index.html':'<h1>Reviewed ACP output</h1>'},entry:'index.html'}});
   send({method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}});
   send({id:promptId,result:{stopReason:'end_turn'}});
 } else if(m.method==='session/cancel')process.exit(0);
}
`;
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'studio-machine-integration-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const agentFile = join(dir, 'explicit-acp-protocol-fixture.mjs');
  await writeFile(agentFile, agentScript);
  const store = await Store.open(':memory:');
  const settings: Settings = {
    production: false,
    origin: 'http://127.0.0.1:8787',
    dataDir: dir,
    demo: false,
  };
  const auth = new Auth(store, settings);
  await auth.initialize();
  const collab = new Collaboration(store, auth);
  await collab.initialize();
  const runtime = new DurableJobCoordinator({
    store,
    dispatcher: {
      provider: 'explicit-worker-test',
      publish: async () => ({ provider: 'explicit-worker-test' }),
    },
  });
  await runtime.ready;
  const agent = new Agent(store, settings, collab, { runtime });
  await agent.initialize();
  const app = Fastify();
  await app.register(cookie);
  app.addHook('onRequest', async (request) => {
    if (request.method === 'POST') await auth.assertOrigin(request);
  });
  app.setErrorHandler((error, _request, reply) =>
    reply
      .code((error as any).statusCode ?? 500)
      .send({ error: (error as Error).message }),
  );
  const services = await registerIntegrationRoutes(app, {
    auth,
    store,
    collab,
    agent,
    settings,
  });
  const user = await store.createUser(
      'owner@worker.test',
      'Machine owner',
      null,
    ),
    project = (await store.createProject(
      user,
      'Machine worker fixture',
      '',
      '',
    ))!;
  const artifact = await store.createArtifact(
    user,
    project.id,
    'code',
    'ACP target',
  );
  await app.listen({ port: 0, host: '127.0.0.1' });
  settings.origin = app.listeningOrigin;
  cleanup.push(async () => {
    await app.close();
    await agent.close();
    await runtime.close();
    await collab.close();
    await store.close();
  });
  return {
    dir,
    agentFile,
    store,
    settings,
    user,
    project,
    artifact,
    services,
    app,
  };
}

describe('local-machine HTTP and actual ACP child process', () => {
  it('pairs via HTTP, stores private credentials, runs ACP, and keeps the result reviewable', async () => {
    const w = await fixture(),
      code = (
        await w.services.machines.pairing(
          w.user,
          w.project.id,
          'Protocol fixture machine',
        )
      ).code;
    const file = join(w.dir, 'private-machine.json');
    const credentials = await connectMachine(w.settings.origin, code, file);
    expect((await stat(file)).mode & 0o077).toBe(0);
    expect(await readMachineCredentials(file)).toEqual(credentials);
    const work = await w.services.machines.queue(w.user, w.artifact.id, {
      version: 1,
      kind: 'implementation',
      brief: 'Return a complete code artifact proposal.',
    });
    const result = await runMachineOnce(credentials, {
      command: process.execPath,
      args: [w.agentFile],
      cwd: w.dir,
    });
    expect(result).toEqual({
      claimed: true,
      workId: work.id,
      status: 'awaiting-review',
    });
    expect((await w.store.artifact(w.artifact.id, w.user.id)).version).toBe(1);
    const review = (await w.services.machines.list(w.user, w.artifact.id))[0]!;
    expect(review.result.summary).toContain('denied execution');
    expect(review.result.evidenceStatus).toBe('external-unverified');
    await w.services.machines.review(w.user, w.artifact.id, work.id, true);
    expect(
      (await w.store.artifact(w.artifact.id, w.user.id)).content.files[
        'index.html'
      ],
    ).toContain('Reviewed ACP output');
    expect(await w.store.runs(w.artifact.id)).toEqual([]);
    expect(
      await runMachineOnce(credentials, {
        command: process.execPath,
        args: [w.agentFile],
        cwd: w.dir,
      }),
    ).toEqual({ claimed: false });
  });
  it('cancels an actual stalled ACP process instead of returning a fabricated result', async () => {
    const w = await fixture();
    const client = new AcpClient({
      command: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'],
      cwd: w.dir,
      signal: AbortSignal.timeout(80),
    });
    try {
      await expect(client.run({ brief: 'Never completed' })).rejects.toThrow(
        'cancelled',
      );
    } finally {
      client.close();
    }
  });
  it('rejects stale source application and rolls lifecycle state back with failed artifact persistence', async () => {
    const w = await fixture(),
      machine = await w.services.machines.pair(
        (
          await w.services.machines.pairing(
            w.user,
            w.project.id,
            'Atomic review',
          )
        ).code,
      );
    const auth = await w.services.machines.authenticate(
      { headers: { authorization: `Bearer ${machine.token}` } } as any,
      machine.id,
    );
    const work = await w.services.machines.queue(w.user, w.artifact.id, {
      version: 1,
      kind: 'implementation',
      brief: 'Review a full proposal.',
    });
    const claim = await w.services.machines.claim(auth);
    await w.services.machines.complete(auth, work.id, claim.leaseToken!, {
      summary: 'Proposed edit',
      content: {
        ...w.artifact.content,
        files: { 'index.html': '<h1>Atomic replacement</h1>' },
      },
    });
    await w.store.db.exec(
      "CREATE TRIGGER reject_machine_accept BEFORE UPDATE ON studio_machine_work WHEN NEW.status='accepted' BEGIN SELECT RAISE(ABORT,'fixture metadata write failure'); END",
    );
    await expect(
      w.services.machines.review(w.user, w.artifact.id, work.id, true),
    ).rejects.toThrow('metadata write failure');
    expect((await w.store.artifact(w.artifact.id, w.user.id)).version).toBe(1);
    expect(
      (await w.services.machines.list(w.user, w.artifact.id))[0]?.status,
    ).toBe('awaiting-review');
    expect(
      await w.store.all(
        'SELECT * FROM revisions WHERE artifact_id=?',
        w.artifact.id,
      ),
    ).toHaveLength(1);
  });
});
