import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.ts';
import { openDatabase } from '../server/persistence/index.ts';
import { ImplementationGraphs } from '../server/integrations/implementation.ts';
import {
  implementationDefinitionSchema,
  implementationPointer,
  type ImplementationActor,
  type ImplementationDefinition,
  type ImplementationReport,
  type ImplementationRun,
} from '../shared/implementation.ts';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const definition: ImplementationDefinition = {
  tasks: [
    {
      id: 'boundary',
      title: 'Boundary',
      description: 'Implement boundary',
      acceptanceCriteria: ['Contract is executable', 'Failure is observable'],
    },
    {
      id: 'consumer',
      title: 'Consumer',
      description: 'Consume boundary',
      acceptanceCriteria: ['Consumer handles boundary'],
    },
  ],
  edges: [{ from: 'boundary', to: 'consumer' }],
};
const repo = 'https://github.com/example/graph-fixture';
const pgURL = process.env.STUDIO_TEST_POSTGRES_URL;
const copy = <T>(value: T): T => structuredClone(value);

async function fixture(provider: 'sqlite' | 'postgres') {
  const schema = 'test_' + randomUUID().replaceAll('-', '');
  const first = await Store.open(
    provider === 'sqlite'
      ? ':memory:'
      : await openDatabase({ adapter: 'postgres', url: pgURL!, schema }),
  );
  const second =
    provider === 'sqlite'
      ? first
      : await Store.open(
          await openDatabase({ adapter: 'postgres', url: pgURL!, schema }),
        );
  cleanup.push(async () => {
    if (provider === 'postgres')
      await first.db.exec('DROP SCHEMA "' + schema + '" CASCADE');
    if (second !== first) await second.close();
    await first.close();
  });
  const owner = await first.createUser(
    'owner-' + randomUUID() + '@example.test',
    'Owner',
    null,
  );
  const reviewer = await first.createUser(
    'reviewer-' + randomUUID() + '@example.test',
    'Independent reviewer',
    null,
  );
  const viewer = await first.createUser(
    'viewer-' + randomUUID() + '@example.test',
    'Viewer',
    null,
  );
  const project = await first.createProject(
    owner,
    'Implementation fixture',
    '',
    repo,
  );
  await first.exec(
    'INSERT INTO memberships(project_id,user_id,role) VALUES(?,?,?)',
    project.id,
    reviewer.id,
    'editor',
  );
  await first.exec(
    'INSERT INTO memberships(project_id,user_id,role) VALUES(?,?,?)',
    project.id,
    viewer.id,
    'viewer',
  );
  const human: ImplementationActor = { user: owner, kind: 'human' };
  const builder: ImplementationActor = {
    user: owner,
    kind: 'agent',
    agentId: 'fixture/builder',
  };
  const independent: ImplementationActor = { user: reviewer, kind: 'human' };
  const notifications: number[] = [];
  const graph = await new ImplementationGraphs({
    store: first,
    notify: async (event) => {
      expect(first.db.inTransaction()).toBe(false);
      const head = await second.one(
        'SELECT revision FROM implementation_heads WHERE artifact_id=?',
        event.artifactId,
      );
      expect(Number(head.revision)).toBeGreaterThanOrEqual(event.revision);
      notifications.push(event.revision);
    },
  }).initialize();
  const other = await new ImplementationGraphs({ store: second }).initialize();
  const id = project.mainArtifactId;
  const draft = () =>
    graph.edit(builder, id, { expected: null, planRevision: 1, definition });
  const ready = async () => {
    const draftGraph = await draft();
    return graph.approve(human, id, implementationPointer(draftGraph));
  };
  const claimed = async () => {
    const approved = await ready();
    return graph.claim(builder, id, {
      expected: implementationPointer(approved),
      repository: repo,
      branch: 'feature/fixture',
      commit: 'a'.repeat(40),
    });
  };
  const report = (
    run: ImplementationRun,
    command: ImplementationReport['command'],
    actor = builder,
    key: string = randomUUID(),
    service = graph,
  ) =>
    service.report(actor, id, { runId: run.id, idempotencyKey: key, command });
  const noChange = async (run: ImplementationRun, taskId: string) => {
    await report(run, { kind: 'start_task', taskId });
    return report(run, {
      kind: 'complete_task',
      taskId,
      summary: 'Existing code satisfies the task',
      noChange: {
        reason: 'Already implemented at the claimed base',
        evidence: 'Executed the synthetic fixture; all assertions passed.',
      },
    });
  };
  const verification = (failed = false): ImplementationReport['command'] => ({
    kind: 'report_verification',
    verification: {
      summary: 'Independent review of the whole graph',
      tasks: definition.tasks.map((task) => ({
        taskId: task.id,
        criteria: task.acceptanceCriteria.map((_, index) => ({
          index,
          passed: !(failed && task.id === 'boundary' && index === 0),
          evidence: 'Inspected criterion against the fixture output.',
        })),
      })),
    },
  });
  return {
    first,
    second,
    graph,
    other,
    owner,
    reviewer,
    viewer,
    human,
    builder,
    independent,
    project,
    id,
    draft,
    ready,
    claimed,
    report,
    noChange,
    verification,
    notifications,
  };
}

