import { createHash, randomUUID } from 'node:crypto';
import type { Artifact, User } from '../../shared/domain.ts';
import {
  dependencyReady,
  implementationClaimSchema,
  implementationEditSchema,
  implementationPointer,
  implementationPointerSchema,
  implementationReportSchema,
  type ImplementationActor,
  type ImplementationAttribution,
  type ImplementationEditingLock,
  type ImplementationEvent,
  type ImplementationGraph,
  type ImplementationPointer,
  type ImplementationReport,
  type ImplementationRun,
  type ImplementationSnapshot,
} from '../../shared/implementation.ts';
import { repositoryKey } from '../../shared/identity.ts';
import { HttpError, type Store } from '../store.ts';

function fail(code: string, message: string): never {
  throw new HttpError(409, code + ': ' + message);
}
const timestamp = () => new Date().toISOString();
const encode = (value: unknown) => JSON.stringify(value);
const decode = <T>(row: { payload: string } | undefined): T | null =>
  row ? (JSON.parse(row.payload) as T) : null;
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
};

/** Actor kind and agentId MUST come from the authenticated server transport, never request JSON. */
function attribution(actor: ImplementationActor): ImplementationAttribution {
  if (actor.kind !== 'human' && actor.kind !== 'agent')
    throw new HttpError(403, 'A verified actor is required');
  if (
    actor.kind === 'agent' &&
    (!actor.agentId ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]{0,199}$/.test(actor.agentId))
  )
    throw new HttpError(
      403,
      'A stable authenticated agent identity is required',
    );
  return {
    userId: actor.user.id,
    name: actor.user.name,
    kind: actor.kind,
    ...(actor.kind === 'agent' ? { agentId: actor.agentId } : {}),
    key: encode([
      actor.user.id,
      actor.kind,
      actor.kind === 'agent' ? actor.agentId : null,
    ]),
  };
}
function checkPointer(
  graph: ImplementationGraph | null,
  expected: ImplementationPointer | null,
) {
  if (!graph || !expected) {
    if (graph || expected)
      fail(
        'graph-conflict',
        'The graph changed; read the current graph before editing',
      );
    return;
  }
  if (
    graph.planRevision !== expected.planRevision ||
    graph.graphVersion !== expected.graphVersion ||
    graph.draftRevision !== expected.draftRevision
  )
    fail(
      'graph-conflict',
      'The plan or graph changed; read the current graph before continuing',
    );
}

