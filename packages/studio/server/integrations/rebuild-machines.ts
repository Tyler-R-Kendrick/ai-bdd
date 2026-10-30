import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError, hash, type Store } from '../store.ts';
import type { Auth } from '../auth.ts';
import type { Artifact, User } from '../../shared/domain.ts';
import {
  implementationClaimSchema,
  type ImplementationGraph,
  type ImplementationRun,
} from '../../shared/implementation.ts';
import {
  changedDocumentBlocks,
  rebuildLeaseSchema,
  rebuildRuntimeSchema,
  rebuildReportSchema,
  type RebuildPullRequest,
} from '../../shared/rebuild.ts';
import {
  agentProfileSchema,
  type AgentProfile,
} from '../../shared/agent-profile.ts';
import type { MachinePrincipal } from './investigations.ts';
import { readPlanSource } from '../plan-source.ts';
import type { ImplementationGraphs } from './implementation.ts';
const at = () => new Date().toISOString(),
  opaque = () => randomBytes(32).toString('base64url');
const sameRepo = (a: string, b: string) =>
  a
    .replace(/\.git$/, '')
    .replace(/\/$/, '')
    .toLowerCase() ===
  b
    .replace(/\.git$/, '')
    .replace(/\/$/, '')
    .toLowerCase();
