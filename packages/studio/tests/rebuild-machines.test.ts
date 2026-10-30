import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.ts';
import { openDatabase } from '../server/persistence/index.ts';
import { MachineService } from '../server/integrations/machines.ts';
import { InvestigationService } from '../server/integrations/investigations.ts';
import { ImplementationGraphs } from '../server/integrations/implementation.ts';
import { ImplementationMachines } from '../server/integrations/implementation-machines.ts';
import { RebuildMachines } from '../server/integrations/rebuild-machines.ts';
import { implementationPointer } from '../shared/implementation.ts';
import {
  changedDocumentBlocks,
  type RebuildReport,
} from '../shared/rebuild.ts';
import { paragraph } from '../shared/domain.ts';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const pg = process.env.STUDIO_TEST_POSTGRES_URL;
const runtime = {
  adapter: 'acp' as const,
  executableName: 'explicit-fixture',
  executableSha256: 'a'.repeat(64),
  argumentsSha256: 'b'.repeat(64),
  argumentFileSha256: null,
  model: null,
  provenance: 'connector-reported' as const,
};
async function fixture(postgres = false, secondary = false) {
  const store = await Store.open(
    postgres
      ? await openDatabase({
          adapter: 'postgres',
          url: pg!,
          schema: 'rebuild_' + randomUUID().replaceAll('-', ''),
        })
      : ':memory:',
  );
  cleanup.push(() => store.close());
  const user = await store.createUser('builder@example.test', 'Builder', null),
    project = (await store.createProject(
      user,
      'Living plan',
      '',
      'https://github.com/example/living',
    ))!;
  let artifact = secondary
    ? await store.createArtifact(
        user,
        project.id,
        'document',
        'Archived rebuild source',
      )
    : await store.artifact(project.mainArtifactId, user.id, 'write');
  artifact = await store.updateArtifact(user, artifact.id, artifact.version, {
    ...artifact.content,
    doc: { type: 'doc', content: [paragraph('Approved first build')] },
  });
  const machines = new MachineService(store, { notify() {} } as any);
  await machines.initialize();
  const credentials = await machines.pair(
      (await machines.pairing(user, project.id, 'Builder laptop')).code,
    ),
    principal = await store.one(
      'SELECT * FROM studio_machines WHERE id=?',
      credentials.id,
    );
  const investigations = new InvestigationService({
    store,
    auth: {} as any,
    machines,
    objects: {} as any,
  });
  await investigations.ready;
  await investigations.registerCheckout(principal, {
    repository: project.repository!,
    sourceCommit: 'a'.repeat(40),
    branch: 'main',
  });
  const graphs = await new ImplementationGraphs({ store }).initialize(),
    graph = await graphs.edit({ user, kind: 'human' }, artifact.id, {
      expected: null,
      planRevision: artifact.version,
      definition: {
        tasks: [
          {
            id: 'page',
            title: 'Build page',
            description: 'Implement the reviewed plan',
            acceptanceCriteria: ['Page reflects the plan'],
          },
        ],
        edges: [],
      },
    });
  const builds = new ImplementationMachines({
    store,
    auth: {} as any,
    machines,
    graphs,
  });
  await builds.ready;
  const queued = await builds.queue(user, artifact.id, {
      expected: implementationPointer(graph),
    }),
    claimed = await builds.claim(principal),
    lease = {
      leaseToken: claimed.leaseToken!,
      generation: claimed.work!.generation,
    };
  const run = await builds.start(principal, queued.id, {
    ...lease,
    checkout: {
      expected: claimed.work!.expected,
      repository: project.repository!,
      branch: claimed.work!.branch,
      commit: 'a'.repeat(40),
    },
  });
  for (const [key, command] of [
    ['start', { kind: 'start_task', taskId: 'page' }],
    [
      'pr',
      {
        kind: 'report_pr',
        taskId: 'page',
        pullRequest: { url: project.repository + '/pull/7', state: 'open' },
      },
    ],
    [
      'done',
      {
        kind: 'complete_task',
        taskId: 'page',
        summary: 'Implemented baseline',
      },
    ],
  ] as const)
    await builds.report(principal, queued.id, {
      ...lease,
      report: { runId: run.id, idempotencyKey: key, command },
    });
  const verifier = await builds.verifier(principal, queued.id, lease);
  await builds.report(principal, queued.id, {
    ...lease,
    verifierToken: verifier.verifierToken,
    report: {
      runId: run.id,
      idempotencyKey: 'verification',
      command: {
        kind: 'report_verification',
        verification: {
          summary: 'Independent baseline review',
          tasks: [
            {
              taskId: 'page',
              criteria: [
                {
                  index: 0,
                  passed: true,
                  evidence: 'Actual reviewed checkout',
                },
              ],
            },
          ],
        },
      },
    },
  });
  let head = 'b'.repeat(40),
    resolves = 0;
  const service = new RebuildMachines({
    store,
    auth: {} as any,
    graphs,
    machines,
    settleMs: 0,
    assertReady: async () => {},
    resolvePullRequest: async (_user, repo, url) => {
      resolves++;
      return {
        url,
        repository: repo,
        state: 'open',
        branch: claimed.work!.branch,
        commit: head,
      };
    },
  });
  await service.ready;
  store.sourceObserver = (user, previous, current) =>
    service.observe(user, previous, current);
  const change = async (text: string) => {
    const latest = await store.artifact(artifact.id, user.id, 'write');
    return store.updateArtifact(user, artifact.id, latest.version, {
      ...latest.content,
      doc: {
        type: 'doc',
        content: [
          { ...paragraph(text), attrs: latest.content.doc.content[0].attrs },
        ],
      },
    });
  };
  const queue = async () => {
    const snapshot = await service.snapshot(user, artifact.id);
    return service.queue(user, artifact.id, {
      expectedSourceSha256: snapshot.currentSourceSha256,
    });
  };
  const start = async () => {
    const queued = await queue(),
      claimed = await service.claim(principal),
      lease = {
        leaseToken: claimed.leaseToken!,
        generation: claimed.work!.generation,
      };
    await service.start(principal, queued.id!, {
      ...lease,
      pullRequests: claimed.work!.pullRequests,
      runtime,
    });
    return { id: queued.id!, lease, work: claimed.work! };
  };
  const report = (sourceSha256: string): RebuildReport => ({
    idempotencyKey: 'rebuilt',
    sourceSha256,
    summary: 'Updated existing PR from exact changed source',
    pullRequests: [
      {
        url: project.repository + '/pull/7',
        branch: claimed.work!.branch,
        commit: head,
        evidence: 'Existing branch updated and independently inspected',
      },
    ],
    criteria: [
      {
        taskId: 'page',
        index: 0,
        passed: true,
        evidence: 'Original criterion checked against changed document',
      },
    ],
  });
  return {
    store,
    user,
    project,
    artifact,
    machines,
    principal,
    service,
    graphs,
    builds,
    credentials,
    change,
    queue,
    start,
    report,
    setHead: (value: string) => (head = value),
    get resolves() {
      return resolves;
    },
  };
}
for (const postgres of [false, true])
  describe.skipIf(postgres && !pg)(
    `living document existing PR rebuild (${postgres ? 'PostgreSQL' : 'SQLite'})`,
    () => {
      it('finishes an already-started rebuild after archive without enabling new claims or approvals', async () => {
        const c = await fixture(postgres, true);
        await c.change('Changed source before archival');
        const run = await c.start();
        const { ArtifactLifecycle } = await import(
            '../server/artifact-lifecycle.ts'
          ),
          lifecycle = new ArtifactLifecycle({
            store: c.store,
            auth: {} as any,
            objects: {} as any,
          });
        await lifecycle.ready;
        await lifecycle.archive(c.user, c.artifact.id);
        await expect(
          c.service.heartbeat(c.principal, run.id, run.lease),
        ).resolves.toEqual({ ok: true });
        c.setHead('c'.repeat(40));
        const report = c.report(run.work.sourceSha256);
        await c.service.report(c.principal, run.id, { ...run.lease, report });
        const verifier = await c.service.verifier(
          c.principal,
          run.id,
          run.lease,
        );
        await expect(
          c.service.report(c.principal, run.id, {
            ...run.lease,
            verifierToken: verifier.verifierToken,
            report: { ...report, idempotencyKey: 'archived-independent' },
          }),
        ).resolves.toEqual({ status: 'completed' });
        expect(
          (await c.service.snapshot(c.user, c.artifact.id)).baseline?.revision,
        ).toBe(2);
        expect(
          (await c.graphs.read(c.user, c.artifact.id)).versions,
        ).toHaveLength(1);
        await expect(c.queue()).rejects.toThrow('archived');
        const state = (await lifecycle.inspect(c.user, c.artifact.id)).artifact;
        await expect(
          lifecycle.purge(c.user, c.artifact.id, {
            version: state.version,
            archiveRevision: state.archiveRevision,
            confirmTitle: state.title,
          }),
        ).rejects.toMatchObject({ statusCode: 409 });
      });
      it('captures delivered source, counts changes, rebuilds same PR and advances only after independent verified receipt', async () => {
        const c = await fixture(postgres),
          initial = await c.service.snapshot(c.user, c.artifact.id);
        expect(initial.baseline?.sourceVersion).toBe(c.artifact.version);
        expect(initial.changes).toBe(0);
        await c.change('Updated design, quoted text is data');
        expect((await c.service.snapshot(c.user, c.artifact.id)).changes).toBe(
          1,
        );
        const run = await c.start(),
          read = await c.service.read(c.principal, run.id, run.lease);
        expect(JSON.stringify(read.before)).toContain('Approved first build');
        expect(JSON.stringify(read.after)).toContain('Updated design');
        expect(read.pullRequests[0].url).toMatch(/\/pull\/7$/);
        c.setHead('c'.repeat(40));
        const report = c.report(run.work.sourceSha256);
        await expect(
          c.service.report(c.principal, run.id, { ...run.lease, report }),
        ).resolves.toEqual({ status: 'awaiting_verification' });
        expect(
          (await c.service.snapshot(c.user, c.artifact.id)).baseline?.revision,
        ).toBe(1);
        const verifier = await c.service.verifier(
            c.principal,
            run.id,
            run.lease,
          ),
          verified = {
            ...report,
            idempotencyKey: 'independent',
            summary: 'Fresh verifier independently checked actual PR head',
          };
        await expect(
          c.service.report(c.principal, run.id, {
            ...run.lease,
            verifierToken: verifier.verifierToken,
            report: verified,
          }),
        ).resolves.toEqual({ status: 'completed' });
        await expect(
          c.service.report(c.principal, run.id, {
            ...run.lease,
            verifierToken: verifier.verifierToken,
            report: verified,
          }),
        ).resolves.toEqual({ status: 'completed' });
        expect(await c.service.snapshot(c.user, c.artifact.id)).toMatchObject({
          changes: 0,
          baseline: { revision: 2 },
        });
        const { rebuildExportRows } = await import(
          '../server/integrations/rebuild-export.ts'
        );
        const exported = [];
        for await (const row of rebuildExportRows(
          c.store,
          c.artifact.id,
          async () => {
            await c.store.role(c.project.id, c.user.id);
          },
        ))
          exported.push(row);
        expect(exported.map((row) => row.kind)).toEqual([
          'rebuildBaseline',
          'rebuildRun',
        ]);
        expect(JSON.stringify(exported)).not.toContain('lease_hash');
        expect(JSON.stringify(exported)).not.toContain('verifier_hash');
        expect(JSON.stringify(exported)).not.toContain(c.principal.id);
        expect(c.resolves).toBe(3);
        expect(
          (await c.graphs.read(c.user, c.artifact.id)).versions,
        ).toHaveLength(1);
      });
      it('requires explicit original-builder machine/repository consent for settled automatic changes; later edits survive active run', async () => {
        const c = await fixture(postgres);
        await c.change('First changed source');
        await c.service.tick();
        expect(
          (await c.service.snapshot(c.user, c.artifact.id)).runs,
        ).toHaveLength(0);
        await c.service.consent(c.user, c.principal.id, true);
        await c.service.tick();
        expect(
          (await c.service.snapshot(c.user, c.artifact.id)).runs[0],
        ).toMatchObject({ status: 'queued', automatic: 1 });
        const claim = await c.service.claim(c.principal);
        await c.service.start(c.principal, claim.work!.id, {
          leaseToken: claim.leaseToken!,
          generation: claim.work!.generation,
          pullRequests: claim.work!.pullRequests,
          runtime,
        });
        await c.change('Second edit while rebuilding');
        await c.service.tick();
        expect(
          await c.store.one(
            'SELECT artifact_id FROM studio_rebuild_pending WHERE artifact_id=?',
            c.artifact.id,
          ),
        ).toBeTruthy();
        await c.service.consent(c.user, c.principal.id, false);
        await expect(
          c.service.heartbeat(c.principal, claim.work!.id, {
            leaseToken: claim.leaseToken!,
            generation: claim.work!.generation,
          }),
        ).rejects.toMatchObject({ statusCode: 409 });
      });
      it('fences stale source/PR heads, foreign run tokens and incomplete or changed PR reports', async () => {
        const c = await fixture(postgres);
        await c.change('Change for PR');
        const snapshot = await c.service.snapshot(c.user, c.artifact.id);
        await c.change('Latest source');
        await expect(
          c.service.queue(c.user, c.artifact.id, {
            expectedSourceSha256: snapshot.currentSourceSha256,
          }),
        ).rejects.toMatchObject({ statusCode: 409 });
        const queued = await c.queue(),
          claimed = await c.service.claim(c.principal),
          lease = {
            leaseToken: claimed.leaseToken!,
            generation: claimed.work!.generation,
          };
        c.setHead('d'.repeat(40));
        await expect(
          c.service.start(c.principal, queued.id!, {
            ...lease,
            pullRequests: claimed.work!.pullRequests,
            runtime,
          }),
        ).rejects.toMatchObject({ statusCode: 409 });
        c.setHead('b'.repeat(40));
        await c.service.start(c.principal, queued.id!, {
          ...lease,
          pullRequests: claimed.work!.pullRequests,
          runtime,
        });
        await expect(
          c.service.read(c.principal, queued.id!, {
            ...lease,
            leaseToken: 'x'.repeat(43),
          }),
        ).rejects.toMatchObject({ statusCode: 409 });
        const report = c.report(claimed.work!.sourceSha256);
        report.pullRequests[0]!.url = c.project.repository + '/pull/99';
        await expect(
          c.service.report(c.principal, queued.id!, { ...lease, report }),
        ).rejects.toMatchObject({ statusCode: 409 });
      });
      it('never rolls back a valid larger document edit and prevents concurrent first-build admission', async () => {
        const c = await fixture(postgres);
        await c.change('Change to rebuild');
        await c.queue();
        c.builds.dependencies.artifactWorkActive = (id) =>
          c.service.activeOnArtifact(id);
        await expect(
          c.builds.queue(c.user, c.artifact.id, {
            expected: implementationPointer(
              (await c.graphs.read(c.user, c.artifact.id)).graph!,
            ),
          }),
        ).rejects.toThrow('existing-PR rebuild');
        const current = await c.store.artifact(c.artifact.id, c.user.id);
        await expect(
          c.store.updateArtifact(c.user, c.artifact.id, current.version, {
            ...current.content,
            doc: {
              type: 'doc',
              content: Array.from({ length: 6 }, () =>
                paragraph('x'.repeat(190000)),
              ),
            },
          }),
        ).resolves.toBeTruthy();
        const snapshot = await c.service.snapshot(c.user, c.artifact.id);
        await expect(
          c.service.queue(c.user, c.artifact.id, {
            expectedSourceSha256: snapshot.currentSourceSha256,
          }),
        ).rejects.toMatchObject({ statusCode: 413 });
      });
      it('rebuilds changed accepted human choices even when document JSON is unchanged', async () => {
        const c = await fixture(postgres),
          initial = await c.service.snapshot(c.user, c.artifact.id),
          before = await c.store.artifact(c.artifact.id, c.user.id),
          decision = (await c.store.decisions(c.artifact.id))[0]!;
        await c.store.tx(async () => {
          await c.store.lock('project:' + c.project.id);
          await c.store.exec(
            "UPDATE decisions SET status='accepted',decision=?,context=?,consequences=?,version=version+1 WHERE id=?",
            'Use Pact contract fixtures',
            'Preview must work offline',
            'No live integration required',
            decision.id,
          );
          await c.store.touchArtifactSource(c.user, c.artifact.id);
        });
        const after = await c.store.artifact(c.artifact.id, c.user.id),
          updated = await c.service.snapshot(c.user, c.artifact.id);
        expect(after.content).toEqual(before.content);
        expect(after.version).toBe(before.version + 1);
        expect(updated.changes).toBe(1);
        expect(updated.currentSourceSha256).not.toBe(
          initial.currentSourceSha256,
        );
        await expect(
          c.service.queue(c.user, c.artifact.id, {
            expectedSourceSha256: initial.currentSourceSha256,
          }),
        ).rejects.toMatchObject({ statusCode: 409 });
        const queued = await c.queue(),
          claimed = await c.service.claim(c.principal),
          lease = {
            leaseToken: claimed.leaseToken!,
            generation: claimed.work!.generation,
          },
          read = await c.service.read(c.principal, queued.id!, lease);
        expect(read.pullRequests[0].url).toBe(c.project.repository + '/pull/7');
        expect(read.before.acceptedDecisions).toBeUndefined();
        expect(read.after.acceptedDecisions).toMatchObject([
          {
            id: decision.id,
            decision: 'Use Pact contract fixtures',
            status: 'accepted',
            context: 'Preview must work offline',
            consequences: 'No live integration required',
            version: decision.version + 1,
          },
        ]);
        await c.store.tx(async () => {
          await c.store.lock('project:' + c.project.id);
          await c.store.exec(
            'UPDATE decisions SET decision=?,version=version+1 WHERE id=?',
            'Use a different accepted boundary',
            decision.id,
          );
          await c.store.touchArtifactSource(c.user, c.artifact.id);
        });
        await expect(
          c.service.start(c.principal, queued.id!, {
            ...lease,
            pullRequests: claimed.work!.pullRequests,
            runtime,
          }),
        ).rejects.toMatchObject({ statusCode: 409 });
      });
      it('does not replay expired execution; manual retry seals latest source and revoked access cannot report', async () => {
        const c = await fixture(postgres);
        await c.change('Initial change');
        const first = await c.start();
        await c.store.exec(
          'UPDATE studio_rebuild_runs SET lease_expires=? WHERE id=?',
          Date.now() - 1,
          first.id,
        );
        await c.service.tick();
        expect(
          (await c.service.snapshot(c.user, c.artifact.id)).runs[0].status,
        ).toBe('failed');
        await c.change('Latest retry source');
        const retry = await c.start();
        expect(
          (await c.service.read(c.principal, retry.id, retry.lease)).after.doc
            .content[0].content[0].text,
        ).toBe('Latest retry source');
        await c.store.exec(
          "UPDATE memberships SET role='viewer' WHERE project_id=? AND user_id=?",
          c.project.id,
          c.user.id,
        );
        await expect(
          c.service.report(c.principal, retry.id, {
            ...retry.lease,
            report: c.report(retry.work.sourceSha256),
          }),
        ).rejects.toMatchObject({ statusCode: 403 });
      });
    },
  );