export class ImplementationGraphs {
  constructor(
    readonly options: {
      store: Store;
      /** DB-only room checks under the project transaction, e.g. unresolved decisions. */
      assertReady?: (
        artifact: Artifact,
        actor: ImplementationActor,
      ) => Promise<void>;
      /** Best-effort invalidation AFTER commit. Durable events/snapshots remain authoritative. */
      notify?: (event: {
        projectId: string;
        artifactId: string;
        revision: number;
        editingLock: ImplementationEditingLock | null;
      }) => Promise<void>;
    },
  ) {}
  get store() {
    return this.options.store;
  }
  async initialize() {
    await this.store.tx(async () => {
      await this.store.lock('schema:studio.implementation');
      await this.store.db.exec(`
        CREATE TABLE IF NOT EXISTS implementation_heads(artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,revision BIGINT NOT NULL DEFAULT 0,active_run_id TEXT);
        CREATE TABLE IF NOT EXISTS implementation_graphs(artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,version BIGINT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(artifact_id,version));
        CREATE TABLE IF NOT EXISTS implementation_runs(id TEXT PRIMARY KEY,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,graph_version BIGINT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL,started_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS implementation_runs_artifact ON implementation_runs(artifact_id,started_at);
        CREATE TABLE IF NOT EXISTS implementation_events(artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,revision BIGINT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(artifact_id,revision));
        CREATE TABLE IF NOT EXISTS implementation_commands(run_id TEXT NOT NULL REFERENCES implementation_runs(id) ON DELETE CASCADE,key TEXT NOT NULL,actor_key TEXT NOT NULL,request_hash TEXT NOT NULL,response TEXT NOT NULL,PRIMARY KEY(run_id,key));
      `);
    });
    return this;
  }
  private async latest(id: string) {
    return decode<ImplementationGraph>(
      await this.store.one(
        'SELECT payload FROM implementation_graphs WHERE artifact_id=? ORDER BY version DESC LIMIT 1',
        id,
      ),
    );
  }
  private async run(id: string, artifactId: string) {
    return decode<ImplementationRun>(
      await this.store.one(
        'SELECT payload FROM implementation_runs WHERE id=? AND artifact_id=?',
        id,
        artifactId,
      ),
    );
  }
  private async saveGraph(graph: ImplementationGraph) {
    await this.store.exec(
      'INSERT INTO implementation_graphs(artifact_id,version,payload) VALUES(?,?,?) ON CONFLICT(artifact_id,version) DO UPDATE SET payload=excluded.payload',
      graph.artifactId,
      graph.graphVersion,
      encode(graph),
    );
  }
  private async saveRun(run: ImplementationRun) {
    await this.store.exec(
      'INSERT INTO implementation_runs(id,artifact_id,graph_version,status,payload,started_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload',
      run.id,
      run.artifactId,
      run.graphVersion,
      run.status,
      encode(run),
      run.startedAt,
    );
  }
  /** Safe for canParticipate/read projections. Mutations must call assertPlanEditable under their project lock. */
  async editingLock(id: string): Promise<ImplementationEditingLock | null> {
    const row = await this.store.one(
      'SELECT r.payload FROM implementation_heads h JOIN implementation_runs r ON r.id=h.active_run_id WHERE h.artifact_id=?',
      id,
    );
    const run = decode<ImplementationRun>(row);
    return run?.status === 'running'
      ? {
          runId: run.id,
          graphVersion: run.graphVersion,
          claimedBy: run.claimedBy,
          startedAt: run.startedAt,
        }
      : null;
  }
  /** Invoke inside the same project-locked transaction as EVERY source/decision mutation. */
  async assertPlanEditable(id: string) {
    if (!this.store.db.inTransaction())
      throw new Error(
        'Implementation write guards require the source transaction',
      );
    await this.store.lock('implementation:' + id);
    if (await this.editingLock(id))
      fail(
        'implementation-locked',
        'Request an implementation revision before changing this plan',
      );
  }
  private async context(
    user: User,
    id: string,
    write: boolean,
    allowArchived = false,
  ) {
    const artifact = await this.store.artifact(
      id,
      user.id,
      write && !allowArchived ? 'write' : 'read',
    );
    if (write && allowArchived)
      await this.store.role(artifact.projectId, user.id, 'write');
    if (!['design', 'document'].includes(artifact.kind))
      throw new HttpError(
        400,
        'Only design and document artifacts can own implementation graphs',
      );
    return artifact;
  }
  private async mutate<T>(
    actor: ImplementationActor,
    id: string,
    allowArchived: boolean,
    work: (artifact: Artifact, who: ImplementationAttribution) => Promise<T>,
  ): Promise<T> {
    if (this.store.db.inTransaction())
      throw new Error(
        'Graph commands must own their transaction so publication follows commit',
      );
    const who = attribution(actor);
    const initial = await this.context(actor.user, id, true, allowArchived);
    const result = await this.store.tx(async () => {
      await this.store.lock('project:' + initial.projectId);
      const artifact = await this.context(actor.user, id, true, allowArchived);
      await this.store.lock('implementation:' + id);
      await this.store.exec(
        'INSERT INTO implementation_heads(artifact_id,revision) VALUES(?,0) ON CONFLICT(artifact_id) DO NOTHING',
        id,
      );
      return work(artifact, who);
    });
    const head = await this.store.one(
      'SELECT revision FROM implementation_heads WHERE artifact_id=?',
      id,
    );
    // A missed transport notification never rolls back or misreports an accepted durable command.
    try {
      await this.options.notify?.({
        projectId: initial.projectId,
        artifactId: id,
        revision: Number(head?.revision ?? 0),
        editingLock: await this.editingLock(id),
      });
    } catch {}
    return result;
  }
  private async event(
    artifact: Artifact,
    actor: ImplementationAttribution,
    kind: ImplementationEvent['kind'],
    detail: Record<string, unknown>,
    runId?: string,
  ) {
    const head = await this.store.one(
      'UPDATE implementation_heads SET revision=revision+1 WHERE artifact_id=? RETURNING revision',
      artifact.id,
    );
    const event: ImplementationEvent = {
      revision: Number(head.revision),
      actor,
      kind,
      at: timestamp(),
      detail,
      ...(runId ? { runId } : {}),
    };
    await this.store.exec(
      'INSERT INTO implementation_events(artifact_id,revision,payload) VALUES(?,?,?)',
      artifact.id,
      event.revision,
      encode(event),
    );
    await this.store.audit(
      artifact.projectId,
      artifact.id,
      actor.name,
      'implementation.' + kind,
      encode({ revision: event.revision, runId, actorKey: actor.key }),
    );
  }
  async read(user: User, id: string): Promise<ImplementationSnapshot> {
    const initial = await this.context(user, id, false);
    return this.store.tx(async () => {
      await this.store.lock('project:' + initial.projectId);
      const artifact = await this.context(user, id, false);
      const project = await this.store.one(
        'SELECT repository FROM projects WHERE id=?',
        artifact.projectId,
      );
      const head = await this.store.one(
        'SELECT revision,active_run_id FROM implementation_heads WHERE artifact_id=?',
        id,
      );
      const versions = (
        await this.store.all(
          'SELECT payload FROM implementation_graphs WHERE artifact_id=? ORDER BY version DESC LIMIT 20',
          id,
        )
      ).map((row) => decode<ImplementationGraph>(row)!);
      const runs = (
        await this.store.all(
          'SELECT payload FROM implementation_runs WHERE artifact_id=? ORDER BY started_at DESC,id DESC LIMIT 20',
          id,
        )
      ).map((row) => decode<ImplementationRun>(row)!);
      return {
        artifactId: id,
        planRevision: artifact.version,
        repository: project.repository,
        revision: Number(head?.revision ?? 0),
        graph: versions[0] ?? null,
        activeRun: head?.active_run_id
          ? await this.run(head.active_run_id, id)
          : null,
        runs,
        versions,
        editingLock: await this.editingLock(id),
      };
    });
  }
  async history(
    user: User,
    id: string,
    options: { before?: number; limit?: number } = {},
  ): Promise<ImplementationEvent[]> {
    await this.context(user, id, false);
    const limit = options.limit ?? 50;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (options.before !== undefined &&
        (!Number.isSafeInteger(options.before) || options.before < 1))
    )
      throw new HttpError(400, 'Invalid implementation history cursor');
    return (
      await this.store.all(
        'SELECT payload FROM implementation_events WHERE artifact_id=? AND revision<? ORDER BY revision DESC LIMIT ?',
        id,
        options.before ?? Number.MAX_SAFE_INTEGER,
        limit,
      )
    ).map((row) => decode<ImplementationEvent>(row)!);
  }
  async edit(
    actor: ImplementationActor,
    id: string,
    input: unknown,
  ): Promise<ImplementationGraph> {
    const request = implementationEditSchema.parse(input);
    return this.mutate(actor, id, false, async (artifact, who) => {
      return this.editDraft(artifact, who, request);
    });
  }
  /** Atomic publication from a DurableJobContext.commit transaction. Caller owns outbox notification. */
  async editInTransaction(
    actor: ImplementationActor,
    id: string,
    input: unknown,
  ): Promise<ImplementationGraph> {
    if (!this.store.db.inTransaction())
      throw new Error(
        'Atomic graph publication requires an existing project transaction',
      );
    const request = implementationEditSchema.parse(input),
      who = attribution(actor);
    const initial = await this.context(actor.user, id, true);
    await this.store.lock('project:' + initial.projectId);
    const artifact = await this.context(actor.user, id, true);
    await this.store.lock('implementation:' + id);
    await this.store.exec(
      'INSERT INTO implementation_heads(artifact_id,revision) VALUES(?,0) ON CONFLICT(artifact_id) DO NOTHING',
      id,
    );
    return this.editDraft(artifact, who, request);
  }
  private async editDraft(
    artifact: Artifact,
    who: ImplementationAttribution,
    request: ReturnType<typeof implementationEditSchema.parse>,
  ): Promise<ImplementationGraph> {
    const id = artifact.id;
    await this.assertPlanEditable(id);
    const latest = await this.latest(id);
    checkPointer(latest, request.expected);
    if (artifact.version !== request.planRevision)
      fail(
        'plan-conflict',
        'Draft against the current canonical plan revision',
      );
    const at = timestamp();
    const graph: ImplementationGraph = {
      ...request,
      artifactId: id,
      graphVersion: latest
        ? latest.status === 'draft'
          ? latest.graphVersion
          : latest.graphVersion + 1
        : 1,
      draftRevision: latest?.status === 'draft' ? latest.draftRevision + 1 : 1,
      status: 'draft',
      authoredBy: who,
      createdAt: latest?.status === 'draft' ? latest.createdAt : at,
      updatedAt: at,
    };
    // The expected pointer is concurrency input, never part of the persisted graph.
    delete (graph as ImplementationGraph & { expected?: unknown }).expected;
    await this.saveGraph(graph);
    await this.event(artifact, who, 'draft_edited', {
      pointer: implementationPointer(graph),
      definition: graph.definition,
    });
    return graph;
  }
  async approve(
    actor: ImplementationActor,
    id: string,
    expectedInput: unknown,
  ): Promise<ImplementationGraph> {
    const expected = implementationPointerSchema.parse(expectedInput);
    if (actor.kind !== 'human')
      throw new HttpError(
        403,
        'Only a person can approve an implementation graph',
      );
    return this.mutate(actor, id, false, async (artifact, who) => {
      await this.assertPlanEditable(id);
      const graph = await this.latest(id);
      checkPointer(graph, expected);
      if (!graph || graph.status !== 'draft')
        fail('not-draft', 'Only the latest draft can be approved');
      if (artifact.version !== graph.planRevision)
        fail('plan-conflict', 'The source changed after the graph was drafted');
      await this.options.assertReady?.(artifact, actor);
      const previous = (
        await this.store.all(
          'SELECT payload FROM implementation_graphs WHERE artifact_id=? AND version<?',
          id,
          graph.graphVersion,
        )
      ).map((row) => decode<ImplementationGraph>(row)!);
      for (const old of previous)
        if (old.status === 'approved') {
          old.status = 'superseded';
          old.updatedAt = timestamp();
          await this.saveGraph(old);
        }
      graph.status = 'approved';
      graph.approvedBy = who;
      graph.approvedAt = graph.updatedAt = timestamp();
      await this.saveGraph(graph);
      await this.event(artifact, who, 'approved', {
        pointer: implementationPointer(graph),
      });
      return graph;
    });
  }
  async claim(
    actor: ImplementationActor,
    id: string,
    input: unknown,
  ): Promise<ImplementationRun> {
    const request = implementationClaimSchema.parse(input);
    return this.mutate(actor, id, false, async (artifact, who) => {
      await this.assertPlanEditable(id);
      const graph = await this.latest(id);
      checkPointer(graph, request.expected);
      if (!graph || graph.status !== 'approved')
        fail('not-approved', 'Approve the latest graph before claiming it');
      if (artifact.version !== graph.planRevision)
        fail('plan-conflict', 'The canonical plan changed after approval');
      if (
        await this.store.one(
          "SELECT id FROM implementation_runs WHERE artifact_id=? AND graph_version=? AND status IN ('implemented','delivered') LIMIT 1",
          id,
          graph.graphVersion,
        )
      )
        fail(
          'already-implemented',
          'This graph passed verification and cannot be claimed again',
        );
      const project = await this.store.one(
        'SELECT repository FROM projects WHERE id=?',
        artifact.projectId,
      );
      let requested: string, actual: string;
      try {
        requested = repositoryKey(request.repository);
        actual = repositoryKey(project.repository);
      } catch {
        throw new HttpError(
          400,
          'Select the project GitHub repository before claiming an implementation',
        );
      }
      if (actual !== requested)
        throw new HttpError(
          403,
          'The checkout repository does not match the project repository',
        );
      await this.options.assertReady?.(artifact, actor);
      const run: ImplementationRun = {
        id: randomUUID(),
        artifactId: id,
        ...implementationPointer(graph),
        status: 'running',
        checkout: {
          repository: 'https://github.com/' + actual,
          branch: request.branch,
          commit: request.commit,
        },
        claimedBy: who,
        startedAt: timestamp(),
        tasks: graph.definition.tasks.map((task) => ({
          taskId: task.id,
          status: 'queued',
          contributors: [],
        })),
      };
      graph.status = 'locked';
      graph.updatedAt = timestamp();
      await this.saveGraph(graph);
      await this.saveRun(run);
      await this.store.exec(
        'UPDATE implementation_heads SET active_run_id=? WHERE artifact_id=?',
        run.id,
        id,
      );
      await this.event(
        artifact,
        who,
        'claimed',
        { pointer: implementationPointer(graph), checkout: run.checkout },
        run.id,
      );
      return run;
    });
  }
  async report(
    actor: ImplementationActor,
    id: string,
    input: unknown,
  ): Promise<ImplementationRun> {
    const request = implementationReportSchema.parse(input);
    return this.mutate(actor, id, true, async (artifact, who) => {
      const run = await this.run(request.runId, id);
      if (!run) throw new HttpError(404, 'Implementation run not found');
      const requestHash = createHash('sha256')
        .update(canonical(request.command))
        .digest('hex');
      const previous = await this.store.one(
        'SELECT actor_key,request_hash,response FROM implementation_commands WHERE run_id=? AND key=?',
        run.id,
        request.idempotencyKey,
      );
      if (previous) {
        if (
          previous.actor_key !== who.key ||
          previous.request_hash !== requestHash
        )
          fail(
            'idempotency-conflict',
            'This key already identifies another lifecycle report',
          );
        return JSON.parse(previous.response) as ImplementationRun;
      }
      const graph = decode<ImplementationGraph>(
        await this.store.one(
          'SELECT payload FROM implementation_graphs WHERE artifact_id=? AND version=?',
          id,
          run.graphVersion,
        ),
      );
      if (!graph) throw new HttpError(404, 'Implementation graph not found');
      const head = await this.store.one(
        'SELECT active_run_id FROM implementation_heads WHERE artifact_id=?',
        id,
      );
      const terminalPrUpdate =
        request.command.kind === 'report_pr' &&
        ['implemented', 'delivered'].includes(run.status);
      if (
        !terminalPrUpdate &&
        (run.status !== 'running' ||
          head.active_run_id !== run.id ||
          graph.status !== 'locked')
      )
        fail(
          'run-not-active',
          'This report does not identify the active locked run',
        );
      this.transition(run, graph, request.command, who, terminalPrUpdate);
      if (run.status !== 'running' && !terminalPrUpdate) {
        graph.status = 'approved';
        graph.updatedAt = timestamp();
        await this.saveGraph(graph);
        await this.store.exec(
          'UPDATE implementation_heads SET active_run_id=NULL WHERE artifact_id=? AND active_run_id=?',
          id,
          run.id,
        );
      }
      await this.saveRun(run);
      await this.event(
        artifact,
        who,
        request.command.kind,
        request.command,
        run.id,
      );
      await this.store.exec(
        'INSERT INTO implementation_commands(run_id,key,actor_key,request_hash,response) VALUES(?,?,?,?,?)',
        run.id,
        request.idempotencyKey,
        who.key,
        requestHash,
        encode(run),
      );
      return run;
    });
  }
  private transition(
    run: ImplementationRun,
    graph: ImplementationGraph,
    command: ImplementationReport['command'],
    who: ImplementationAttribution,
    terminalPrUpdate: boolean,
  ) {
    const at = timestamp();
    if (command.kind === 'request_revision') {
      run.status = 'revision_requested';
      run.revisionReason = command.reason;
      run.finishedAt = at;
      return;
    }
    if (command.kind === 'report_verification') {
      if (
        run.claimedBy.key === who.key ||
        run.tasks.some((task) =>
          task.contributors.some((person) => person.key === who.key),
        )
      )
        throw new HttpError(
          403,
          'Verification requires an independent authenticated reviewer who did not implement this run',
        );
      if (run.tasks.some((task) => task.status !== 'complete'))
        fail(
          'incomplete-graph',
          'Every task must be complete before whole-graph verification',
        );
      const reports = command.verification.tasks;
      if (
        reports.length !== graph.definition.tasks.length ||
        new Set(reports.map((task) => task.taskId)).size !== reports.length
      )
        fail('verification-coverage', 'Review every task exactly once');
      const failed = new Set<string>();
      for (const task of graph.definition.tasks) {
        const result = reports.find((item) => item.taskId === task.id);
        if (
          !result ||
          result.criteria.length !== task.acceptanceCriteria.length ||
          new Set(result.criteria.map((item) => item.index)).size !==
            result.criteria.length ||
          result.criteria.some(
            (item) => item.index >= task.acceptanceCriteria.length,
          )
        )
          fail(
            'verification-coverage',
            'Evidence must address every acceptance criterion exactly once',
          );
        if (result.criteria.some((item) => !item.passed)) failed.add(task.id);
      }
      if (
        !failed.size &&
        run.tasks.some((task) => task.pullRequest?.state === 'closed')
      )
        fail(
          'pull-request-closed',
          'Passing verification requires open or merged pull requests',
        );
      // A changed prerequisite invalidates completed downstream work, too.
      let changed = true;
      while (changed) {
        changed = false;
        for (const edge of graph.definition.edges)
          if (failed.has(edge.from) && !failed.has(edge.to)) {
            failed.add(edge.to);
            changed = true;
          }
      }
      run.verification = {
        ...command.verification,
        passed: failed.size === 0,
        reviewedBy: who,
        reviewedAt: at,
        returnedTaskIds: [...failed],
      };
      for (const task of run.tasks)
        if (failed.has(task.taskId)) {
          task.status = 'queued';
          delete task.completedAt;
          delete task.summary;
          delete task.noChange;
          delete task.blocker;
        }
      if (!failed.size) {
        run.status =
          run.tasks.some((task) => task.pullRequest) &&
          run.tasks.every(
            (task) => !task.pullRequest || task.pullRequest.state === 'merged',
          )
            ? 'delivered'
            : 'implemented';
        run.finishedAt = at;
      }
      return;
    }
    const task = run.tasks.find((item) => item.taskId === command.taskId);
    if (!task) throw new HttpError(404, 'Implementation task not found');
    if (command.kind === 'report_pr' && task.noChange)
      fail('no-change', 'A no-change completion cannot acquire a pull request');
    if (command.kind === 'report_pr' && terminalPrUpdate) {
      if (!task.pullRequest || task.pullRequest.url !== command.pullRequest.url)
        fail(
          'verified-task-frozen',
          'A verified task may only update its recorded pull request state',
        );
      if (
        task.pullRequest.state === 'merged' &&
        command.pullRequest.state !== 'merged'
      )
        fail(
          'merged-pull-request',
          'A merged pull request cannot return to an earlier state',
        );
      task.pullRequest = {
        ...task.pullRequest,
        state: command.pullRequest.state,
      };
      run.status =
        run.tasks.some((item) => item.pullRequest) &&
        run.tasks.every(
          (item) => !item.pullRequest || item.pullRequest.state === 'merged',
        )
          ? 'delivered'
          : 'implemented';
      return;
    }
    if (task.status === 'complete' && command.kind !== 'report_pr')
      fail(
        'already-complete',
        'Verification must return a completed task to work before it changes',
      );
    const contribute = () => {
      if (!task.contributors.some((person) => person.key === who.key))
        task.contributors.push(who);
    };
    if (command.kind === 'start_task') {
      if (task.status === 'in_progress')
        fail('already-started', 'The task is already in progress');
      if (!dependencyReady(graph.definition, run.tasks, task.taskId))
        fail(
          'dependencies-incomplete',
          'Complete prerequisites before starting this task',
        );
      task.status = 'in_progress';
      task.startedAt ??= at;
      delete task.blocker;
      contribute();
      return;
    }
    if (command.kind === 'block_task') {
      task.status = 'blocked';
      task.startedAt ??= at;
      task.blocker = command.reason;
      contribute();
      return;
    }
    if (command.kind === 'report_pr') {
      if (!task.startedAt)
        fail(
          'task-not-started',
          'Start or block the task before reporting a pull request',
        );
      let url: URL;
      try {
        url = new URL(command.pullRequest.url);
      } catch {
        throw new HttpError(400, 'Invalid pull request URL');
      }
      const repo = new URL(run.checkout.repository).pathname;
      if (
        url.origin !== 'https://github.com' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !new RegExp(
          '^' +
            repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
            '/pull/[1-9][0-9]*$',
          'i',
        ).test(url.pathname)
      )
        throw new HttpError(
          400,
          'Pull requests must belong to the claimed repository',
        );
      if (task.pullRequest && task.pullRequest.url !== command.pullRequest.url)
        fail(
          'pull-request-already-recorded',
          'Update the existing task pull request rather than replacing its provenance',
        );
      if (
        task.pullRequest?.state === 'merged' &&
        command.pullRequest.state !== 'merged'
      )
        fail(
          'merged-pull-request',
          'A merged pull request cannot return to an earlier state',
        );
      task.pullRequest = command.pullRequest;
      contribute();
      return;
    }
    if (
      task.status !== 'in_progress' ||
      !dependencyReady(graph.definition, run.tasks, task.taskId)
    )
      fail(
        'task-not-ready',
        'Only dependency-ready work in progress can complete',
      );
    if (command.noChange && task.pullRequest)
      fail(
        'no-change-pull-request',
        'A task with a pull request cannot claim no change',
      );
    if (!command.noChange && !task.pullRequest)
      fail(
        'pull-request-required',
        'Record a pull request or provide no-change reason and evidence',
      );
    if (task.pullRequest?.state === 'closed')
      fail(
        'pull-request-closed',
        'A closed unmerged pull request cannot complete a task',
      );
    task.status = 'complete';
    task.completedAt = at;
    task.summary = command.summary;
    if (command.noChange) task.noChange = command.noChange;
    delete task.blocker;
    contribute();
  }
}
