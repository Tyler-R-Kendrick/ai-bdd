import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Store, HttpError, hash } from '../store.ts';
import type { Auth } from '../auth.ts';
import { ImplementationGraphs } from './implementation.ts';
import type { MachinePrincipal } from './investigations.ts';
import {
  implementationPointerSchema,
  implementationPointer,
  implementationClaimSchema,
  implementationReportSchema,
  type ImplementationEditingLock,
  type ImplementationActor,
  type ImplementationRun,
} from '../../shared/implementation.ts';
import type { User } from '../../shared/domain.ts';
const secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  id = z.string().uuid(),
  time = () => new Date().toISOString(),
  token = () => randomBytes(32).toString('base64url');
const sameRepository = (a: string, b: string) =>
  a
    .replace(/\.git$/, '')
    .replace(/\/$/, '')
    .toLowerCase() ===
  b
    .replace(/\.git$/, '')
    .replace(/\/$/, '')
    .toLowerCase();
export type ImplementationMachineDependencies = {
  store: Store;
  auth: Auth;
  machines: {
    authenticate(
      request: FastifyRequest,
      id: string,
    ): Promise<MachinePrincipal>;
  };
  graphs: ImplementationGraphs;
  otherWorkActive?: (machineId: string) => Promise<boolean>;
  authorizeMachine?: (machine: MachinePrincipal) => Promise<void>;
  notify?: (projectId: string, artifactId: string) => void;
};
/** The queue reserves an exact human-approved graph. Machine transport supplies actor identities, never request JSON. */
export class ImplementationMachines {
  readonly ready: Promise<void>;
  constructor(readonly dependencies: ImplementationMachineDependencies) {
    this.ready = this.initialize();
  }
  get store() {
    return this.dependencies.store;
  }
  get graphs() {
    return this.dependencies.graphs;
  }
  private async initialize() {
    await this.store.tx(async () => {
      await this.store.db.lock('schema:studio.implementation-machines');
      await this.store.db.exec(
        `CREATE TABLE IF NOT EXISTS studio_implementation_machine_queue(id TEXT PRIMARY KEY,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),machine_id TEXT NOT NULL,expected_json TEXT NOT NULL,source_json TEXT NOT NULL,source_sha256 TEXT NOT NULL,graph_json TEXT NOT NULL,repository TEXT NOT NULL,source_commit TEXT NOT NULL,branch TEXT NOT NULL,status TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 1,lease_hash TEXT,verifier_hash TEXT,lease_expires BIGINT,run_id TEXT REFERENCES implementation_runs(id),error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);CREATE INDEX IF NOT EXISTS studio_implementation_machine_active ON studio_implementation_machine_queue(artifact_id,status);CREATE INDEX IF NOT EXISTS studio_implementation_machine_owner ON studio_implementation_machine_queue(machine_id,user_id,status);`,
      );
    });
  }
  private async atomic<T>(projectId: string, work: () => Promise<T>) {
    await this.ready;
    return this.store.tx(async () => {
      await this.store.db.lock('project:' + projectId);
      return work();
    });
  }
  private async fresh(principal: MachinePrincipal) {
    const machine = await this.store.one(
      'SELECT * FROM studio_machines WHERE id=? AND project_id=? AND user_id=? AND token_hash=? AND expires>?',
      principal.id,
      principal.project_id,
      principal.user_id,
      principal.token_hash,
      Date.now(),
    );
    if (!machine)
      throw new HttpError(
        401,
        'This machine credential was revoked or expired',
      );
    await this.store.role(machine.project_id, machine.user_id, 'write');
    await this.dependencies.authorizeMachine?.(machine);
    return machine;
  }
  private async actor(
    row: any,
    kind: 'implementer' | 'verifier',
  ): Promise<ImplementationActor> {
    return {
      user: await this.store.publicUser(row.user_id),
      kind: 'agent',
      agentId: `machine:${row.machine_id}:${kind}:${row.id}`,
    };
  }
  private async publish(artifactId: string, projectId: string) {
    try {
      this.dependencies.notify?.(projectId, artifactId);
      const snapshot = await this.graphs.read(
        await this.store.publicUser(
          (
            await this.store.one(
              'SELECT user_id FROM studio_implementation_machine_queue WHERE artifact_id=? ORDER BY created_at DESC LIMIT 1',
              artifactId,
            )
          ).user_id,
        ),
        artifactId,
      );
      await this.graphs.options.notify?.({
        projectId,
        artifactId,
        revision: snapshot.revision,
        editingLock: snapshot.editingLock,
      });
    } catch {}
  }
  async editingLock(
    artifactId: string,
  ): Promise<ImplementationEditingLock | null> {
    await this.ready;
    const row = await this.store.one(
      "SELECT q.*,u.name FROM studio_implementation_machine_queue q JOIN users u ON u.id=q.user_id WHERE q.artifact_id=? AND q.status IN ('queued','launching') ORDER BY q.created_at LIMIT 1",
      artifactId,
    );
    if (!row) return null;
    return {
      runId: row.id,
      graphVersion: JSON.parse(row.expected_json).graphVersion,
      claimedBy: {
        userId: row.user_id,
        name: row.name,
        kind: 'human',
        key: JSON.stringify([row.user_id, 'human', null]),
      },
      startedAt: row.created_at,
    };
  }
  async activeOnMachine(machineId: string) {
    await this.ready;
    return !!(await this.store.one(
      "SELECT id FROM studio_implementation_machine_queue WHERE machine_id=? AND status IN ('launching','running') AND lease_expires>?",
      machineId,
      Date.now(),
    ));
  }
  async machines(user: User, artifactId: string) {
    await this.ready;
    const artifact = await this.store.artifact(artifactId, user.id);
    const rows = await this.store.all(
      'SELECT m.id,m.label,m.last_seen AS lastSeen,m.expires,c.branch,c.source_commit AS sourceCommit FROM studio_machines m JOIN studio_investigation_checkouts c ON c.machine_id=m.id WHERE m.project_id=? AND m.user_id=? ORDER BY m.last_seen DESC',
      artifact.projectId,
      user.id,
    );
    await this.store.role(artifact.projectId, user.id);
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      connected: row.expires > Date.now() && row.lastSeen > Date.now() - 90000,
      branch: row.branch,
      commit: row.sourceCommit,
    }));
  }
  async list(user: User, artifactId: string) {
    await this.ready;
    const artifact = await this.store.artifact(artifactId, user.id);
    const rows = await this.store.all(
      'SELECT id,status,run_id AS runId,error,created_at AS createdAt,updated_at AS updatedAt,user_id AS ownerId,machine_id AS machineId,source_commit AS sourceCommit FROM studio_implementation_machine_queue WHERE artifact_id=? ORDER BY created_at DESC LIMIT 100',
      artifactId,
    );
    await this.store.role(artifact.projectId, user.id);
    return rows.map((row) =>
      row.ownerId === user.id
        ? row
        : { ...row, machineId: undefined, sourceCommit: undefined },
    );
  }
  async queue(
    user: User,
    artifactId: string,
    input: {
      expected: z.infer<typeof implementationPointerSchema>;
      machineId?: string;
    },
  ) {
    await this.ready;
    const initial = await this.store.artifact(artifactId, user.id, 'write');
    const result = await this.atomic(initial.projectId, async () => {
      const artifact = await this.store.artifact(artifactId, user.id, 'write');
      await this.store.db.lock('implementation-machine:' + artifactId);
      if (
        await this.store.one(
          "SELECT id FROM studio_implementation_machine_queue WHERE artifact_id=? AND status IN ('queued','launching','running')",
          artifactId,
        )
      )
        throw new HttpError(
          409,
          'This document already has queued or running implementation work',
        );
      const snapshot = await this.graphs.read(user, artifactId);
      if (
        !snapshot.graph ||
        JSON.stringify(implementationPointer(snapshot.graph)) !==
          JSON.stringify(input.expected)
      )
        throw new HttpError(
          409,
          'The reviewed plan or graph changed; read it before queuing',
        );
      if (artifact.version !== input.expected.planRevision)
        throw new HttpError(
          409,
          'The canonical plan changed after the graph was drafted',
        );
      if (
        snapshot.runs.some(
          (run) =>
            run.graphVersion === snapshot.graph!.graphVersion &&
            ['implemented', 'delivered'].includes(run.status),
        )
      )
        throw new HttpError(
          409,
          'This graph already passed verification; draft a new graph for new work',
        );
      const machine = await this.store.one(
        'SELECT m.*,c.repository AS checkout_repository,c.source_commit,c.branch FROM studio_machines m JOIN studio_investigation_checkouts c ON c.machine_id=m.id WHERE m.project_id=? AND m.user_id=? AND m.expires>? AND m.last_seen>?' +
          (input.machineId ? ' AND m.id=?' : '') +
          ' ORDER BY m.last_seen DESC LIMIT 1',
        artifact.projectId,
        user.id,
        Date.now(),
        Date.now() - 90000,
        ...(input.machineId ? [input.machineId] : []),
      );
      if (!machine)
        throw new HttpError(
          409,
          'Connect your own machine and register its checkout before building',
        );
      if (!sameRepository(machine.checkout_repository, snapshot.repository))
        throw new HttpError(
          409,
          'The selected machine checkout does not match the project repository',
        );
      const queuedId = randomUUID(),
        branch = 'studio/build-' + queuedId,
        checkout = implementationClaimSchema.parse({
          expected: input.expected,
          repository: snapshot.repository,
          branch,
          commit: machine.source_commit,
        });
      let graph = snapshot.graph;
      if (graph.status === 'draft')
        graph = await this.graphs.approveInTransaction(
          { user, kind: 'human' },
          artifactId,
          input.expected,
        );
      if (graph.status !== 'approved')
        throw new HttpError(
          409,
          'Only a reviewed draft or approved graph can be queued',
        );
      const source = JSON.stringify(artifact.content),
        at = time();
      await this.store.exec(
        'INSERT INTO studio_implementation_machine_queue(id,artifact_id,project_id,user_id,machine_id,expected_json,source_json,source_sha256,graph_json,repository,source_commit,branch,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        queuedId,
        artifactId,
        artifact.projectId,
        user.id,
        machine.id,
        JSON.stringify(input.expected),
        source,
        hash(source),
        JSON.stringify(graph),
        checkout.repository,
        checkout.commit,
        checkout.branch,
        'queued',
        at,
        at,
      );
      await this.store.audit(
        artifact.projectId,
        artifactId,
        user.name,
        'implementation.machine.queued',
        queuedId,
      );
      return {
        id: queuedId,
        status: 'queued',
        machineId: machine.id,
        sourceCommit: checkout.commit,
      };
    });
    await this.publish(artifactId, initial.projectId);
    return result;
  }
  async expire() {
    await this.ready;
    const rows = await this.store.all(
      "SELECT q.* FROM studio_implementation_machine_queue q LEFT JOIN studio_machines m ON m.id=q.machine_id LEFT JOIN memberships member ON member.project_id=q.project_id AND member.user_id=q.user_id WHERE q.status IN ('queued','launching','running') AND (m.id IS NULL OR m.expires<? OR member.role IS NULL OR member.role='viewer' OR (q.status<>'queued' AND q.lease_expires<?)) LIMIT 50",
      Date.now(),
      Date.now(),
    );
    for (const initial of rows) {
      await this.atomic(initial.project_id, async () => {
        const row = await this.store.one(
          "SELECT * FROM studio_implementation_machine_queue WHERE id=? AND status IN ('queued','launching','running')",
          initial.id,
        );
        if (!row) return;
        const machine = await this.store.one(
            'SELECT id,expires FROM studio_machines WHERE id=?',
            row.machine_id,
          ),
          member = await this.store.one(
            'SELECT role FROM memberships WHERE project_id=? AND user_id=?',
            row.project_id,
            row.user_id,
          );
        if (
          machine &&
          machine.expires > Date.now() &&
          member &&
          member.role !== 'viewer' &&
          (row.status === 'queued' || row.lease_expires > Date.now())
        )
          return;
        if (row.run_id)
          await this.graphs.interruptInTransaction(
            row.artifact_id,
            row.run_id,
            'The connector lease ended or its owner lost access. Uncertain local execution is never replayed automatically.',
          );
        await this.store.exec(
          "UPDATE studio_implementation_machine_queue SET status='interrupted',generation=generation+1,lease_hash=NULL,verifier_hash=NULL,error='The local execution lease ended; review the retained checkout before explicitly queuing another attempt',updated_at=? WHERE id=?",
          time(),
          row.id,
        );
      });
      await this.publish(initial.artifact_id, initial.project_id);
    }
  }
  async claim(principal: MachinePrincipal) {
    await this.expire();
    return this.atomic(principal.project_id, async () => {
      const machine = await this.fresh(principal);
      await this.store.db.lock('machine:' + machine.id);
      if (
        (await this.activeOnMachine(machine.id)) ||
        (await this.dependencies.otherWorkActive?.(machine.id))
      )
        return { work: null };
      if (
        await this.store.one(
          "SELECT id FROM studio_machine_work WHERE machine_id=? AND status='running'",
          machine.id,
        )
      )
        return { work: null };
      const row = await this.store.one(
        "SELECT * FROM studio_implementation_machine_queue WHERE machine_id=? AND user_id=? AND project_id=? AND status='queued' ORDER BY created_at,id LIMIT 1",
        machine.id,
        machine.user_id,
        machine.project_id,
      );
      if (!row) return { work: null };
      const artifact = await this.store.artifact(
        row.artifact_id,
        machine.user_id,
        'write',
      );
      if (
        artifact.version !== JSON.parse(row.expected_json).planRevision ||
        hash(JSON.stringify(artifact.content)) !== row.source_sha256
      )
        throw new HttpError(
          409,
          'The sealed plan changed before the machine claimed it',
        );
      const leaseToken = token();
      await this.store.exec(
        "UPDATE studio_implementation_machine_queue SET status='launching',lease_hash=?,lease_expires=?,updated_at=? WHERE id=?",
        hash(leaseToken),
        Date.now() + 120000,
        time(),
        row.id,
      );
      return {
        work: {
          id: row.id,
          kind: 'implementation-graph',
          artifactId: row.artifact_id,
          generation: row.generation,
          repository: row.repository,
          sourceCommit: row.source_commit,
          branch: row.branch,
          expected: JSON.parse(row.expected_json),
          source: JSON.parse(row.source_json),
          sourceSha256: row.source_sha256,
          graph: JSON.parse(row.graph_json),
        },
        leaseToken,
      };
    });
  }
  private async leased(
    principal: MachinePrincipal,
    queueId: string,
    leaseToken: string,
    generation: number,
    allowCompleted = false,
  ) {
    await this.fresh(principal);
    const row = await this.store.one(
      "SELECT * FROM studio_implementation_machine_queue WHERE id=? AND machine_id=? AND user_id=? AND project_id=? AND generation=? AND lease_hash=? AND status IN ('launching','running'" +
        (allowCompleted ? ",'completed','revision_requested'" : '') +
        ')',
      queueId,
      principal.id,
      principal.user_id,
      principal.project_id,
      generation,
      hash(leaseToken),
    );
    if (
      !row ||
      (!['completed', 'revision_requested'].includes(row.status) &&
        row.lease_expires <= Date.now())
    )
      throw new HttpError(409, 'This machine implementation lease ended');
    return row;
  }
  async start(
    principal: MachinePrincipal,
    queueId: string,
    input: {
      leaseToken: string;
      generation: number;
      checkout: z.infer<typeof implementationClaimSchema>;
    },
  ) {
    const result = await this.atomic(principal.project_id, async () => {
      const row = await this.leased(
        principal,
        queueId,
        input.leaseToken,
        input.generation,
      );
      if (row.run_id)
        return (
          await this.graphs.read(
            await this.store.publicUser(row.user_id),
            row.artifact_id,
          )
        ).runs.find((run) => run.id === row.run_id)!;
      const expected = JSON.parse(row.expected_json),
        checkout = implementationClaimSchema.parse(input.checkout);
      if (
        JSON.stringify(checkout.expected) !== JSON.stringify(expected) ||
        !sameRepository(checkout.repository, row.repository) ||
        checkout.commit !== row.source_commit ||
        checkout.branch !== row.branch
      )
        throw new HttpError(
          409,
          'The local worktree does not match the sealed implementation checkout',
        );
      await this.store.exec(
        "UPDATE studio_implementation_machine_queue SET status='claiming' WHERE id=?",
        queueId,
      );
      const run = await this.graphs.claimInTransaction(
        await this.actor(row, 'implementer'),
        row.artifact_id,
        checkout,
      );
      await this.store.exec(
        "UPDATE studio_implementation_machine_queue SET status='running',run_id=?,updated_at=? WHERE id=?",
        run.id,
        time(),
        queueId,
      );
      return run;
    });
    const row = await this.store.one(
      'SELECT artifact_id,project_id FROM studio_implementation_machine_queue WHERE id=?',
      queueId,
    );
    await this.publish(row.artifact_id, row.project_id);
    return result;
  }
  async read(
    principal: MachinePrincipal,
    queueId: string,
    input: { leaseToken: string; generation: number },
  ) {
    return this.atomic(principal.project_id, async () => {
      const row = await this.leased(
        principal,
        queueId,
        input.leaseToken,
        input.generation,
        true,
      );
      return {
        queueId: row.id,
        runId: row.run_id,
        status: row.status,
        source: JSON.parse(row.source_json),
        sourceSha256: row.source_sha256,
        snapshot: await this.graphs.read(
          await this.store.publicUser(row.user_id),
          row.artifact_id,
        ),
      };
    });
  }
  async heartbeat(
    principal: MachinePrincipal,
    queueId: string,
    input: { leaseToken: string; generation: number },
  ) {
    return this.atomic(principal.project_id, async () => {
      const row = await this.leased(
        principal,
        queueId,
        input.leaseToken,
        input.generation,
      );
      await this.store.exec(
        'UPDATE studio_implementation_machine_queue SET lease_expires=?,updated_at=? WHERE id=?',
        Date.now() + 120000,
        time(),
        row.id,
      );
      await this.store.exec(
        'UPDATE studio_machines SET last_seen=? WHERE id=?',
        Date.now(),
        principal.id,
      );
      return { leaseActive: true };
    });
  }
  async verifier(
    principal: MachinePrincipal,
    queueId: string,
    input: { leaseToken: string; generation: number },
  ) {
    return this.atomic(principal.project_id, async () => {
      const row = await this.leased(
        principal,
        queueId,
        input.leaseToken,
        input.generation,
      );
      if (!row.run_id)
        throw new HttpError(409, 'The graph has not been claimed');
      const run = (
        await this.graphs.read(
          await this.store.publicUser(row.user_id),
          row.artifact_id,
        )
      ).runs.find((run) => run.id === row.run_id)!;
      if (
        run.status !== 'running' ||
        run.tasks.some((task) => task.status !== 'complete')
      )
        throw new HttpError(
          409,
          'Complete every task before starting the independent verification session',
        );
      const verifierToken = token();
      await this.store.exec(
        'UPDATE studio_implementation_machine_queue SET verifier_hash=?,updated_at=? WHERE id=?',
        hash(verifierToken),
        time(),
        queueId,
      );
      return { verifierToken, runId: row.run_id };
    });
  }
  async report(
    principal: MachinePrincipal,
    queueId: string,
    input: {
      leaseToken: string;
      generation: number;
      verifierToken?: string;
      report: z.infer<typeof implementationReportSchema>;
    },
  ) {
    const output = await this.atomic(principal.project_id, async () => {
      const row = await this.leased(
          principal,
          queueId,
          input.leaseToken,
          input.generation,
          true,
        ),
        report = implementationReportSchema.parse(input.report);
      if (!row.run_id || report.runId !== row.run_id)
        throw new HttpError(
          403,
          'This scoped connector cannot report another run',
        );
      const verifies = report.command.kind === 'report_verification';
      if (
        verifies &&
        (!input.verifierToken ||
          hash(input.verifierToken) !== row.verifier_hash)
      )
        throw new HttpError(
          403,
          'Verification requires the separate verifier session credential',
        );
      if (!verifies && input.verifierToken)
        throw new HttpError(
          403,
          'The verifier credential cannot mutate implementation tasks',
        );
      const run = await this.graphs.reportInTransaction(
        await this.actor(row, verifies ? 'verifier' : 'implementer'),
        row.artifact_id,
        report,
      );
      const completed = [
        'implemented',
        'delivered',
        'revision_requested',
      ].includes(run.status);
      if (completed)
        await this.store.exec(
          'UPDATE studio_implementation_machine_queue SET status=?,updated_at=? WHERE id=?',
          run.status === 'revision_requested'
            ? 'revision_requested'
            : 'completed',
          time(),
          queueId,
        );
      return { run, artifactId: row.artifact_id, projectId: row.project_id };
    });
    await this.publish(output.artifactId, output.projectId);
    return output.run;
  }
  async stop(
    principal: MachinePrincipal,
    queueId: string,
    input: { leaseToken: string; generation: number; reason: string },
  ) {
    const row = await this.atomic(principal.project_id, async () => {
      const row = await this.leased(
        principal,
        queueId,
        input.leaseToken,
        input.generation,
        true,
      );
      if (['completed', 'revision_requested'].includes(row.status)) return row;
      if (row.run_id)
        await this.graphs.interruptInTransaction(
          row.artifact_id,
          row.run_id,
          input.reason,
        );
      await this.store.exec(
        "UPDATE studio_implementation_machine_queue SET status='interrupted',generation=generation+1,lease_hash=NULL,verifier_hash=NULL,error=?,updated_at=? WHERE id=?",
        input.reason,
        time(),
        row.id,
      );
      return row;
    });
    await this.publish(row.artifact_id, row.project_id);
    return { ok: true };
  }
  async cancel(user: User, artifactId: string, queueId: string) {
    const artifact = await this.store.artifact(artifactId, user.id, 'write');
    await this.atomic(artifact.projectId, async () => {
      const row = await this.store.one(
        "SELECT * FROM studio_implementation_machine_queue WHERE id=? AND artifact_id=? AND user_id=? AND status IN ('queued','launching','running')",
        queueId,
        artifactId,
        user.id,
      );
      if (!row)
        throw new HttpError(
          404,
          'Your active implementation queue entry was not found',
        );
      if (row.run_id)
        await this.graphs.reportInTransaction(
          { user, kind: 'human' },
          artifactId,
          {
            runId: row.run_id,
            idempotencyKey: 'human-cancel:' + row.generation,
            command: {
              kind: 'request_revision',
              reason:
                'The person who queued this local implementation stopped it. Review the retained checkout before retrying.',
            },
          },
        );
      await this.store.exec(
        "UPDATE studio_implementation_machine_queue SET status='cancelled',generation=generation+1,lease_hash=NULL,verifier_hash=NULL,updated_at=? WHERE id=?",
        time(),
        queueId,
      );
    });
    await this.publish(artifactId, artifact.projectId);
    return { ok: true };
  }
}
export async function registerImplementationMachineRoutes(
  app: FastifyInstance,
  dependencies: ImplementationMachineDependencies,
) {
  const service = new ImplementationMachines(dependencies);
  await service.ready;
  const machine = async (request: FastifyRequest, machineId: string) =>
    dependencies.machines.authenticate(request, id.parse(machineId));
  const browser = async (request: FastifyRequest) => {
    await dependencies.auth.assertOrigin(request);
    return dependencies.auth.user(request);
  };
  const lease = z
    .object({ leaseToken: secret, generation: z.number().int().positive() })
    .strict();
  app.post<{ Params: { id: string } }>(
    '/api/artifacts/:id/implementation/queue',
    async (request) =>
      service.queue(
        await browser(request),
        id.parse(request.params.id),
        z
          .object({
            expected: implementationPointerSchema,
            machineId: id.optional(),
          })
          .strict()
          .parse(request.body),
      ),
  );
  app.get<{ Params: { id: string } }>(
    '/api/artifacts/:id/implementation/machines',
    async (request) =>
      service.machines(
        await dependencies.auth.user(request),
        id.parse(request.params.id),
      ),
  );
  app.get<{ Params: { id: string } }>(
    '/api/artifacts/:id/implementation/machine-queue',
    async (request) =>
      service.list(
        await dependencies.auth.user(request),
        id.parse(request.params.id),
      ),
  );
  app.post<{ Params: { id: string; queueId: string } }>(
    '/api/artifacts/:id/implementation/machine-queue/:queueId/cancel',
    async (request) =>
      service.cancel(
        await browser(request),
        id.parse(request.params.id),
        id.parse(request.params.queueId),
      ),
  );
  app.post<{ Params: { machineId: string } }>(
    '/api/machines/:machineId/implementation/claim',
    async (request) =>
      service.claim(await machine(request, request.params.machineId)),
  );
  for (const action of ['read', 'heartbeat', 'verifier'] as const)
    app.post<{ Params: { machineId: string; queueId: string } }>(
      `/api/machines/:machineId/implementation/:queueId/${action}`,
      async (request) =>
        service[action](
          await machine(request, request.params.machineId),
          id.parse(request.params.queueId),
          lease.parse(request.body),
        ),
    );
  app.post<{ Params: { machineId: string; queueId: string } }>(
    '/api/machines/:machineId/implementation/:queueId/start',
    async (request) =>
      service.start(
        await machine(request, request.params.machineId),
        id.parse(request.params.queueId),
        lease
          .extend({ checkout: implementationClaimSchema })
          .strict()
          .parse(request.body),
      ),
  );
  app.post<{ Params: { machineId: string; queueId: string } }>(
    '/api/machines/:machineId/implementation/:queueId/report',
    async (request) =>
      service.report(
        await machine(request, request.params.machineId),
        id.parse(request.params.queueId),
        lease
          .extend({
            verifierToken: secret.optional(),
            report: implementationReportSchema,
          })
          .strict()
          .parse(request.body),
      ),
  );
  app.post<{ Params: { machineId: string; queueId: string } }>(
    '/api/machines/:machineId/implementation/:queueId/stop',
    async (request) =>
      service.stop(
        await machine(request, request.params.machineId),
        id.parse(request.params.queueId),
        lease
          .extend({ reason: z.string().trim().min(1).max(2000) })
          .strict()
          .parse(request.body),
      ),
  );
  return service;
}