it('rejects cycles, duplicate identifiers, dangling dependencies and missing criteria', () => {
  expect(implementationDefinitionSchema.safeParse(definition).success).toBe(
    true,
  );
  const cycle = copy(definition);
  cycle.edges.push({ from: 'consumer', to: 'boundary' });
  expect(implementationDefinitionSchema.safeParse(cycle).success).toBe(false);
  const duplicate = copy(definition);
  duplicate.tasks[1].id = 'boundary';
  expect(implementationDefinitionSchema.safeParse(duplicate).success).toBe(
    false,
  );
  expect(
    implementationDefinitionSchema.safeParse({
      ...definition,
      edges: [{ from: 'absent', to: 'consumer' }],
    }).success,
  ).toBe(false);
  const empty = copy(definition);
  empty.tasks[0].acceptanceCriteria = [];
  expect(implementationDefinitionSchema.safeParse(empty).success).toBe(false);
});

for (const provider of ['sqlite', 'postgres'] as const)
  describe.skipIf(provider === 'postgres' && !pgURL)(
    provider + ' implementation lifecycle',
    () => {
      it('atomically approves, queues, claims and reports with a durable pre-claim lock and shared rollback', async () => {
        const f = await fixture(provider),
          draft = await f.draft(),
          queueId = randomUUID();
        await f.first.db.exec(
          'CREATE TABLE implementation_test_queue(id TEXT PRIMARY KEY,status TEXT NOT NULL,run_id TEXT)',
        );
        const lock = async () => {
          const queue = await f.first.one(
            "SELECT id FROM implementation_test_queue WHERE status IN ('queued','launching') LIMIT 1",
          );
          return queue
            ? {
                runId: queue.id,
                graphVersion: 1,
                claimedBy: draft.authoredBy,
                startedAt: draft.createdAt,
              }
            : null;
        };
        f.graph.options.externalEditingLock = lock;
        await expect(
          f.first.tx(async () => {
            await f.graph.approveInTransaction(
              f.human,
              f.id,
              implementationPointer(draft),
            );
            await f.first.exec(
              'INSERT INTO implementation_test_queue(id,status) VALUES(?,?)',
              queueId,
              'queued',
            );
            throw new Error('queue admission rollback');
          }),
        ).rejects.toThrow('queue admission rollback');
        expect((await f.graph.read(f.owner, f.id)).graph?.status).toBe('draft');
        await f.first.tx(async () => {
          await f.graph.approveInTransaction(
            f.human,
            f.id,
            implementationPointer(draft),
          );
          await f.first.exec(
            'INSERT INTO implementation_test_queue(id,status) VALUES(?,?)',
            queueId,
            'queued',
          );
        });
        expect((await f.graph.editingLock(f.id))?.runId).toBe(queueId);
        const claim = {
          expected: implementationPointer(draft),
          repository: repo,
          branch: 'atomic-queue',
          commit: 'c'.repeat(40),
        };
        await expect(f.graph.claim(f.builder, f.id, claim)).rejects.toThrow(
          'implementation-locked',
        );
        await expect(
          f.first.tx(async () => {
            await f.first.lock('project:' + f.project.id);
            await f.graph.assertPlanEditable(f.id);
          }),
        ).rejects.toThrow('implementation-locked');
        await expect(
          f.first.tx(async () => {
            await f.first.lock('project:' + f.project.id);
            await f.first.exec(
              'UPDATE implementation_test_queue SET status=? WHERE id=?',
              'claiming',
              queueId,
            );
            await f.graph.claimInTransaction(f.builder, f.id, claim);
            throw new Error('claim rollback');
          }),
        ).rejects.toThrow('claim rollback');
        expect((await f.graph.read(f.owner, f.id)).activeRun).toBeNull();
        expect((await f.graph.editingLock(f.id))?.runId).toBe(queueId);
        const run = await f.first.tx(async () => {
          await f.first.lock('project:' + f.project.id);
          await f.first.exec(
            'UPDATE implementation_test_queue SET status=? WHERE id=?',
            'claiming',
            queueId,
          );
          const run = await f.graph.claimInTransaction(f.builder, f.id, claim);
          await f.first.exec(
            'UPDATE implementation_test_queue SET status=?,run_id=? WHERE id=?',
            'running',
            run.id,
            queueId,
          );
          return run;
        });
        expect((await f.graph.editingLock(f.id))?.runId).toBe(run.id);
        const report = {
          runId: run.id,
          idempotencyKey: 'atomic-revision',
          command: {
            kind: 'request_revision',
            reason: 'Scoped queue cancelled',
          },
        };
        await expect(
          f.first.tx(async () => {
            await f.graph.reportInTransaction(f.builder, f.id, report);
            await f.first.exec(
              'UPDATE implementation_test_queue SET status=? WHERE id=?',
              'cancelled',
              queueId,
            );
            throw new Error('report rollback');
          }),
        ).rejects.toThrow('report rollback');
        expect((await f.graph.read(f.owner, f.id)).activeRun?.status).toBe(
          'running',
        );
        const ended = await f.first.tx(async () => {
          const ended = await f.graph.reportInTransaction(
            f.builder,
            f.id,
            report,
          );
          await f.first.exec(
            'UPDATE implementation_test_queue SET status=? WHERE id=?',
            'cancelled',
            queueId,
          );
          return ended;
        });
        expect(await f.graph.editingLock(f.id)).toBeNull();
        expect(await f.graph.report(f.builder, f.id, report)).toEqual(ended);
      });
      it('interrupts an expired connector run after writer revocation with system attribution and cannot unlock a replacement run', async () => {
        const f = await fixture(provider),
          run = await f.claimed();
        await f.first.exec(
          'DELETE FROM memberships WHERE project_id=? AND user_id=?',
          f.project.id,
          f.owner.id,
        );
        const request = {
          runId: run.id,
          idempotencyKey: 'revoked-member',
          command: {
            kind: 'request_revision',
            reason: 'Expired connector lease',
          },
        };
        await expect(
          f.graph.report(f.builder, f.id, request),
        ).rejects.toMatchObject({ statusCode: 404 });
        await expect(
          f.first.tx(async () => {
            await f.graph.interruptInTransaction(
              f.id,
              run.id,
              'Expired connector lease',
            );
            throw new Error('cleanup rollback');
          }),
        ).rejects.toThrow('cleanup rollback');
        expect((await f.graph.read(f.reviewer, f.id)).activeRun?.id).toBe(
          run.id,
        );
        const ended = await f.first.tx(() =>
          f.graph.interruptInTransaction(
            f.id,
            run.id,
            'Expired connector lease',
          ),
        );
        expect(ended.status).toBe('revision_requested');
        expect(ended.claimedBy).toEqual(run.claimedBy);
        expect(await f.graph.editingLock(f.id)).toBeNull();
        const event = (await f.graph.history(f.reviewer, f.id))[0];
        expect(event.kind).toBe('interrupted');
        expect(event.actor).toMatchObject({
          kind: 'agent',
          userId: 'system',
          name: 'Implementation service',
        });
        const state = await f.graph.read(f.reviewer, f.id);
        const next = await f.graph.claim(f.independent, f.id, {
          expected: implementationPointer(state.graph!),
          repository: repo,
          branch: 'replacement',
          commit: 'd'.repeat(40),
        });
        expect(
          await f.first.tx(() =>
            f.graph.interruptInTransaction(
              f.id,
              run.id,
              'Duplicate old lease callback',
            ),
          ),
        ).toEqual(ended);
        expect((await f.graph.read(f.reviewer, f.id)).activeRun?.id).toBe(
          next.id,
        );
      });
      it('uses exact draft/plan CAS, human-only approval and versioned replacement without early supersession', async () => {
        const f = await fixture(provider),
          draft = await f.draft();
        await expect(
          f.graph.approve(f.builder, f.id, implementationPointer(draft)),
        ).rejects.toMatchObject({ statusCode: 403 });
        const edited = await f.graph.edit(f.builder, f.id, {
          expected: implementationPointer(draft),
          planRevision: 1,
          definition,
        });
        expect(edited).toMatchObject({ graphVersion: 1, draftRevision: 2 });
        await expect(
          f.graph.approve(f.human, f.id, implementationPointer(draft)),
        ).rejects.toThrow('graph-conflict');
        await f.first.exec('UPDATE artifacts SET version=2 WHERE id=?', f.id);
        await expect(
          f.graph.approve(f.human, f.id, implementationPointer(edited)),
        ).rejects.toThrow('plan-conflict');
        const rebased = await f.graph.edit(f.builder, f.id, {
          expected: implementationPointer(edited),
          planRevision: 2,
          definition,
        });
        const approved = await f.graph.approve(
          f.human,
          f.id,
          implementationPointer(rebased),
        );
        const replacement = await f.graph.edit(f.builder, f.id, {
          expected: implementationPointer(approved),
          planRevision: 2,
          definition,
        });
        expect(replacement).toMatchObject({
          graphVersion: 2,
          draftRevision: 1,
          status: 'draft',
        });
        expect((await f.graph.read(f.owner, f.id)).versions[1].status).toBe(
          'approved',
        );
        await f.graph.approve(
          f.human,
          f.id,
          implementationPointer(replacement),
        );
        expect((await f.graph.read(f.owner, f.id)).versions[1].status).toBe(
          'superseded',
        );
      });
      it('fences competing claims across services and keeps source locked after service recreation', async () => {
        const f = await fixture(provider),
          approved = await f.ready();
        const request = {
          expected: implementationPointer(approved),
          repository: repo,
          branch: 'feature/fixture',
          commit: 'b'.repeat(40),
        };
        await expect(
          f.graph.claim(f.builder, f.id, {
            ...request,
            repository: 'https://github.com/example/different',
          }),
        ).rejects.toMatchObject({ statusCode: 403 });
        const claims = await Promise.allSettled([
          f.graph.claim(f.builder, f.id, request),
          f.other.claim(f.builder, f.id, request),
        ]);
        expect(
          claims.filter((claim) => claim.status === 'fulfilled'),
        ).toHaveLength(1);
        expect(
          claims.filter((claim) => claim.status === 'rejected'),
        ).toHaveLength(1);
        const fresh = await new ImplementationGraphs({
          store: f.second,
        }).initialize();
        const state = await fresh.read(f.owner, f.id);
        expect(state.graph?.status).toBe('locked');
        expect(state.activeRun?.checkout).toEqual({
          repository: repo,
          branch: request.branch,
          commit: request.commit,
        });

        await expect(
          f.first.tx(async () => {
            await f.first.lock('project:' + f.project.id);
            await f.graph.assertPlanEditable(f.id);
          }),
        ).rejects.toThrow('implementation-locked');
        await expect(
          f.graph.edit(f.builder, f.id, {
            expected: implementationPointer(approved),
            planRevision: 1,
            definition,
          }),
        ).rejects.toThrow('implementation-locked');
        expect(state.runs).toHaveLength(1);
      });
      it('publishes a model draft and job receipt in one transaction, rolls back together, and leaves notification to the caller', async () => {
        const f = await fixture(provider);
        await f.first.db.exec(
          'CREATE TABLE implementation_test_receipts(id TEXT PRIMARY KEY)',
        );
        const input = { expected: null, planRevision: 1, definition };
        await expect(
          f.graph.editInTransaction(f.builder, f.id, input),
        ).rejects.toThrow('existing project transaction');
        await expect(
          f.first.tx(async () => {
            await f.first.lock('project:' + f.project.id);
            await f.graph.editInTransaction(f.builder, f.id, input);
            await f.first.exec(
              'INSERT INTO implementation_test_receipts(id) VALUES(?)',
              'rollback',
            );
            throw new Error('receipt rollback');
          }),
        ).rejects.toThrow('receipt rollback');
        expect((await f.graph.read(f.owner, f.id)).graph).toBeNull();
        expect(
          await f.first.one(
            'SELECT id FROM implementation_test_receipts WHERE id=?',
            'rollback',
          ),
        ).toBeUndefined();
        expect(f.notifications).toHaveLength(0);
        await f.first.tx(async () => {
          await f.first.lock('project:' + f.project.id);
          await f.graph.editInTransaction(f.builder, f.id, input);
          await f.first.exec(
            'INSERT INTO implementation_test_receipts(id) VALUES(?)',
            'committed',
          );
        });
        expect((await f.other.read(f.owner, f.id)).graph?.definition).toEqual(
          definition,
        );
        expect(
          await f.second.one(
            'SELECT id FROM implementation_test_receipts WHERE id=?',
            'committed',
          ),
        ).toBeTruthy();
        expect(await f.graph.history(f.owner, f.id)).toHaveLength(1);
        expect(f.notifications).toHaveLength(0);
      });
      it('requires dependency-ready starts, keeps early blockers, persists no-change evidence and deduplicates reports', async () => {
        const f = await fixture(provider),
          run = await f.claimed();
        await expect(
          f.report(run, { kind: 'start_task', taskId: 'consumer' }),
        ).rejects.toThrow('dependencies-incomplete');
        await f.report(run, {
          kind: 'block_task',
          taskId: 'consumer',
          reason: 'The prerequisite is not implemented',
        });
        expect(
          (await f.graph.read(f.owner, f.id)).activeRun?.tasks[1].status,
        ).toBe('blocked');
        await f.noChange(run, 'boundary');
        await expect(
          f.report(run, {
            kind: 'report_pr',
            taskId: 'boundary',
            pullRequest: { url: repo + '/pull/1', state: 'open' },
          }),
        ).rejects.toThrow('no-change');
        const command: ImplementationReport['command'] = {
          kind: 'start_task',
          taskId: 'consumer',
        };
        const [one, two] = await Promise.all([
          f.report(run, command, f.builder, 'same-start'),
          f.report(run, command, f.builder, 'same-start', f.other),
        ]);
        expect(two).toEqual(one);
        const events = await f.graph.history(f.owner, f.id);
        expect(
          events.filter(
            (event) =>
              event.kind === 'start_task' && event.detail.taskId === 'consumer',
          ),
        ).toHaveLength(1);
        await expect(
          f.report(
            run,
            { kind: 'block_task', taskId: 'consumer', reason: 'Different' },
            f.builder,
            'same-start',
          ),
        ).rejects.toThrow('idempotency-conflict');
        await expect(
          f.report(run, {
            kind: 'complete_task',
            taskId: 'consumer',
            summary: 'Done',
          }),
        ).rejects.toThrow('pull-request-required');
        const complete: ImplementationReport['command'] = {
          kind: 'complete_task',
          taskId: 'consumer',
          summary: 'Verified existing consumer',
          noChange: {
            reason: 'Already meets criteria',
            evidence: 'Executed fixture with success',
          },
        };
        const accepted = await f.report(run, complete, f.builder, 'finish');
        expect(accepted.tasks[1].noChange?.evidence).toContain('success');
        await expect(f.report(run, complete)).rejects.toThrow(
          'already-complete',
        );
        await expect(
          f.report(run, f.verification(), f.builder),
        ).rejects.toMatchObject({ statusCode: 403 });
        const verified = await f.report(run, f.verification(), f.independent);
        expect(verified.status).toBe('implemented');
        expect((await f.graph.read(f.owner, f.id)).editingLock).toBeNull();
        expect(
          await f.report(run, complete, f.builder, 'finish', f.other),
        ).toEqual(accepted);
      });
      it('records repository PR provenance, rejects incomplete review and returns failed prerequisites plus dependents to work', async () => {
        const f = await fixture(provider),
          run = await f.claimed();
        await f.report(run, { kind: 'start_task', taskId: 'boundary' });
        await expect(
          f.report(run, {
            kind: 'report_pr',
            taskId: 'boundary',
            pullRequest: {
              url: 'https://github.com/outsider/repository/pull/9',
              state: 'open',
            },
          }),
        ).rejects.toThrow('claimed repository');
        const pr = { url: repo + '/pull/42', state: 'open' as const };
        await f.report(run, {
          kind: 'report_pr',
          taskId: 'boundary',
          pullRequest: pr,
        });
        await expect(
          f.report(run, {
            kind: 'complete_task',
            taskId: 'boundary',
            summary: 'Done',
            noChange: { reason: 'None', evidence: 'None' },
          }),
        ).rejects.toThrow('no-change-pull-request');
        await f.report(run, {
          kind: 'complete_task',
          taskId: 'boundary',
          summary: 'Boundary complete',
        });
        await f.noChange(run, 'consumer');
        const incomplete = f.verification();
        if (incomplete.kind === 'report_verification')
          incomplete.verification.tasks[0].criteria.pop();
        await expect(f.report(run, incomplete, f.independent)).rejects.toThrow(
          'verification-coverage',
        );
        const failed = await f.report(run, f.verification(true), f.independent);
        expect(failed.status).toBe('running');
        expect(failed.verification?.returnedTaskIds).toEqual([
          'boundary',
          'consumer',
        ]);
        expect(failed.tasks.map((task) => task.status)).toEqual([
          'queued',
          'queued',
        ]);
        expect(await f.other.editingLock(f.id)).not.toBeNull();
        await f.report(run, { kind: 'start_task', taskId: 'boundary' });
        await f.report(run, {
          kind: 'complete_task',
          taskId: 'boundary',
          summary: 'Fixed after review',
        });
        await f.noChange(run, 'consumer');
        const implemented = await f.report(
          run,
          f.verification(),
          f.independent,
        );
        expect(implemented.status).toBe('implemented');
        const delivered = await f.report(run, {
          kind: 'report_pr',
          taskId: 'boundary',
          pullRequest: { ...pr, state: 'merged' },
        });
        expect(delivered.status).toBe('delivered');
        const snapshot = await f.graph.read(f.owner, f.id);
        await expect(
          f.graph.claim(f.builder, f.id, {
            expected: implementationPointer(snapshot.graph!),
            repository: repo,
            branch: 'retry',
            commit: 'a'.repeat(40),
          }),
        ).rejects.toThrow('already-implemented');
        await expect(
          f.report(run, {
            kind: 'report_pr',
            taskId: 'boundary',
            pullRequest: pr,
          }),
        ).rejects.toThrow('merged-pull-request');
        const history = await f.graph.history(f.owner, f.id);
        expect(
          history.filter((event) => event.kind === 'report_verification'),
        ).toHaveLength(2);
        const next = await f.graph.history(f.owner, f.id, {
          limit: 3,
          before: history[2].revision,
        });
        expect(
          next.every((event) => event.revision < history[2].revision),
        ).toBe(true);
      });
      it('unlocks revision requests, fences old runs, and refuses an older approved version after a replacement draft', async () => {
        const f = await fixture(provider),
          run = await f.claimed();
        const revised = await f.report(run, {
          kind: 'request_revision',
          reason: 'The dependency graph needs another task',
        });
        expect(revised.status).toBe('revision_requested');
        const snapshot = await f.graph.read(f.owner, f.id);
        expect(snapshot.graph?.status).toBe('approved');
        expect(snapshot.editingLock).toBeNull();
        const request = {
          expected: implementationPointer(snapshot.graph!),
          repository: repo,
          branch: 'retry',
          commit: 'c'.repeat(40),
        };
        const second = await f.other.claim(f.builder, f.id, request);
        expect(second.id).not.toBe(run.id);
        await expect(
          f.report(run, { kind: 'start_task', taskId: 'boundary' }),
        ).rejects.toThrow('run-not-active');
        await f.report(second, {
          kind: 'request_revision',
          reason: 'New scope is required',
        });
        await f.graph.edit(f.builder, f.id, {
          expected: request.expected,
          planRevision: 1,
          definition,
        });
        await expect(f.graph.claim(f.builder, f.id, request)).rejects.toThrow(
          'graph-conflict',
        );
      });
      it('enforces membership/capability and preserves lifecycle through archive while deleting all sidecars on permanent removal', async () => {
        const f = await fixture(provider);
        await expect(
          f.graph.edit({ user: f.viewer, kind: 'human' }, f.id, {
            expected: null,
            planRevision: 1,
            definition,
          }),
        ).rejects.toMatchObject({ statusCode: 403 });
        const stranger = await f.first.createUser(
          'stranger-' + randomUUID() + '@example.test',
          'Stranger',
          null,
        );
        await expect(f.graph.read(stranger, f.id)).rejects.toMatchObject({
          statusCode: 404,
        });
        const run = await f.claimed();
        await f.first.exec('UPDATE artifacts SET archived=1 WHERE id=?', f.id);
        await f.report(run, {
          kind: 'block_task',
          taskId: 'boundary',
          reason: 'Archive does not terminate the active run',
        });
        await f.report(run, {
          kind: 'request_revision',
          reason: 'Return archived run for changes',
        });
        await expect(
          f.graph.claim(f.builder, f.id, {
            expected: implementationPointer(
              (await f.graph.read(f.owner, f.id)).graph!,
            ),
            repository: repo,
            branch: 'retry',
            commit: 'a'.repeat(40),
          }),
        ).rejects.toThrow('archived');
        await f.first.exec('DELETE FROM artifacts WHERE id=?', f.id);
        expect(
          await f.first.one(
            'SELECT id FROM implementation_runs WHERE id=?',
            run.id,
          ),
        ).toBeUndefined();
        expect(
          await f.first.one(
            'SELECT artifact_id FROM implementation_graphs WHERE artifact_id=?',
            f.id,
          ),
        ).toBeUndefined();
        expect(
          await f.first.one(
            'SELECT artifact_id FROM implementation_events WHERE artifact_id=?',
            f.id,
          ),
        ).toBeUndefined();
        await expect(
          f.report(run, { kind: 'start_task', taskId: 'boundary' }),
        ).rejects.toMatchObject({ statusCode: 404 });
      });
      it('rechecks canonical source after acquiring the shared project lock instead of claiming a stale checkout', async () => {
        const f = await fixture(provider),
          approved = await f.ready();
        let release!: () => void, entered!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const ready = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const edit = f.first.tx(async () => {
          await f.first.lock('project:' + f.project.id);
          await f.graph.assertPlanEditable(f.id);
          await f.first.exec(
            'UPDATE artifacts SET version=version+1 WHERE id=?',
            f.id,
          );
          entered();
          await gate;
        });
        await ready;
        const claim = f.other.claim(f.builder, f.id, {
          expected: implementationPointer(approved),
          repository: repo,
          branch: 'stale',
          commit: 'd'.repeat(40),
        });
        release();
        await edit;
        await expect(claim).rejects.toThrow('plan-conflict');
        expect((await f.graph.read(f.owner, f.id)).activeRun).toBeNull();
      });
    },
  );