export type RebuildDependencies = {
  store: Store;
  auth: Auth;
  graphs: ImplementationGraphs;
  machines: {
    authenticate(
      request: FastifyRequest,
      id: string,
    ): Promise<MachinePrincipal>;
  };
  authorizeMachine?: (machine: MachinePrincipal) => Promise<void>;
  otherWorkActive?: (machineId: string) => Promise<boolean>;
  assertReady: (artifact: Artifact, user: User) => Promise<void>;
  /** SQL-only audit snapshot; the connected ACP execution runtime is recorded separately. */
  captureAuthoringProfile?: (
    user: User,
    artifactId: string,
  ) => Promise<AgentProfile>;
  /** Must query the authenticated user's repository adapter; never trust submitted PR branches. */
  resolvePullRequest: (
    user: User,
    repository: string,
    url: string,
    signal: AbortSignal,
  ) => Promise<
    RebuildPullRequest & {
      state: string;
      repository: string;
    }
  >;
  notify?: (projectId: string, artifactId: string) => void;
  settleMs?: number;
};
/** Persisted living-document lifecycle; model completeness advice never enters admission. */
export class RebuildMachines {
  readonly ready: Promise<void>;
  constructor(readonly dependencies: RebuildDependencies) {
    this.ready = this.initialize();
  }
  get store() {
    return this.dependencies.store;
  }
  private async initialize() {
    await this.store.tx(async () => {
      await this.store.lock('schema:studio.rebuilds');
      await this.store.db.exec(`
CREATE TABLE IF NOT EXISTS studio_rebuild_baselines(artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),machine_id TEXT NOT NULL,run_id TEXT NOT NULL REFERENCES implementation_runs(id),repository TEXT NOT NULL,source_json TEXT NOT NULL,source_sha256 TEXT NOT NULL,source_version BIGINT NOT NULL,graph_json TEXT NOT NULL,prs_json TEXT NOT NULL,revision BIGINT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS studio_rebuild_consent(machine_id TEXT PRIMARY KEY REFERENCES studio_machines(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),repository TEXT NOT NULL,enabled INTEGER NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS studio_rebuild_pending(artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,writer_id TEXT NOT NULL REFERENCES users(id),source_sha256 TEXT NOT NULL,due_at BIGINT NOT NULL,error TEXT);
CREATE TABLE IF NOT EXISTS studio_rebuild_runs(id TEXT PRIMARY KEY,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),machine_id TEXT NOT NULL,baseline_revision BIGINT NOT NULL,base_run_id TEXT NOT NULL,repository TEXT NOT NULL,before_json TEXT NOT NULL,source_json TEXT NOT NULL,source_sha256 TEXT NOT NULL,source_version BIGINT NOT NULL,graph_json TEXT NOT NULL,prs_json TEXT NOT NULL,automatic INTEGER NOT NULL,status TEXT NOT NULL,generation INTEGER NOT NULL,lease_hash TEXT,verifier_hash TEXT,lease_expires BIGINT,execution_started INTEGER NOT NULL DEFAULT 0,report_json TEXT,report_hash TEXT,verification_json TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS studio_rebuild_execution_receipts(rebuild_id TEXT PRIMARY KEY REFERENCES studio_rebuild_runs(id) ON DELETE CASCADE,authoring_profile_json TEXT,runtime_json TEXT);
CREATE INDEX IF NOT EXISTS studio_rebuild_active ON studio_rebuild_runs(artifact_id,status);
CREATE INDEX IF NOT EXISTS studio_rebuild_machine ON studio_rebuild_runs(machine_id,status);
`);
      if (this.store.db.dialect === 'postgres')
        await this.store.exec(
          'ALTER TABLE studio_rebuild_pending ADD COLUMN IF NOT EXISTS error TEXT',
        );
      else if (
        !(
          await this.store.all('PRAGMA table_info(studio_rebuild_pending)')
        ).some((column) => column.name === 'error')
      )
        await this.store.exec(
          'ALTER TABLE studio_rebuild_pending ADD COLUMN error TEXT',
        );
    });
  }
  private async atomic<T>(projectId: string, work: () => Promise<T>) {
    await this.ready;
    return this.store.tx(async () => {
      await this.store.lock('project:' + projectId);
      return work();
    });
  }
  private async context(user: User, artifactId: string, write = true) {
    const artifact = await this.store.artifact(
      artifactId,
      user.id,
      write ? 'write' : 'read',
    );
    if (!['design', 'document'].includes(artifact.kind))
      throw new HttpError(
        400,
        'Only design and document artifacts can be rebuilt',
      );
    if (
      await this.store.one(
        'SELECT id FROM studio_investigations WHERE child_artifact_id=?',
        artifactId,
      )
    )
      throw new HttpError(
        409,
        'An investigation child cannot start implementation rebuilds',
      );
    return artifact;
  }
  private boundedSource(content: Record<string, any>) {
    const value = JSON.stringify(content);
    if (Buffer.byteLength(value) > 1024 * 1024)
      throw new HttpError(413, 'Rebuild source exceeds 1 MiB');
    return value;
  }
  /** SQL-only capture from a completed, independently verified browser implementation. Safe in sourceObserver. */
  async captureDelivered(artifactId: string) {
    await this.ready;
    const existing = await this.store.one(
      'SELECT run_id,updated_at FROM studio_rebuild_baselines WHERE artifact_id=?',
      artifactId,
    );
    const row = await this.store.one(
      "SELECT q.*,r.payload AS run_json FROM studio_implementation_machine_queue q JOIN implementation_runs r ON r.id=q.run_id WHERE q.artifact_id=? AND q.status='completed' AND r.status IN ('implemented','delivered') ORDER BY q.created_at DESC LIMIT 1",
      artifactId,
    );
    if (
      !row ||
      (existing &&
        (existing.run_id === row.run_id ||
          existing.updated_at >= row.updated_at))
    )
      return;
    const run = JSON.parse(row.run_json) as ImplementationRun,
      graph = JSON.parse(row.graph_json) as ImplementationGraph;
    if (
      !run.verification?.passed ||
      run.verification.reviewedBy.key === run.claimedBy.key
    )
      return;
    const urls = [
      ...new Set(
        run.tasks
          .map((task) => task.pullRequest?.url)
          .filter((url): url is string => !!url),
      ),
    ];
    if (
      !urls.length ||
      urls.length > 20 ||
      run.tasks.some(
        (task) => task.pullRequest && task.pullRequest.state !== 'open',
      )
    )
      return;
    if (Buffer.byteLength(row.source_json) > 1024 * 1024) return;
    if (hash(row.source_json) !== row.source_sha256)
      throw new HttpError(
        409,
        'The delivered source snapshot failed its digest check',
      );
    await this.store.exec(
      'INSERT INTO studio_rebuild_baselines(artifact_id,project_id,user_id,machine_id,run_id,repository,source_json,source_sha256,source_version,graph_json,prs_json,revision,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(artifact_id) DO UPDATE SET user_id=excluded.user_id,machine_id=excluded.machine_id,run_id=excluded.run_id,repository=excluded.repository,source_json=excluded.source_json,source_sha256=excluded.source_sha256,source_version=excluded.source_version,graph_json=excluded.graph_json,prs_json=excluded.prs_json,revision=studio_rebuild_baselines.revision+1,updated_at=excluded.updated_at',
      artifactId,
      row.project_id,
      row.user_id,
      row.machine_id,
      row.run_id,
      row.repository,
      row.source_json,
      row.source_sha256,
      graph.planRevision,
      row.graph_json,
      JSON.stringify(urls),
      1,
      at(),
    );
  }
  async observe(user: User, _previous: Artifact, current: Artifact) {
    if (!['design', 'document'].includes(current.kind)) return;
    if (!this.store.db.inTransaction())
      throw new Error(
        'Living document observation requires the canonical source transaction',
      );
    await this.store.role(current.projectId, user.id, 'write');
    await this.captureDelivered(current.id);
    const baseline = await this.store.one(
      'SELECT source_sha256 FROM studio_rebuild_baselines WHERE artifact_id=?',
      current.id,
    );
    if (!baseline) return;
    const source = JSON.stringify(await readPlanSource(this.store, current));
    if (hash(source) === baseline.source_sha256) {
      await this.store.exec(
        'DELETE FROM studio_rebuild_pending WHERE artifact_id=?',
        current.id,
      );
      return;
    }
    await this.store.exec(
      'INSERT INTO studio_rebuild_pending(artifact_id,project_id,writer_id,source_sha256,due_at) VALUES(?,?,?,?,?) ON CONFLICT(artifact_id) DO UPDATE SET writer_id=excluded.writer_id,source_sha256=excluded.source_sha256,due_at=excluded.due_at,error=NULL',
      current.id,
      current.projectId,
      user.id,
      hash(source),
      Date.now() + (this.dependencies.settleMs ?? 5000),
    );
  }
  async consent(user: User, machineId: string, enabled: boolean) {
    await this.ready;
    const initial = await this.store.one(
      'SELECT * FROM studio_machines WHERE id=? AND user_id=?',
      machineId,
      user.id,
    );
    if (!initial) throw new HttpError(404, 'Your machine was not found');
    // Renew external entitlement before the locked SQL-only permission recheck.
    await this.store.role(initial.project_id, user.id, 'write');
    return this.atomic(initial.project_id, async () => {
      await this.store.role(initial.project_id, user.id, 'write');
      const machine = await this.fresh(initial),
        checkout = await this.store.one(
          'SELECT repository FROM studio_investigation_checkouts WHERE machine_id=?',
          machineId,
        );
      if (!checkout)
        throw new HttpError(
          409,
          'Register this machine checkout before granting automatic-build consent',
        );
      await this.store.exec(
        'INSERT INTO studio_rebuild_consent(machine_id,user_id,repository,enabled,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(machine_id) DO UPDATE SET repository=excluded.repository,enabled=excluded.enabled,updated_at=excluded.updated_at',
        machine.id,
        user.id,
        checkout.repository,
        enabled ? 1 : 0,
        at(),
      );
      if (enabled)
        await this.store.exec(
          'UPDATE studio_rebuild_pending SET due_at=?,error=NULL WHERE artifact_id IN (SELECT artifact_id FROM studio_rebuild_baselines WHERE machine_id=? AND user_id=?)',
          Date.now(),
          machineId,
          user.id,
        );
      if (!enabled)
        await this.store.exec(
          "UPDATE studio_rebuild_runs SET status='cancelled',generation=generation+1,lease_hash=NULL,verifier_hash=NULL,error='Automatic rebuild consent was revoked',updated_at=? WHERE machine_id=? AND automatic=1 AND status IN ('queued','running')",
          at(),
          machineId,
        );
      await this.store.audit(
        initial.project_id,
        null,
        user.name,
        'implementation.rebuild.consent',
        JSON.stringify({ machineId, repository: checkout.repository, enabled }),
      );
      return { enabled, repository: checkout.repository };
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
      throw new HttpError(401, 'This machine was revoked or expired');
    await this.store.role(machine.project_id, machine.user_id, 'write');
    await this.dependencies.authorizeMachine?.(machine);
    const registration = await this.store.one(
      'SELECT p.repository AS project_repository,c.repository AS checkout_repository FROM projects p JOIN studio_investigation_checkouts c ON c.machine_id=? WHERE p.id=?',
      machine.id,
      machine.project_id,
    );
    if (
      !registration ||
      !sameRepo(
        registration.project_repository ?? '',
        registration.checkout_repository,
      )
    )
      throw new HttpError(
        409,
        'The machine checkout no longer matches the current project repository',
      );
    return machine;
  }
  private async resolvePR(
    user: User,
    repository: string,
    url: string,
    signal: AbortSignal,
  ) {
    try {
      signal.throwIfAborted();
      const result = await this.dependencies.resolvePullRequest(
        user,
        repository,
        url,
        signal,
      );
      signal.throwIfAborted();
      return z
        .object({
          url: z.string().url().max(500),
          repository: z.string().url().max(300),
          state: z.enum(['open', 'closed', 'merged']),
          branch: implementationClaimSchema.shape.branch,
          commit: implementationClaimSchema.shape.commit,
        })
        .parse(result);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        502,
        'The existing PR could not be verified; retry after repository access is restored',
      );
    }
  }
  private async automaticConsent(
    machineId: string,
    userId: string,
    repository: string,
  ) {
    const row = await this.store.one(
      'SELECT * FROM studio_rebuild_consent WHERE machine_id=? AND user_id=? AND enabled=1',
      machineId,
      userId,
    );
    if (!row || !sameRepo(row.repository, repository))
      throw new HttpError(
        409,
        'This machine has not consented to automatic rebuilds for this repository',
      );
  }
  async snapshot(user: User, artifactId: string) {
    const artifact = await this.context(user, artifactId, false);
    return this.atomic(artifact.projectId, async () => {
      await this.store.role(artifact.projectId, user.id);
      await this.captureDelivered(artifactId);
      const baseline = await this.store.one(
        'SELECT * FROM studio_rebuild_baselines WHERE artifact_id=?',
        artifactId,
      );
      const runs = await this.store.all(
        'SELECT id,status,automatic,error,source_version AS sourceVersion,created_at AS createdAt,updated_at AS updatedAt,user_id AS ownerId,machine_id AS machineId FROM studio_rebuild_runs WHERE artifact_id=? ORDER BY created_at DESC LIMIT 100',
        artifactId,
      );
      const current = await this.context(user, artifactId, false),
        canonicalSource = await readPlanSource(this.store, current);
      const consent =
        baseline?.user_id === user.id
          ? await this.store.one(
              'SELECT enabled FROM studio_rebuild_consent WHERE machine_id=? AND user_id=? AND repository=?',
              baseline.machine_id,
              user.id,
              baseline.repository,
            )
          : null;
      const pending = await this.store.one(
        'SELECT due_at AS dueAt,error FROM studio_rebuild_pending WHERE artifact_id=?',
        artifactId,
      );
      return {
        pending: pending ?? null,
        automaticEnabled: !!consent?.enabled,
        currentSourceVersion: current.version,
        currentSourceSha256: hash(JSON.stringify(canonicalSource)),
        baseline: baseline
          ? {
              revision: Number(baseline.revision),
              sourceVersion: Number(baseline.source_version),
              sourceSha256: baseline.source_sha256,
              baseRunId: baseline.run_id,
              updatedAt: baseline.updated_at,
              ...(baseline.user_id === user.id
                ? { machineId: baseline.machine_id }
                : {}),
            }
          : null,
        changes: baseline
          ? changedDocumentBlocks(
              JSON.parse(baseline.source_json),
              canonicalSource,
            )
          : 0,
        runs: runs.map((row) =>
          row.ownerId === user.id ? row : { ...row, machineId: undefined },
        ),
      };
    });
  }
  async queue(
    user: User,
    artifactId: string,
    input: {
      machineId?: string;
      expectedSourceSha256: string;
    },
    automatic = false,
  ) {
    let artifact = await this.context(user, artifactId),
      source = '';
    const prepared = await this.atomic(artifact.projectId, async () => {
      artifact = await this.context(user, artifactId);
      source = this.boundedSource(await readPlanSource(this.store, artifact));
      if (hash(source) !== input.expectedSourceSha256)
        throw new HttpError(
          409,
          'The canonical plan or accepted choices changed; review the latest source before rebuilding',
        );
      await this.captureDelivered(artifactId);
      const baseline = await this.store.one(
        'SELECT * FROM studio_rebuild_baselines WHERE artifact_id=?',
        artifactId,
      );
      if (!baseline)
        throw new HttpError(
          409,
          'A completed independently verified build with an open PR is required',
        );
      if (baseline.source_sha256 === hash(source))
        throw new HttpError(409, 'The document has no changes to rebuild');
      if (await this.dependencies.graphs.editingLock(artifactId))
        throw new HttpError(409, 'Implementation work is already active');
      const existing = await this.store.one(
        "SELECT id FROM studio_rebuild_runs WHERE artifact_id=? AND status IN ('queued','running')",
        artifactId,
      );
      if (existing) return { existing: existing.id };
      await this.dependencies.assertReady(artifact, user);
      const project = await this.store.one(
        'SELECT repository FROM projects WHERE id=?',
        artifact.projectId,
      );
      if (!sameRepo(project.repository ?? '', baseline.repository))
        throw new HttpError(
          409,
          'The delivered repository changed; make a fresh reviewed build',
        );
      if (automatic && baseline.user_id !== user.id)
        throw new HttpError(
          403,
          'Only the original builder may dispatch automatic rebuilds',
        );
      const machine = await this.store.one(
        'SELECT m.*,c.repository AS checkout_repository FROM studio_machines m JOIN studio_investigation_checkouts c ON c.machine_id=m.id WHERE m.project_id=? AND m.user_id=? AND m.id=? AND m.expires>? AND m.last_seen>?',
        artifact.projectId,
        user.id,
        input.machineId ?? baseline.machine_id,
        Date.now(),
        Date.now() - 90000,
      );
      if (
        !machine ||
        !sameRepo(machine.checkout_repository, baseline.repository)
      )
        throw new HttpError(
          409,
          'Connect your own machine for the delivered repository',
        );
      await this.fresh(machine);
      if (automatic)
        await this.automaticConsent(machine.id, user.id, baseline.repository);
      return { baseline, machine };
    });
    if ('existing' in prepared)
      return { id: prepared.existing, existing: true };
    // Network reads never hold SQL transactions. Final transaction checks every snapshot again.
    const signal = AbortSignal.timeout(15000),
      prs: RebuildPullRequest[] = [];
    for (const url of JSON.parse(prepared.baseline.prs_json) as string[]) {
      const pr = await this.resolvePR(
        user,
        prepared.baseline.repository,
        url,
        signal,
      );
      if (
        pr.url !== url ||
        pr.state !== 'open' ||
        !sameRepo(pr.repository, prepared.baseline.repository) ||
        !/^[a-f0-9]{40}$/.test(pr.commit) ||
        !implementationClaimSchema.shape.branch.safeParse(pr.branch).success
      )
        throw new HttpError(
          409,
          'Every existing PR must be open on the same repository with a verified head branch',
        );
      prs.push({ url, branch: pr.branch, commit: pr.commit });
    }
    return this.atomic(artifact.projectId, async () => {
      const current = await this.context(user, artifactId),
        baseline = await this.store.one(
          'SELECT * FROM studio_rebuild_baselines WHERE artifact_id=?',
          artifactId,
        );
      if (
        hash(this.boundedSource(await readPlanSource(this.store, current))) !==
          hash(source) ||
        baseline?.revision !== prepared.baseline.revision
      )
        throw new HttpError(
          409,
          'Source or delivered baseline changed while checking PRs',
        );
      await this.fresh(prepared.machine);
      await this.dependencies.assertReady(current, user);
      if (automatic)
        await this.automaticConsent(
          prepared.machine.id,
          user.id,
          baseline.repository,
        );
      if (await this.dependencies.graphs.editingLock(artifactId))
        throw new HttpError(409, 'Implementation work became active');
      const existing = await this.store.one(
        "SELECT id FROM studio_rebuild_runs WHERE artifact_id=? AND status IN ('queued','running')",
        artifactId,
      );
      if (existing) return { id: existing.id, existing: true };
      const quota = await this.store.one(
        'SELECT COUNT(*) AS n FROM studio_rebuild_runs WHERE project_id=? AND created_at>?',
        artifact.projectId,
        new Date(Date.now() - 3600000).toISOString(),
      );
      if (Number(quota.n) >= 40)
        throw new HttpError(
          429,
          'This project reached its hourly rebuild limit',
        );
      // Leave room for the bounded implementation receipt inside the portable 2 MiB transport.
      const transportSnapshot = JSON.stringify({
        before: JSON.parse(baseline.source_json),
        after: JSON.parse(source),
        reviewedGraph: JSON.parse(baseline.graph_json),
        pullRequests: prs,
      });
      if (Buffer.byteLength(transportSnapshot) > 1536 * 1024)
        throw new HttpError(
          413,
          'The combined rebuild sources and reviewed graph exceed the 1.5 MiB scoped transport budget',
        );
      // Bound retained source history independently from provider call rate.
      const historical = await this.store.all(
        "SELECT id FROM studio_rebuild_runs WHERE artifact_id=? AND status NOT IN ('queued','running') ORDER BY created_at DESC",
        artifactId,
      );
      for (const old of historical.slice(99))
        await this.store.exec(
          'DELETE FROM studio_rebuild_runs WHERE id=?',
          old.id,
        );
      const bytes =
        this.store.db.dialect === 'postgres'
          ? 'octet_length(source_json)+octet_length(before_json)'
          : 'length(CAST(source_json AS BLOB))+length(CAST(before_json AS BLOB))';
      const used = await this.store.one(
        `SELECT COALESCE(SUM(${bytes}),0) AS n FROM studio_rebuild_runs WHERE project_id=?`,
        artifact.projectId,
      );
      if (
        Number(used.n) +
          Buffer.byteLength(source) +
          Buffer.byteLength(baseline.source_json) >
        256 * 1024 * 1024
      )
        throw new HttpError(
          413,
          'This project reached its 256 MiB retained rebuild-source quota',
        );
      const id = randomUUID(),
        date = at();
      await this.store.exec(
        'INSERT INTO studio_rebuild_runs(id,artifact_id,project_id,user_id,machine_id,baseline_revision,base_run_id,repository,before_json,source_json,source_sha256,source_version,graph_json,prs_json,automatic,status,generation,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        id,
        artifactId,
        artifact.projectId,
        user.id,
        prepared.machine.id,
        baseline.revision,
        baseline.run_id,
        baseline.repository,
        baseline.source_json,
        source,
        hash(source),
        current.version,
        baseline.graph_json,
        JSON.stringify(prs),
        automatic ? 1 : 0,
        'queued',
        1,
        date,
        date,
      );
      const authoringProfile =
        await this.dependencies.captureAuthoringProfile?.(user, artifactId);
      await this.store.exec(
        'INSERT INTO studio_rebuild_execution_receipts(rebuild_id,authoring_profile_json,runtime_json) VALUES(?,?,NULL)',
        id,
        authoringProfile
          ? JSON.stringify(agentProfileSchema.parse(authoringProfile))
          : null,
      );
      await this.store.audit(
        artifact.projectId,
        artifactId,
        user.name,
        automatic
          ? 'implementation.rebuild.auto-queued'
          : 'implementation.rebuild.requested',
        JSON.stringify({
          id,
          sourceSha256: hash(source),
          baselineRevision: baseline.revision,
          prs: prs.map((pr) => pr.url),
        }),
      );
      this.store.db.afterCommit(async () => {
        this.dependencies.notify?.(artifact.projectId, artifactId);
      });
      return { id, existing: false };
    });
  }
  async activeOnArtifact(artifactId: string) {
    await this.ready;
    return !!(await this.store.one(
      "SELECT id FROM studio_rebuild_runs WHERE artifact_id=? AND status IN ('queued','running')",
      artifactId,
    ));
  }
  async activeOnMachine(machineId: string) {
    await this.ready;
    return !!(await this.store.one(
      "SELECT id FROM studio_rebuild_runs WHERE machine_id=? AND status='running' AND lease_expires>?",
      machineId,
      Date.now(),
    ));
  }
  async claim(principal: MachinePrincipal) {
    await this.ready;
    await this.fresh(principal);
    await this.tick();
    return this.atomic(principal.project_id, async () => {
      const machine = await this.fresh(principal);
      await this.store.lock('machine:' + machine.id);
      if (
        (await this.activeOnMachine(machine.id)) ||
        (await this.dependencies.otherWorkActive?.(machine.id))
      )
        return { work: null };
      const row = await this.store.one(
        "SELECT * FROM studio_rebuild_runs WHERE machine_id=? AND user_id=? AND status='queued' ORDER BY created_at,id LIMIT 1",
        machine.id,
        machine.user_id,
      );
      if (!row) return { work: null };
      const registration = await this.store.one(
        'SELECT repository FROM studio_investigation_checkouts WHERE machine_id=?',
        machine.id,
      );
      if (!sameRepo(registration?.repository ?? '', row.repository))
        throw new HttpError(
          409,
          'The sealed repository no longer matches this machine checkout',
        );
      const current = await this.context(
        await this.store.publicUser(machine.user_id),
        row.artifact_id,
      );
      if (
        hash(this.boundedSource(await readPlanSource(this.store, current))) !==
        row.source_sha256
      ) {
        await this.stopRow(
          row,
          'The document changed before execution; request a fresh rebuild',
        );
        return { work: null };
      }
      await this.dependencies.assertReady(
        current,
        await this.store.publicUser(machine.user_id),
      );
      if (row.automatic)
        await this.automaticConsent(
          machine.id,
          machine.user_id,
          row.repository,
        );
      const leaseToken = opaque();
      await this.store.exec(
        "UPDATE studio_rebuild_runs SET status='running',lease_hash=?,lease_expires=?,updated_at=? WHERE id=?",
        hash(leaseToken),
        Date.now() + 120000,
        at(),
        row.id,
      );
      return {
        work: {
          id: row.id,
          kind: 'implementation-rebuild',
          generation: Number(row.generation),
          artifactId: row.artifact_id,
          repository: row.repository,
          pullRequests: JSON.parse(row.prs_json),
          sourceSha256: row.source_sha256,
        },
        leaseToken,
      };
    });
  }
  async start(
    principal: MachinePrincipal,
    id: string,
    input: z.infer<typeof rebuildLeaseSchema> & {
      pullRequests: RebuildPullRequest[];
      runtime: z.infer<typeof rebuildRuntimeSchema>;
    },
  ) {
    const sealed = await this.atomic(principal.project_id, () =>
      this.leased(principal, id, input),
    );
    const expected = JSON.parse(sealed.prs_json) as RebuildPullRequest[];
    if (JSON.stringify(input.pullRequests) !== JSON.stringify(expected))
      throw new HttpError(
        409,
        'Local worktrees do not match the sealed existing PR heads',
      );
    const user = await this.store.publicUser(principal.user_id),
      signal = AbortSignal.timeout(15000);
    for (const pr of expected) {
      const current = await this.resolvePR(
        user,
        sealed.repository,
        pr.url,
        signal,
      );
      if (
        current.state !== 'open' ||
        current.url !== pr.url ||
        current.branch !== pr.branch ||
        current.commit !== pr.commit ||
        !sameRepo(current.repository, sealed.repository)
      )
        throw new HttpError(
          409,
          'An existing PR head changed before execution; review and retry against its latest head',
        );
    }
    return this.atomic(principal.project_id, async () => {
      const row = await this.leased(principal, id, input),
        artifact = await this.context(user, row.artifact_id);
      if (
        hash(this.boundedSource(await readPlanSource(this.store, artifact))) !==
        row.source_sha256
      )
        throw new HttpError(
          409,
          'The plan changed before execution; request a new rebuild',
        );
      await this.dependencies.assertReady(artifact, user);
      const runtime = JSON.stringify(rebuildRuntimeSchema.parse(input.runtime)),
        previous = await this.store.one(
          'SELECT runtime_json FROM studio_rebuild_execution_receipts WHERE rebuild_id=?',
          id,
        );
      if (previous?.runtime_json && previous.runtime_json !== runtime)
        throw new HttpError(
          409,
          'The connected execution runtime changed after this rebuild started',
        );
      await this.store.exec(
        'INSERT INTO studio_rebuild_execution_receipts(rebuild_id,runtime_json) VALUES(?,?) ON CONFLICT(rebuild_id) DO UPDATE SET runtime_json=excluded.runtime_json',
        id,
        runtime,
      );
      await this.store.exec(
        'UPDATE studio_rebuild_runs SET execution_started=1,updated_at=? WHERE id=?',
        at(),
        id,
      );
      return { ok: true };
    });
  }
  private async leased(
    principal: MachinePrincipal,
    id: string,
    input: z.infer<typeof rebuildLeaseSchema>,
    completed = false,
  ) {
    await this.fresh(principal);
    const row = await this.store.one(
      'SELECT * FROM studio_rebuild_runs WHERE id=? AND machine_id=? AND user_id=? AND project_id=? AND generation=? AND lease_hash=?',
      id,
      principal.id,
      principal.user_id,
      principal.project_id,
      input.generation,
      hash(input.leaseToken),
    );
    if (
      !row ||
      !(
        row.status === 'running' ||
        (completed && row.status === 'completed')
      ) ||
      (row.status === 'running' && Number(row.lease_expires) <= Date.now())
    )
      throw new HttpError(409, 'This scoped rebuild lease ended');
    const registration = await this.store.one(
      'SELECT repository FROM studio_investigation_checkouts WHERE machine_id=?',
      principal.id,
    );
    if (!sameRepo(registration?.repository ?? '', row.repository))
      throw new HttpError(
        409,
        'The sealed repository no longer matches this machine checkout',
      );
    if (row.automatic)
      await this.automaticConsent(
        principal.id,
        principal.user_id,
        row.repository,
      );
    return row;
  }
  async read(
    principal: MachinePrincipal,
    id: string,
    input: z.infer<typeof rebuildLeaseSchema>,
  ) {
    return this.atomic(principal.project_id, async () => {
      const row = await this.leased(principal, id, input, true);
      return {
        id: row.id,
        status: row.status,
        execution: await this.store.one(
          'SELECT authoring_profile_json AS selectedAuthoringProfile,runtime_json AS connectedRuntime FROM studio_rebuild_execution_receipts WHERE rebuild_id=?',
          id,
        ),
        baseRunId: row.base_run_id,
        repository: row.repository,
        before: JSON.parse(row.before_json),
        after: JSON.parse(row.source_json),
        sourceSha256: row.source_sha256,
        reviewedGraph: JSON.parse(row.graph_json),
        pullRequests: JSON.parse(row.prs_json),
        implementation: row.report_json ? JSON.parse(row.report_json) : null,
      };
    });
  }
  async heartbeat(
    principal: MachinePrincipal,
    id: string,
    input: z.infer<typeof rebuildLeaseSchema>,
  ) {
    return this.atomic(principal.project_id, async () => {
      await this.leased(principal, id, input);
      await this.store.exec(
        'UPDATE studio_rebuild_runs SET lease_expires=?,updated_at=? WHERE id=?',
        Date.now() + 120000,
        at(),
        id,
      );
      return { ok: true };
    });
  }
  async verifier(
    principal: MachinePrincipal,
    id: string,
    input: z.infer<typeof rebuildLeaseSchema>,
  ) {
    return this.atomic(principal.project_id, async () => {
      const row = await this.leased(principal, id, input);
      if (!row.report_json)
        throw new HttpError(409, 'Report actual implementation evidence first');
      const verifierToken = opaque();
      await this.store.exec(
        'UPDATE studio_rebuild_runs SET verifier_hash=? WHERE id=?',
        hash(verifierToken),
        id,
      );
      return { verifierToken };
    });
  }
  async report(
    principal: MachinePrincipal,
    id: string,
    input: z.infer<typeof rebuildLeaseSchema> & {
      report: z.infer<typeof rebuildReportSchema>;
      verifierToken?: string;
    },
  ) {
    const report = rebuildReportSchema.parse(input.report),
      encoded = JSON.stringify(report);
    if (Buffer.byteLength(encoded) > 256 * 1024)
      throw new HttpError(413, 'Rebuild report exceeds 256 KiB');
    if (input.verifierToken) {
      const sealed = await this.atomic(principal.project_id, () =>
        this.leased(principal, id, input, true),
      );
      if (hash(input.verifierToken) !== sealed.verifier_hash)
        throw new HttpError(403, 'Invalid independent verifier credential');
      const signal = AbortSignal.timeout(15000);
      if (sealed.status !== 'completed')
        for (const pr of report.pullRequests) {
          const current = await this.resolvePR(
            await this.store.publicUser(principal.user_id),
            sealed.repository,
            pr.url,
            signal,
          );
          if (
            current.state !== 'open' ||
            current.url !== pr.url ||
            current.branch !== pr.branch ||
            current.commit !== pr.commit ||
            !sameRepo(current.repository, sealed.repository)
          )
            throw new HttpError(
              409,
              'Verification must match the current existing PR branch commit',
            );
        }
    }
    return this.atomic(principal.project_id, async () => {
      const row = await this.leased(principal, id, input, true),
        digest = hash(encoded);
      if (row.status === 'completed') {
        if (
          !input.verifierToken ||
          hash(input.verifierToken) !== row.verifier_hash
        )
          throw new HttpError(
            403,
            'Only the verifier may replay the completion receipt',
          );
        if (row.verification_json !== encoded)
          throw new HttpError(409, 'A completed report cannot change');
        return { status: 'completed' };
      }
      if (!row.execution_started)
        throw new HttpError(
          409,
          'Validate exact existing PR worktrees before executing',
        );
      if (report.sourceSha256 !== row.source_sha256)
        throw new HttpError(
          409,
          'Report source differs from this sealed rebuild',
        );
      const prs = JSON.parse(row.prs_json) as RebuildPullRequest[];
      if (
        report.pullRequests.length !== prs.length ||
        new Set(report.pullRequests.map((pr) => pr.url)).size !== prs.length ||
        report.pullRequests.some(
          (pr) =>
            !prs.some(
              (expected) =>
                expected.url === pr.url && expected.branch === pr.branch,
            ),
        )
      )
        throw new HttpError(
          409,
          'Rebuilds must update exactly the original PRs and branches',
        );
      const graph = JSON.parse(row.graph_json) as ImplementationGraph;
      const expected = graph.definition.tasks.flatMap((task) =>
        task.acceptanceCriteria.map((_, index) =>
          JSON.stringify([task.id, index]),
        ),
      );
      const coverage = new Set(
        report.criteria.map((item) =>
          JSON.stringify([item.taskId, item.index]),
        ),
      );
      if (
        report.criteria.length !== expected.length ||
        coverage.size !== expected.length ||
        expected.some((key) => !coverage.has(key))
      )
        throw new HttpError(
          409,
          'Every reviewed graph criterion requires exactly one evidence result',
        );
      if (!input.verifierToken) {
        if (row.report_json && row.report_json !== encoded)
          throw new HttpError(
            409,
            'The implementation receipt cannot change after submission',
          );
        await this.store.exec(
          'UPDATE studio_rebuild_runs SET report_json=?,report_hash=?,updated_at=? WHERE id=?',
          encoded,
          digest,
          at(),
          id,
        );
        return { status: 'awaiting_verification' };
      }
      if (
        hash(input.verifierToken) !== row.verifier_hash ||
        !row.report_json ||
        hash(row.report_json) !== row.report_hash
      )
        throw new HttpError(
          403,
          'Independent verification requires its own scoped credential and intact implementation receipt',
        );
      const implementation = JSON.parse(row.report_json) as z.infer<
        typeof rebuildReportSchema
      >;
      if (
        report.pullRequests.some(
          (pr) =>
            !implementation.pullRequests.some(
              (built) => built.url === pr.url && built.commit === pr.commit,
            ),
        )
      )
        throw new HttpError(
          409,
          'Verify the exact commits reported by the implementer',
        );
      if (report.criteria.some((item) => !item.passed)) {
        await this.stopRow(
          row,
          'Independent verification found failing acceptance criteria',
        );
        return { status: 'failed' };
      }
      const current = await this.context(
          await this.store.publicUser(row.user_id),
          row.artifact_id,
        ),
        baseline = await this.store.one(
          'SELECT * FROM studio_rebuild_baselines WHERE artifact_id=?',
          row.artifact_id,
        );
      if (Number(baseline?.revision) !== Number(row.baseline_revision))
        throw new HttpError(409, 'Delivered baseline changed during execution');
      await this.dependencies.assertReady(
        current,
        await this.store.publicUser(row.user_id),
      );
      // Later edits remain pending. Only this exact reviewed snapshot becomes the delivered baseline.
      await this.store.exec(
        'UPDATE studio_rebuild_baselines SET source_json=?,source_sha256=?,source_version=?,revision=revision+1,updated_at=? WHERE artifact_id=?',
        row.source_json,
        row.source_sha256,
        row.source_version,
        at(),
        row.artifact_id,
      );
      await this.store.exec(
        "UPDATE studio_rebuild_runs SET status='completed',verification_json=?,updated_at=? WHERE id=?",
        encoded,
        at(),
        id,
      );
      await this.store.audit(
        row.project_id,
        row.artifact_id,
        'Independent connector verifier',
        'implementation.rebuild.completed',
        JSON.stringify({
          id,
          sourceSha256: row.source_sha256,
          baseRunId: row.base_run_id,
          implementationSha256: row.report_hash,
          verificationSha256: digest,
        }),
      );
      this.store.db.afterCommit(async () => {
        this.dependencies.notify?.(row.project_id, row.artifact_id);
      });
      return { status: 'completed' };
    });
  }
  private async stopRow(row: any, reason: string) {
    await this.store.exec(
      "UPDATE studio_rebuild_runs SET status='failed',generation=generation+1,lease_hash=NULL,verifier_hash=NULL,error=?,updated_at=? WHERE id=?",
      reason,
      at(),
      row.id,
    );
  }
  async stop(
    principal: MachinePrincipal,
    id: string,
    input: z.infer<typeof rebuildLeaseSchema> & {
      reason: string;
    },
  ) {
    return this.atomic(principal.project_id, async () => {
      const row = await this.leased(principal, id, input, true);
      if (row.status !== 'completed') await this.stopRow(row, input.reason);
      return { ok: true };
    });
  }
  async cancel(user: User, artifactId: string, id: string) {
    const artifact = await this.context(user, artifactId);
    return this.atomic(artifact.projectId, async () => {
      await this.context(user, artifactId);
      const row = await this.store.one(
        "SELECT * FROM studio_rebuild_runs WHERE id=? AND artifact_id=? AND user_id=? AND status IN ('queued','running')",
        id,
        artifactId,
        user.id,
      );
      if (!row) throw new HttpError(404, 'Your active rebuild was not found');
      await this.stopRow(
        row,
        'Stopped by the person who requested the rebuild; retained work needs review',
      );
      return { ok: true };
    });
  }
  /** Called from durable platform maintenance. Never automatically replay uncertain external execution. */
  async tick() {
    await this.ready;
    for (const row of await this.store.all(
      "SELECT * FROM studio_rebuild_runs WHERE status='running' AND lease_expires<? LIMIT 50",
      Date.now(),
    ))
      await this.atomic(row.project_id, async () => {
        const current = await this.store.one(
          "SELECT * FROM studio_rebuild_runs WHERE id=? AND status='running' AND lease_expires<?",
          row.id,
          Date.now(),
        );
        if (current)
          await this.stopRow(
            current,
            'Connector lease expired; review retained work before explicitly retrying',
          );
      });
    for (const pending of await this.store.all(
      'SELECT p.*,b.user_id AS builder_id,b.machine_id FROM studio_rebuild_pending p JOIN studio_rebuild_baselines b ON b.artifact_id=p.artifact_id WHERE p.due_at<=? ORDER BY p.due_at LIMIT 10',
      Date.now(),
    )) {
      try {
        await this.store.role(pending.project_id, pending.writer_id, 'write');
        const user = await this.store.publicUser(pending.builder_id);
        const queued = await this.queue(
          user,
          pending.artifact_id,
          {
            machineId: pending.machine_id,
            expectedSourceSha256: pending.source_sha256,
          },
          true,
        );
        if (!queued.existing)
          await this.store.exec(
            'DELETE FROM studio_rebuild_pending WHERE artifact_id=? AND source_sha256=?',
            pending.artifact_id,
            pending.source_sha256,
          );
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        await this.atomic(pending.project_id, async () => {
          const baseline = await this.store.one(
            'SELECT source_sha256 FROM studio_rebuild_baselines WHERE artifact_id=?',
            pending.artifact_id,
          );
          if (baseline?.source_sha256 === pending.source_sha256)
            await this.store.exec(
              'DELETE FROM studio_rebuild_pending WHERE artifact_id=? AND source_sha256=?',
              pending.artifact_id,
              pending.source_sha256,
            );
          else
            await this.store.exec(
              'UPDATE studio_rebuild_pending SET error=?,due_at=? WHERE artifact_id=? AND source_sha256=?',
              error.message.slice(0, 1000),
              Date.now() + 60000,
              pending.artifact_id,
              pending.source_sha256,
            );
        });
      }
    }
  }
}
export async function registerRebuildRoutes(
  app: FastifyInstance,
  dependencies: RebuildDependencies,
) {
  const service = new RebuildMachines(dependencies);
  await service.ready;
  const uuid = z.string().uuid();
  const browser = async (request: FastifyRequest) => {
    await dependencies.auth.assertOrigin(request);
    if (request.headers.authorization)
      throw new HttpError(
        403,
        'A person must request rebuilds and machine consent',
      );
    return dependencies.auth.user(request);
  };
  app.get<{
    Params: {
      id: string;
    };
  }>('/api/artifacts/:id/implementation/rebuild', async (request) =>
    service.snapshot(
      await dependencies.auth.user(request),
      uuid.parse(request.params.id),
    ),
  );
  app.post<{
    Params: {
      id: string;
    };
  }>('/api/artifacts/:id/implementation/rebuild', async (request) =>
    service.queue(
      await browser(request),
      uuid.parse(request.params.id),
      z
        .object({
          machineId: uuid.optional(),
          expectedSourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict()
        .parse(request.body),
    ),
  );
  app.post<{
    Params: {
      id: string;
      runId: string;
    };
  }>(
    '/api/artifacts/:id/implementation/rebuild/:runId/cancel',
    async (request) =>
      service.cancel(
        await browser(request),
        uuid.parse(request.params.id),
        uuid.parse(request.params.runId),
      ),
  );
  app.put<{
    Params: {
      id: string;
    };
  }>('/api/machines/:id/rebuild-consent', async (request) =>
    service.consent(
      await browser(request),
      uuid.parse(request.params.id),
      z.object({ enabled: z.boolean() }).strict().parse(request.body).enabled,
    ),
  );
  const machine = (request: FastifyRequest, id: string) =>
    dependencies.machines.authenticate(request, uuid.parse(id));
  app.post<{
    Params: {
      machineId: string;
    };
  }>('/api/machines/:machineId/rebuild/claim', async (request) =>
    service.claim(await machine(request, request.params.machineId)),
  );
  for (const action of ['read', 'heartbeat', 'verifier'] as const)
    app.post<{
      Params: {
        machineId: string;
        id: string;
      };
    }>(`/api/machines/:machineId/rebuild/:id/${action}`, async (request) =>
      service[action](
        await machine(request, request.params.machineId),
        uuid.parse(request.params.id),
        rebuildLeaseSchema.parse(request.body),
      ),
    );
  app.post<{
    Params: {
      machineId: string;
      id: string;
    };
  }>('/api/machines/:machineId/rebuild/:id/start', async (request) =>
    service.start(
      await machine(request, request.params.machineId),
      uuid.parse(request.params.id),
      rebuildLeaseSchema
        .extend({
          runtime: rebuildRuntimeSchema,
          pullRequests: z
            .array(
              z
                .object({
                  url: z.string().url(),
                  branch: implementationClaimSchema.shape.branch,
                  commit: implementationClaimSchema.shape.commit,
                })
                .strict(),
            )
            .min(1)
            .max(20),
        })
        .strict()
        .parse(request.body),
    ),
  );
  app.post<{
    Params: {
      machineId: string;
      id: string;
    };
  }>('/api/machines/:machineId/rebuild/:id/report', async (request) =>
    service.report(
      await machine(request, request.params.machineId),
      uuid.parse(request.params.id),
      rebuildLeaseSchema
        .extend({
          report: rebuildReportSchema,
          verifierToken: z.string().optional(),
        })
        .strict()
        .parse(request.body),
    ),
  );
  app.post<{
    Params: {
      machineId: string;
      id: string;
    };
  }>('/api/machines/:machineId/rebuild/:id/stop', async (request) =>
    service.stop(
      await machine(request, request.params.machineId),
      uuid.parse(request.params.id),
      rebuildLeaseSchema
        .extend({ reason: z.string().min(1).max(1000) })
        .strict()
        .parse(request.body),
    ),
  );
  return service;
}