it('counts top-level block additions, removals, content changes and reordered blocks', () => {
  const a = {
      type: 'paragraph',
      attrs: { id: 'a' },
      content: [{ type: 'text', text: 'A' }],
    },
    b = {
      type: 'paragraph',
      attrs: { id: 'b' },
      content: [{ type: 'text', text: 'B' }],
    };
  expect(
    changedDocumentBlocks(
      { doc: { content: [a, b] } },
      { doc: { content: [b, a] } },
    ),
  ).toBe(2);
  expect(
    changedDocumentBlocks(
      { doc: { content: [a, b] } },
      { doc: { content: [{ ...a, content: [] }] } },
    ),
  ).toBe(2);
});

it('runs the standalone connector through real Git worktrees, scoped MCP reports and a fresh independent ACP verifier', async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises'),
    { tmpdir } = await import('node:os'),
    { join } = await import('node:path'),
    { execFile } = await import('node:child_process'),
    { promisify } = await import('node:util'),
    { createRequire } = await import('node:module'),
    { pathToFileURL } = await import('node:url');
  const execute = promisify(execFile),
    require = createRequire(import.meta.url),
    dir = await mkdtemp(join(tmpdir(), 'studio-live-rebuild-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const c = await fixture(),
    cwd = join(dir, 'repo');
  await execute('git', ['init', cwd]);
  for (const [key, value] of [
    ['user.email', 'fixture@example.test'],
    ['user.name', 'Rebuild fixture'],
    ['remote.origin.url', c.project.repository!],
  ])
    await execute('git', ['-C', cwd, 'config', key!, value!]);
  await writeFile(join(cwd, 'source.txt'), 'approved baseline\n');
  await execute('git', ['-C', cwd, 'add', 'source.txt']);
  await execute('git', ['-C', cwd, 'commit', '-m', 'Baseline']);
  const branch = (await c.graphs.read(c.user, c.artifact.id)).runs[0]!.checkout
    .branch;
  await execute('git', ['-C', cwd, 'branch', branch]);
  c.service.dependencies.resolvePullRequest = async (_user, repo, url) => ({
    url,
    repository: repo,
    state: 'open',
    branch,
    commit: (
      await execute('git', ['-C', cwd, 'rev-parse', branch])
    ).stdout.trim(),
  });
  await writeFile(join(cwd, 'source.txt'), 'operator dirty edit\n');
  await c.change('Rebuild this exact latest design');
  const queued = await c.queue();
  const { default: Fastify } = await import('fastify'),
    { registerRebuildRoutes } = await import(
      '../server/integrations/rebuild-machines.ts'
    ),
    app = Fastify();
  app.setErrorHandler((error, _, reply) =>
    reply
      .code((error as any).statusCode ?? 500)
      .send({ error: (error as Error).message }),
  );
  app.post<{ Params: { id: string } }>(
    '/api/machines/:id/heartbeat',
    async (request) => {
      await c.machines.authenticate(request, request.params.id);
      return { connected: true };
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/machines/:id/investigations/checkout',
    async (request) => {
      await c.machines.authenticate(request, request.params.id);
      return { registered: true };
    },
  );
  await registerRebuildRoutes(app, c.service.dependencies);
  await app.listen({ host: '127.0.0.1', port: 0 });
  cleanup.push(() => app.close());
  const { privateJson } = await import('../server/machine/runtime.ts'),
    credentials = join(dir, 'credentials.json'),
    sessions = join(dir, 'sessions.txt');
  await privateJson(credentials, {
    ...c.credentials,
    origin: app.listeningOrigin,
  });
  const agent = join(dir, 'explicit-acp-fixture.mjs');
  await writeFile(
    agent,
    `
import readline from 'node:readline';import{readFile,writeFile,appendFile}from'node:fs/promises';import{execFile}from'node:child_process';import{promisify}from'node:util';
import{Client}from ${JSON.stringify(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href)};
import{StdioClientTransport}from ${JSON.stringify(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href)};
const execute=promisify(execFile),send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');let mcp,transport;const session='fresh-'+Math.random();
for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1,agentCapabilities:{}}});else if(m.method==='session/new'){const server=m.params.mcpServers[0];transport=new StdioClientTransport({command:server.command,args:server.args,stderr:'pipe'});mcp=new Client({name:'explicit-existing-pr-rebuild-fixture',version:'1.0.0'});await mcp.connect(transport);send({id:m.id,result:{sessionId:session}});}else if(m.method==='session/prompt'){
const read=JSON.parse((await mcp.callTool({name:'read_rebuild',arguments:{}})).content[0].text),verifier=!!read.implementation,target=read.after.doc.content[0].content[0].text+'\\n';
if(!verifier){await writeFile('source.txt',target);await execute('git',['add','source.txt']);await execute('git',['commit','-m','Apply reviewed living document changes']);const commit=(await execute('git',['rev-parse','HEAD'])).stdout.trim();await execute('git',['update-ref','refs/heads/'+read.pullRequests[0].branch,commit,read.pullRequests[0].commit]);}
const actual=await readFile('source.txt','utf8'),commit=(await execute('git',['rev-parse','HEAD'])).stdout.trim();if(actual!==target)process.exit(5);
await appendFile(${JSON.stringify(sessions)},JSON.stringify({session,verifier,commit})+'\\n');
const report={idempotencyKey:verifier?'independent-exact-commit':'actual-git-branch-update',sourceSha256:read.sourceSha256,summary:verifier?'Fresh session independently inspected actual updated Git commit':'Updated original branch in isolated worktree',pullRequests:[{url:read.pullRequests[0].url,branch:read.pullRequests[0].branch,commit,evidence:'Actual git HEAD '+commit+' and source.txt '+actual}],criteria:[{taskId:'page',index:0,passed:actual===target,evidence:'Read actual source.txt in pinned PR worktree and independently compared latest quoted design'}]};const result=await mcp.callTool({name:'report_rebuild',arguments:report});if(result.isError)throw new Error(JSON.stringify(result));await mcp.close();await transport.close();send({id:m.id,result:{stopReason:'end_turn'}});}else if(m.method==='session/cancel')process.exit(0);}
`,
  );
  const { buildConnector } = await import(
      new URL('../scripts/build-connector.mjs', import.meta.url).href
    ),
    connector = join(dir, 'downloaded-connector.mjs'),
    built = await buildConnector({ outfile: connector });
  expect(built).toBeTruthy();
  await execute(process.execPath, [connector, '--once'], {
    cwd: dir,
    timeout: 25000,
    maxBuffer: 8192,
    env: {
      ...process.env,
      STUDIO_API_URL: app.listeningOrigin,
      STUDIO_MACHINE_CREDENTIALS: credentials,
      STUDIO_MACHINE_CWD: cwd,
      STUDIO_MACHINE_STATE_DIR: join(dir, 'state'),
      STUDIO_MACHINE_AGENT_COMMAND: process.execPath,
      STUDIO_MACHINE_AGENT_ARGS: JSON.stringify([agent]),
    },
  });
  expect(await c.service.snapshot(c.user, c.artifact.id)).toMatchObject({
    changes: 0,
    runs: [{ id: queued.id, status: 'completed' }],
  });
  expect(await readFile(join(cwd, 'source.txt'), 'utf8')).toBe(
    'operator dirty edit\n',
  );
  const records = (await readFile(sessions, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(records.map((record) => record.verifier)).toEqual([false, true]);
  expect(records[0].session).not.toBe(records[1].session);
  expect(records[0].commit).toBe(records[1].commit);
  expect(
    (await execute('git', ['-C', cwd, 'show', branch + ':source.txt'])).stdout,
  ).toBe('Rebuild this exact latest design\n');
}, 30000);
