import { randomBytes, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Store, HttpError, hash } from '../store.ts';
import type { Auth } from '../auth.ts';
import type { ObjectStore } from '../hosting/ports.ts';
import {
  paragraph,
  docText,
  type RichNode,
  type User,
} from '../../shared/domain.ts';
import {
  commitSchema,
  investigationCapabilities,
  investigationResultSchema,
  selectionSchema,
  validateSelection,
  emptySelection,
  type Investigation,
  type InvestigationResult,
  type Selection,
} from '../../shared/investigations.ts';

export type MachinePrincipal = {
  id: string;
  project_id: string;
  user_id: string;
  token_hash: string;
};
export type InvestigationDependencies = {
  store: Store;
  auth: Auth;
  machines: {
    authenticate(
      request: FastifyRequest,
      id: string,
    ): Promise<MachinePrincipal>;
  };
  objects: ObjectStore;
  implementationLocked?: (artifactId: string) => Promise<boolean>;
  notify?: (projectId: string, artifactId: string) => void;
  nativeDocumentBlocks?: boolean;
  spikes?: {
    enabled: boolean;
    judge?: (input: {
      passage: string;
      context: string;
      signal: AbortSignal;
    }) => Promise<{ useful: boolean; brief: string; reason: string }>;
  };
};
const timestamp = () => new Date().toISOString(),
  opaque = () => randomBytes(32).toString('base64url');
const repositorySchema = z
  .string()
  .regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const normalizeRepository = (value: string) =>
  value
    .replace(/\.git$/, '')
    .replace(/\/$/, '')
    .toLowerCase();
export class InvestigationService {
  readonly ready: Promise<void>;
  private readonly publications = new AsyncLocalStorage<
    Map<string, { projectId: string; artifactId: string }>
  >();
  constructor(readonly dependencies: InvestigationDependencies) {
    this.ready = this.initialize();
  }
  get store() {
    return this.dependencies.store;
  }
  private async initialize() {
    await this.store.tx(async () => {
      await this.store.db.lock('schema:studio.investigations');
      await this.store.db.exec(`
CREATE TABLE IF NOT EXISTS studio_investigations(id TEXT PRIMARY KEY,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),artifact_version INTEGER NOT NULL,source_commit TEXT NOT NULL,repository TEXT NOT NULL,brief TEXT NOT NULL,brief_hash TEXT NOT NULL,snapshot_json TEXT NOT NULL,status TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 0,machine_id TEXT REFERENCES studio_machines(id) ON DELETE SET NULL,lease_hash TEXT,lease_expires INTEGER,started_at INTEGER,result_json TEXT,result_hash TEXT,child_artifact_id TEXT UNIQUE REFERENCES artifacts(id) ON DELETE RESTRICT,error TEXT,required_reason TEXT,mode TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS studio_investigations_queue ON studio_investigations(project_id,user_id,status,created_at);
CREATE TABLE IF NOT EXISTS studio_investigation_selections(investigation_id TEXT NOT NULL REFERENCES studio_investigations(id) ON DELETE CASCADE,view_id TEXT NOT NULL,revision INTEGER NOT NULL,state_json TEXT NOT NULL,PRIMARY KEY(investigation_id,view_id));
CREATE TABLE IF NOT EXISTS studio_investigation_decisions(id TEXT PRIMARY KEY,investigation_id TEXT NOT NULL REFERENCES studio_investigations(id) ON DELETE RESTRICT,view_id TEXT NOT NULL,selection_revision INTEGER NOT NULL,selection_json TEXT NOT NULL,conclusion TEXT NOT NULL,rationale TEXT NOT NULL,result_hash TEXT NOT NULL,author_id TEXT NOT NULL REFERENCES users(id),author_name TEXT NOT NULL,created_at TEXT NOT NULL,sha256 TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS studio_investigation_checkouts(machine_id TEXT PRIMARY KEY REFERENCES studio_machines(id) ON DELETE CASCADE,repository TEXT NOT NULL,source_commit TEXT NOT NULL,branch TEXT NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS studio_investigation_consent(machine_id TEXT PRIMARY KEY REFERENCES studio_machines(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),enabled INTEGER NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS studio_investigation_images(investigation_id TEXT NOT NULL REFERENCES studio_investigations(id) ON DELETE CASCADE,file_id TEXT PRIMARY KEY REFERENCES files(id),sha256 TEXT NOT NULL,generation INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS studio_investigation_passages(artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),digest TEXT NOT NULL,investigation_id TEXT NOT NULL REFERENCES studio_investigations(id),PRIMARY KEY(artifact_id,user_id,digest));`);
    });
  }
  private async atomic<T>(projectId: string, callback: () => Promise<T>) {
    await this.ready;
    const existing = this.publications.getStore();
    const work = () =>
      this.store.tx(async () => {
        await this.store.db.lock('project:' + projectId);
        return callback();
      });
    if (existing) return work();
    const pending = new Map<
      string,
      { projectId: string; artifactId: string }
    >();
    const result = await this.publications.run(pending, work);
    for (const item of pending.values())
      this.dependencies.notify?.(item.projectId, item.artifactId);
    return result;
  }
  private async fresh(machine: MachinePrincipal) {
    const current = await this.store.one(
      'SELECT * FROM studio_machines WHERE id=? AND project_id=? AND user_id=? AND token_hash=? AND expires>?',
      machine.id,
      machine.project_id,
      machine.user_id,
      machine.token_hash,
      Date.now(),
    );
    if (!current)
      throw new HttpError(
        401,
        'This machine credential was revoked or expired',
      );
    await this.store.role(current.project_id, current.user_id, 'write');
    return current;
  }
  private async unlocked(artifactId: string, userId: string) {
    const artifact = await this.store.artifact(artifactId, userId, 'write');
    if (!['design', 'document'].includes(artifact.kind))
      throw new HttpError(409, 'Investigations start from a document');
    if (
      await this.store.one(
        'SELECT id FROM studio_investigations WHERE child_artifact_id=?',
        artifactId,
      )
    )
      throw new HttpError(
        409,
        'A published investigation cannot start another investigation',
      );
    if (await this.dependencies.implementationLocked?.(artifactId))
      throw new HttpError(
        409,
        'The document is locked by an active implementation',
      );
    return artifact;
  }
  private async ownRow(user: User, id: string, write = false) {
    const row = await this.store.one(
      'SELECT * FROM studio_investigations WHERE id=?',
      id,
    );
    if (!row) throw new HttpError(404, 'Investigation not found');
    await this.store.artifact(
      row.artifact_id,
      user.id,
      write ? 'write' : 'read',
    );
    return row;
  }
  private emit(row: any) {
    const pending = this.publications.getStore();
    for (const artifactId of [row.artifact_id, row.child_artifact_id].filter(
      Boolean,
    )) {
      const item = { projectId: row.project_id, artifactId };
      if (pending) pending.set(artifactId, item);
      else this.dependencies.notify?.(item.projectId, item.artifactId);
    }
  }
  async list(user: User, artifactId: string) {
    await this.ready;
    await this.store.artifact(artifactId, user.id);
    await this.expire();
    const rows = await this.store.all(
      'SELECT id FROM studio_investigations WHERE artifact_id=? OR child_artifact_id=? ORDER BY created_at,id LIMIT 100',
      artifactId,
      artifactId,
    );
    const records = [];
    for (const row of rows) records.push(await this.get(user, row.id));
    const checkouts = await this.store.all(
      'SELECT c.source_commit AS sourceCommit,c.branch,m.id AS machineId,m.label FROM studio_investigation_checkouts c JOIN studio_machines m ON m.id=c.machine_id WHERE m.project_id=(SELECT project_id FROM artifacts WHERE id=?) AND m.user_id=? AND m.expires>? ORDER BY c.updated_at DESC',
      artifactId,
      user.id,
      Date.now(),
    );
    return { records, checkouts, capabilities: investigationCapabilities };
  }
  async get(user: User, id: string): Promise<Investigation> {
    await this.ready;
    const row = await this.ownRow(user, id);
    if (row.result_json && hash(row.result_json) !== row.result_hash)
      throw new HttpError(
        409,
        'The published investigation evidence failed its integrity check',
      );
    const selections: Investigation['selections'] = {};
    for (const state of await this.store.all(
      'SELECT * FROM studio_investigation_selections WHERE investigation_id=?',
      id,
    ))
      selections[state.view_id] = {
        revision: state.revision,
        selection: JSON.parse(state.state_json),
      };
    const decisions = (
      await this.store.all(
        'SELECT * FROM studio_investigation_decisions WHERE investigation_id=? ORDER BY created_at,id',
        id,
      )
    ).map((d) => ({
      id: d.id,
      investigationId: id,
      viewId: d.view_id,
      selectionRevision: d.selection_revision,
      selection: JSON.parse(d.selection_json),
      conclusion: d.conclusion,
      rationale: d.rationale,
      resultHash: d.result_hash,
      authorId: d.author_id,
      authorName: d.author_name,
      createdAt: d.created_at,
      sha256: d.sha256,
    }));
    await this.store.role(row.project_id, user.id);
    return {
      id: row.id,
      artifactId: row.artifact_id,
      projectId: row.project_id,
      ownerId: row.user_id,
      artifactVersion: row.artifact_version,
      sourceCommit: row.source_commit,
      repository: row.repository,
      brief: row.brief,
      briefHash: row.brief_hash,
      status: row.status,
      generation: row.generation,
      childArtifactId: row.child_artifact_id,
      result: row.result_json
        ? investigationResultSchema.parse(JSON.parse(row.result_json))
        : null,
      resultHash: row.result_hash,
      error: row.error,
      requiredReason: row.required_reason,
      mode: row.mode,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      selections,
      decisions,
    };
  }
  async registerCheckout(
    machine: MachinePrincipal,
    input: { repository: string; sourceCommit: string; branch: string },
  ) {
    await this.ready;
    repositorySchema.parse(input.repository);
    commitSchema.parse(input.sourceCommit);
    return this.atomic(machine.project_id, async () => {
      await this.fresh(machine);
      const project = await this.store.one(
        'SELECT repository FROM projects WHERE id=?',
        machine.project_id,
      );
      if (
        !project.repository ||
        normalizeRepository(project.repository) !==
          normalizeRepository(input.repository)
      )
        throw new HttpError(
          409,
          'The local checkout does not match this project repository',
        );
      await this.store.exec(
        'INSERT INTO studio_investigation_checkouts(machine_id,repository,source_commit,branch,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(machine_id) DO UPDATE SET repository=excluded.repository,source_commit=excluded.source_commit,branch=excluded.branch,updated_at=excluded.updated_at',
        machine.id,
        input.repository,
        input.sourceCommit,
        input.branch,
        Date.now(),
      );
      return { ok: true };
    });
  }
  async propose(
    user: User,
    artifactId: string,
    input: {
      version: number;
      brief: string;
      sourceCommit?: string;
      requiredReason?: string;
      mode?: 'manual' | 'spike';
    },
  ) {
    await this.ready;
    const initial = await this.store.artifact(artifactId, user.id, 'write');
    return this.atomic(initial.projectId, async () => {
      const artifact = await this.unlocked(artifactId, user.id);
      if (artifact.version !== input.version)
        throw new HttpError(
          409,
          'The document changed; review its current revision before proposing an investigation',
        );
      const project = await this.store.one(
        'SELECT repository FROM projects WHERE id=?',
        artifact.projectId,
      );
      if (!project.repository)
        throw new HttpError(
          409,
          'Select a GitHub repository and connect its checkout before investigating',
        );
      const repository = repositorySchema.parse(project.repository);
      const checkout = await this.store.one(
        'SELECT c.source_commit FROM studio_investigation_checkouts c JOIN studio_machines m ON m.id=c.machine_id WHERE m.project_id=? AND m.user_id=? AND m.expires>? AND c.repository=? ORDER BY c.updated_at DESC LIMIT 1',
        artifact.projectId,
        user.id,
        Date.now(),
        repository,
      );
      const commit = commitSchema.parse(
        input.sourceCommit ?? checkout?.source_commit,
      );
      const brief = z.string().trim().min(1).max(8000).parse(input.brief),
        id = randomUUID(),
        time = timestamp(),
        source = JSON.stringify(artifact.content);
      const sealed = {
        brief,
        artifactId,
        artifactVersion: artifact.version,
        sourceHash: hash(source),
        sourceCommit: commit,
        repository,
      };
      if (
        (
          await this.store.one(
            'SELECT count(*) AS n FROM studio_investigations WHERE artifact_id=?',
            artifactId,
          )
        ).n >= 100
      )
        throw new HttpError(
          409,
          'The document has reached its 100-investigation limit',
        );
      await this.store.exec(
        'INSERT INTO studio_investigations(id,artifact_id,project_id,user_id,artifact_version,source_commit,repository,brief,brief_hash,snapshot_json,status,required_reason,mode,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        id,
        artifactId,
        artifact.projectId,
        user.id,
        artifact.version,
        commit,
        repository,
        brief,
        hash(JSON.stringify(sealed)),
        JSON.stringify({ sealed, content: artifact.content }),
        'proposed',
        input.requiredReason ?? null,
        input.mode ?? 'manual',
        time,
        time,
      );
      await this.store.audit(
        artifact.projectId,
        artifactId,
        user.name,
        'investigation.proposed',
        id,
      );
      return this.get(user, id);
    });
  }
  async run(user: User, id: string) {
    const initial = await this.ownRow(user, id, true);
    return this.atomic(initial.project_id, async () => {
      const row = await this.ownRow(user, id, true);
      if (row.user_id !== user.id)
        throw new HttpError(
          403,
          'Only the investigation owner can run work on their machine',
        );
      const artifact = await this.unlocked(row.artifact_id, user.id);
      if (artifact.version !== row.artifact_version)
        throw new HttpError(
          409,
          'The sealed document revision changed; propose a new investigation',
        );
      if (row.status !== 'proposed')
        throw new HttpError(409, 'Only a ready investigation can be run');
      if (
        !(await this.store.one(
          'SELECT id FROM studio_machines WHERE project_id=? AND user_id=? AND expires>? AND last_seen>?',
          row.project_id,
          user.id,
          Date.now(),
          Date.now() - 90000,
        ))
      )
        throw new HttpError(
          409,
          'Connect your own machine before running this investigation',
        );
      await this.store.exec(
        "UPDATE studio_investigations SET status='queued',generation=generation+1,error=NULL,updated_at=? WHERE id=?",
        timestamp(),
        id,
      );
      await this.store.audit(
        row.project_id,
        row.artifact_id,
        user.name,
        'investigation.run',
        id,
      );
      this.emit(row);
      return this.get(user, id);
    });
  }
  async transition(
    user: User,
    id: string,
    action: 'retry' | 'cancel' | 'withdraw',
  ) {
    const initial = await this.ownRow(user, id, true);
    return this.atomic(initial.project_id, async () => {
      const row = await this.ownRow(user, id, true);
      if (row.user_id !== user.id)
        throw new HttpError(
          403,
          'Only the owner can retry or stop this investigation',
        );
      const valid =
        action === 'retry'
          ? ['failed', 'cancelled', 'interrupted']
          : action === 'withdraw'
            ? ['proposed']
            : ['queued', 'running'];
      if (!valid.includes(row.status))
        throw new HttpError(
          409,
          'That transition is not available for this investigation',
        );
      await this.store.exec(
        'UPDATE studio_investigations SET status=?,generation=generation+1,lease_hash=NULL,lease_expires=NULL,error=NULL,updated_at=? WHERE id=?',
        action === 'retry'
          ? 'proposed'
          : action === 'withdraw'
            ? 'withdrawn'
            : 'cancelled',
        timestamp(),
        id,
      );
      await this.store.audit(
        row.project_id,
        row.artifact_id,
        user.name,
        'investigation.' + action,
        id,
      );
      this.emit(row);
      return this.get(user, id);
    });
  }
  async expire() {
    await this.ready;
    await this.store.exec(
      "UPDATE studio_investigations SET status='interrupted',generation=generation+1,lease_hash=NULL,error='The local execution lease expired. Retry requires an explicit Run; uncertain work is never replayed.',updated_at=? WHERE status='running' AND (lease_expires<? OR started_at<?)",
      timestamp(),
      Date.now(),
      Date.now() - 20 * 60000,
    );
  }
  async claim(machine: MachinePrincipal) {
    await this.expire();
    return this.atomic(machine.project_id, async () => {
      const current = await this.fresh(machine);
      await this.store.db.lock('machine:' + machine.id);
      if (
        await this.store.one(
          "SELECT id FROM studio_investigations WHERE machine_id=? AND status='running'",
          machine.id,
        )
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
        "SELECT * FROM studio_investigations WHERE project_id=? AND user_id=? AND status='queued' ORDER BY created_at,id LIMIT 1",
        machine.project_id,
        machine.user_id,
      );
      if (!row) return { work: null };
      try {
        const artifact = await this.unlocked(row.artifact_id, machine.user_id);
        if (artifact.version !== row.artifact_version)
          throw new HttpError(
            409,
            'The sealed document revision changed before claim',
          );
        if (
          row.mode === 'spike' &&
          !(await this.store.one(
            'SELECT machine_id FROM studio_investigation_consent WHERE machine_id=? AND user_id=? AND enabled=1',
            machine.id,
            machine.user_id,
          ))
        )
          return { work: null };
      } catch (error) {
        await this.store.exec(
          "UPDATE studio_investigations SET status='interrupted',error=?,updated_at=? WHERE id=?",
          (error as Error).message,
          timestamp(),
          row.id,
        );
        return { work: null };
      }
      const leaseToken = opaque();
      await this.store.exec(
        "UPDATE studio_investigations SET status='running',machine_id=?,lease_hash=?,lease_expires=?,started_at=?,updated_at=? WHERE id=? AND status='queued'",
        current.id,
        hash(leaseToken),
        Date.now() + 120000,
        Date.now(),
        timestamp(),
        row.id,
      );
      await this.store.exec(
        'UPDATE studio_machines SET last_seen=? WHERE id=?',
        Date.now(),
        machine.id,
      );
      this.emit(row);
      return {
        work: {
          id: row.id,
          investigationId: row.id,
          kind: row.mode === 'spike' ? 'spike' : 'investigation',
          version: row.artifact_version,
          brief: row.brief,
          briefHash: row.brief_hash,
          repository: row.repository,
          sourceCommit: row.source_commit,
          generation: row.generation,
          sealed: JSON.parse(row.snapshot_json),
          capabilities: investigationCapabilities,
        },
        leaseToken,
      };
    });
  }
  private async leased(
    machine: MachinePrincipal,
    id: string,
    leaseToken: string,
    generation: number,
  ) {
    await this.fresh(machine);
    const row = await this.store.one(
      "SELECT * FROM studio_investigations WHERE id=? AND project_id=? AND user_id=? AND machine_id=? AND status='running' AND generation=? AND lease_hash=? AND lease_expires>?",
      id,
      machine.project_id,
      machine.user_id,
      machine.id,
      generation,
      hash(leaseToken),
      Date.now(),
    );
    if (!row)
      throw new HttpError(
        409,
        'This investigation lease ended; the result cannot be submitted',
      );
    if (row.started_at < Date.now() - 20 * 60000)
      throw new HttpError(
        409,
        'This investigation exceeded its 20 minute execution limit',
      );
    const artifact = await this.unlocked(row.artifact_id, machine.user_id);
    if (artifact.version !== row.artifact_version)
      throw new HttpError(
        409,
        'The sealed document revision changed during execution',
      );
    return row;
  }
  async heartbeat(
    machine: MachinePrincipal,
    id: string,
    leaseToken: string,
    generation: number,
  ) {
    return this.atomic(machine.project_id, async () => {
      const row = await this.leased(machine, id, leaseToken, generation);
      await this.store.exec(
        'UPDATE studio_investigations SET lease_expires=?,updated_at=? WHERE id=?',
        Date.now() + 120000,
        timestamp(),
        id,
      );
      await this.store.exec(
        'UPDATE studio_machines SET last_seen=? WHERE id=?',
        Date.now(),
        machine.id,
      );
      this.emit(row);
      return { leaseActive: true };
    });
  }
  private document(row: any, result: InvestigationResult, user: User) {
    const content: RichNode[] = [
      {
        type: 'heading',
        attrs: { level: 1 },
        content: [{ type: 'text', text: result.title }],
      },
      paragraph(
        `Investigation of ${row.artifact_id}, requested by ${user.name}. Source commit ${row.source_commit}; document revision ${row.artifact_version}; brief SHA-256 ${row.brief_hash}.`,
      ),
      paragraph(row.brief),
      ...result.report.split(/\n\s*\n/).map(paragraph),
      {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: 'Method' }],
      },
      paragraph(result.method),
      {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: 'Limitations' }],
      },
      paragraph(result.limitations),
    ];
    for (const view of result.views) {
      content.push({
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: view.title }],
      });
      content.push(
        this.dependencies.nativeDocumentBlocks === false
          ? paragraph(
              `Interactive ${view.type} view: ${view.id}. Open Investigations to inspect the shared data and selections.`,
            )
          : {
              type: 'investigationView',
              attrs: { data: { investigationId: row.id, viewId: view.id } },
            },
      );
    }
    for (const evidence of result.evidence)
      content.push(
        {
          type: 'heading',
          attrs: { level: 3 },
          content: [{ type: 'text', text: evidence.name }],
        },
        { type: 'codeBlock', content: [{ type: 'text', text: evidence.text }] },
      );
    for (const image of result.images)
      content.push(
        {
          type: 'image',
          attrs: { src: '/api/files/' + image.fileId, alt: image.caption },
        },
        paragraph(image.caption),
      );
    return { doc: { type: 'doc', content } };
  }
  async complete(
    machine: MachinePrincipal,
    id: string,
    input: {
      leaseToken: string;
      generation: number;
      result: InvestigationResult;
    },
  ) {
    const result = investigationResultSchema.parse(input.result),
      resultHash = hash(JSON.stringify(result));
    return this.atomic(machine.project_id, async () => {
      await this.fresh(machine);
      const previous = await this.store.one(
        'SELECT * FROM studio_investigations WHERE id=? AND machine_id=? AND user_id=? AND project_id=?',
        id,
        machine.id,
        machine.user_id,
        machine.project_id,
      );
      if (
        previous?.status === 'completed' &&
        previous.generation === input.generation &&
        previous.result_hash === resultHash
      )
        return { childArtifactId: previous.child_artifact_id, resultHash };
      const row = await this.leased(
        machine,
        id,
        input.leaseToken,
        input.generation,
      );
      for (const image of result.images)
        if (
          !(await this.store.one(
            'SELECT file_id FROM studio_investigation_images WHERE investigation_id=? AND file_id=? AND generation=?',
            id,
            image.fileId,
            input.generation,
          ))
        )
          throw new HttpError(
            400,
            'The report may embed only images uploaded by this investigation attempt',
          );
      const user = await this.store.publicUser(machine.user_id);
      const child = await this.store.createArtifact(
        user,
        row.project_id,
        'document',
        result.title,
        {
          doc: {
            type: 'doc',
            content: [paragraph('Preparing the investigation report.')],
          },
        },
      );
      await this.store.exec(
        "UPDATE studio_investigations SET status='completed',result_json=?,result_hash=?,child_artifact_id=?,lease_hash=NULL,lease_expires=NULL,updated_at=? WHERE id=?",
        JSON.stringify(result),
        resultHash,
        child.id,
        timestamp(),
        id,
      );
      await this.store.updateArtifact(
        user,
        child.id,
        child.version,
        this.document(row, result, user),
      );
      for (const view of result.views)
        await this.store.exec(
          'INSERT INTO studio_investigation_selections(investigation_id,view_id,revision,state_json) VALUES(?,?,?,?)',
          id,
          view.id,
          1,
          JSON.stringify(emptySelection()),
        );
      await this.store.audit(
        row.project_id,
        row.artifact_id,
        user.name,
        'investigation.published',
        JSON.stringify({ id, childArtifactId: child.id, resultHash }),
      );
      this.emit({ ...row, child_artifact_id: child.id });
      return { childArtifactId: child.id, resultHash };
    });
  }
  async fail(
    machine: MachinePrincipal,
    id: string,
    input: { leaseToken: string; generation: number; reason?: string },
  ) {
    return this.atomic(machine.project_id, async () => {
      const row = await this.leased(
        machine,
        id,
        input.leaseToken,
        input.generation,
      );
      await this.store.exec(
        "UPDATE studio_investigations SET status='failed',lease_hash=NULL,error=?,updated_at=? WHERE id=?",
        input.reason?.slice(0, 1000) ??
          'The local agent could not complete the investigation',
        timestamp(),
        id,
      );
      this.emit(row);
      return { ok: true };
    });
  }
  async selection(
    user: User,
    id: string,
    viewId: string,
    input: { revision: number; selection: Selection },
  ) {
    const initial = await this.ownRow(user, id, true);
    return this.atomic(initial.project_id, async () => {
      const row = await this.ownRow(user, id, true);
      if (row.status !== 'completed')
        throw new HttpError(
          409,
          'Only published evidence has shared selections',
        );
      const result = investigationResultSchema.parse(
          JSON.parse(row.result_json),
        ),
        view = result.views.find((v) => v.id === viewId);
      if (!view) throw new HttpError(404, 'Native view not found');
      const dataset = result.datasets.find((d) => d.id === view.datasetId)!;
      try {
        validateSelection(dataset, input.selection);
      } catch (error) {
        throw new HttpError(400, (error as Error).message);
      }
      const changed = await this.store.exec(
        'UPDATE studio_investigation_selections SET revision=revision+1,state_json=? WHERE investigation_id=? AND view_id=? AND revision=?',
        JSON.stringify(input.selection),
        id,
        viewId,
        input.revision,
      );
      if (!changed.changes)
        throw new HttpError(
          409,
          'Shared selections changed; refresh and review them before saving',
        );
      this.emit(row);
      return { revision: input.revision + 1, selection: input.selection };
    });
  }
  async decide(
    user: User,
    id: string,
    viewId: string,
    input: { revision: number; conclusion: string; rationale: string },
  ) {
    const initial = await this.ownRow(user, id, true);
    return this.atomic(initial.project_id, async () => {
      const row = await this.ownRow(user, id, true),
        state = await this.store.one(
          'SELECT * FROM studio_investigation_selections WHERE investigation_id=? AND view_id=?',
          id,
          viewId,
        );
      if (row.status !== 'completed' || !state)
        throw new HttpError(404, 'Published view not found');
      if (state.revision !== input.revision)
        throw new HttpError(
          409,
          'Selections changed; acknowledge the current selection before recording a decision',
        );
      const decision = {
        id: randomUUID(),
        investigationId: id,
        viewId,
        selectionRevision: state.revision,
        selection: JSON.parse(state.state_json),
        conclusion: input.conclusion,
        rationale: input.rationale,
        resultHash: row.result_hash,
        authorId: user.id,
        authorName: user.name,
        createdAt: timestamp(),
      };
      const sha256 = hash(JSON.stringify(decision));
      await this.store.exec(
        'INSERT INTO studio_investigation_decisions(id,investigation_id,view_id,selection_revision,selection_json,conclusion,rationale,result_hash,author_id,author_name,created_at,sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
        decision.id,
        id,
        viewId,
        state.revision,
        state.state_json,
        input.conclusion,
        input.rationale,
        row.result_hash,
        user.id,
        user.name,
        decision.createdAt,
        sha256,
      );
      await this.store.audit(
        row.project_id,
        row.artifact_id,
        user.name,
        'investigation.decision',
        decision.id,
      );
      this.emit(row);
      return { ...decision, sha256 };
    });
  }
  async uploadImage(
    machine: MachinePrincipal,
    id: string,
    input: {
      leaseToken: string;
      generation: number;
      mime: 'image/png' | 'image/jpeg' | 'image/webp';
      base64: string;
      name: string;
    },
  ) {
    const bytes = Buffer.from(input.base64, 'base64');
    if (bytes.length > 1048576 || bytes.toString('base64') !== input.base64)
      throw new HttpError(
        413,
        'Investigation screenshots must use canonical base64 and fit within 1 MiB',
      );
    const valid =
      input.mime === 'image/png'
        ? bytes
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : input.mime === 'image/jpeg'
          ? bytes[0] === 255 &&
            bytes[1] === 216 &&
            bytes.at(-2) === 255 &&
            bytes.at(-1) === 217
          : bytes.subarray(0, 4).toString() === 'RIFF' &&
            bytes.subarray(8, 12).toString() === 'WEBP';
    if (!valid)
      throw new HttpError(
        400,
        'The screenshot bytes do not match an admitted image type',
      );
    await this.ready;
    await this.atomic(machine.project_id, () =>
      this.leased(machine, id, input.leaseToken, input.generation),
    );
    const sha = hash(bytes),
      key = `projects/${machine.project_id}/investigations/${id}/${input.generation}/${sha}`;
    await this.dependencies.objects.put(key, bytes, {
      contentType: input.mime,
    });
    try {
      return await this.atomic(machine.project_id, async () => {
        const row = await this.leased(
          machine,
          id,
          input.leaseToken,
          input.generation,
        );
        const existing = await this.store.one(
          'SELECT file_id FROM studio_investigation_images WHERE investigation_id=? AND sha256=? AND generation=?',
          id,
          sha,
          input.generation,
        );
        if (existing) return { fileId: existing.file_id };
        if (
          (
            await this.store.one(
              'SELECT count(*) AS n FROM studio_investigation_images WHERE investigation_id=? AND generation=?',
              id,
              input.generation,
            )
          ).n >= 3
        )
          throw new HttpError(
            413,
            'An investigation can upload at most three distinct images',
          );
        const user = await this.store.publicUser(machine.user_id),
          file = await this.store.registerFile(user, row.artifact_id, {
            name: input.name,
            mime: input.mime,
            sha256: sha,
            storageKey: key,
            byteSize: bytes.length,
          });
        await this.store.exec(
          'INSERT INTO studio_investigation_images(investigation_id,file_id,sha256,generation) VALUES(?,?,?,?)',
          id,
          file.id,
          sha,
          input.generation,
        );
        return { fileId: file.id };
      });
    } catch (error) {
      const retained = await this.store.one(
        'SELECT file_id FROM studio_investigation_images WHERE investigation_id=? AND sha256=? AND generation=?',
        id,
        sha,
        input.generation,
      );
      if (!retained)
        await this.dependencies.objects.delete(key).catch(() => {});
      throw error;
    }
  }
  async consent(user: User, machineId: string, enabled: boolean) {
    await this.ready;
    const machine = await this.store.one(
      'SELECT * FROM studio_machines WHERE id=? AND user_id=?',
      machineId,
      user.id,
    );
    if (!machine)
      throw new HttpError(
        403,
        'Only a machine owner can change automatic execution consent',
      );
    return this.atomic(machine.project_id, async () => {
      await this.store.role(machine.project_id, user.id, 'write');
      await this.store.exec(
        'INSERT INTO studio_investigation_consent(machine_id,user_id,enabled,updated_at) VALUES(?,?,?,?) ON CONFLICT(machine_id) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at',
        machineId,
        user.id,
        enabled ? 1 : 0,
        timestamp(),
      );
      if (!enabled)
        await this.store.exec(
          "UPDATE studio_investigations SET status='cancelled',generation=generation+1,lease_hash=NULL,error='Automatic prototype consent was withdrawn',updated_at=? WHERE user_id=? AND project_id=? AND mode='spike' AND status IN ('queued','running')",
          timestamp(),
          user.id,
          machine.project_id,
        );
      return { enabled };
    });
  }
  async activeOnMachine(machineId: string) {
    await this.ready;
    return !!(await this.store.one(
      "SELECT id FROM studio_investigations WHERE machine_id=? AND status='running' AND lease_expires>?",
      machineId,
      Date.now(),
    ));
  }
  async assertReady(artifactId: string) {
    const rows = await this.required(artifactId);
    if (rows.length)
      throw new HttpError(
        409,
        'Required investigations must be completed and their findings incorporated before implementation: ' +
          rows
            .map((row) => row.brief)
            .join('; ')
            .slice(0, 1500),
      );
  }
  async required(artifactId: string) {
    await this.ready;
    return this.store.all(
      "SELECT id,brief,required_reason AS reason,status FROM studio_investigations WHERE artifact_id=? AND required_reason IS NOT NULL AND status<>'withdrawn'",
      artifactId,
    );
  }
  async acknowledgeFindings(user: User, id: string) {
    const initial = await this.ownRow(user, id, true);
    return this.atomic(initial.project_id, async () => {
      const row = await this.ownRow(user, id, true);
      if (row.status !== 'completed')
        throw new HttpError(409, 'Only completed findings can be incorporated');
      if (
        !(await this.store.one(
          'SELECT id FROM studio_investigation_decisions WHERE investigation_id=?',
          id,
        ))
      )
        throw new HttpError(
          409,
          'Record a decision explaining the incorporated evidence first',
        );
      await this.store.exec(
        'UPDATE studio_investigations SET required_reason=NULL,updated_at=? WHERE id=?',
        timestamp(),
        id,
      );
      await this.store.audit(
        row.project_id,
        row.artifact_id,
        user.name,
        'investigation.findings.incorporated',
        id,
      );
      this.emit(row);
      return this.get(user, id);
    });
  }
  /** Called only after a persisted writer edit; disabled unless an operator supplies both consented spikes and a judge. */
  async considerSpike(
    user: User,
    artifactId: string,
    input: { version: number; blockIndex: number; digest: string },
  ) {
    const config = this.dependencies.spikes;
    if (!config?.enabled || !config.judge) return null;
    await this.ready;
    const initial = await this.unlocked(artifactId, user.id),
      block = initial.content.doc?.content?.[input.blockIndex] as
        | RichNode
        | undefined;
    if (
      initial.version !== input.version ||
      !block ||
      hash(JSON.stringify(block)) !== input.digest
    )
      return null;
    if (
      !(await this.store.one(
        'SELECT c.machine_id FROM studio_investigation_consent c JOIN studio_machines m ON m.id=c.machine_id WHERE c.user_id=? AND c.enabled=1 AND m.project_id=? AND m.expires>? AND m.last_seen>?',
        user.id,
        initial.projectId,
        Date.now(),
        Date.now() - 90000,
      ))
    )
      return null;
    if (
      await this.store.one(
        'SELECT investigation_id FROM studio_investigation_passages WHERE artifact_id=? AND user_id=? AND digest=?',
        artifactId,
        user.id,
        input.digest,
      )
    )
      return null;
    const judgment = await config.judge({
      passage: docText(block).slice(0, 12000),
      context: docText(initial.content.doc).slice(0, 30000),
      signal: AbortSignal.timeout(15000),
    });
    const checked = z
      .object({
        useful: z.boolean(),
        brief: z.string().trim().min(1).max(8000),
        reason: z.string().trim().min(1).max(2000),
      })
      .strict()
      .parse(judgment);
    if (!checked.useful) return null;
    return this.atomic(initial.projectId, async () => {
      await this.store.db.lock('spike-admission:' + user.id);
      const current = await this.unlocked(artifactId, user.id),
        currentBlock = current.content.doc?.content?.[input.blockIndex];
      if (
        current.version !== input.version ||
        !currentBlock ||
        hash(JSON.stringify(currentBlock)) !== input.digest
      )
        return null;
      if (
        await this.store.one(
          'SELECT investigation_id FROM studio_investigation_passages WHERE artifact_id=? AND user_id=? AND digest=?',
          artifactId,
          user.id,
          input.digest,
        )
      )
        return null;
      const consent = await this.store.one(
        'SELECT c.machine_id FROM studio_investigation_consent c JOIN studio_machines m ON m.id=c.machine_id WHERE c.user_id=? AND c.enabled=1 AND m.project_id=? AND m.expires>? AND m.last_seen>?',
        user.id,
        initial.projectId,
        Date.now(),
        Date.now() - 90000,
      );
      if (!consent) return null;
      const active = (
        await this.store.one(
          "SELECT count(*) AS n FROM studio_investigations WHERE artifact_id=? AND mode='spike' AND status IN ('queued','running')",
          artifactId,
        )
      ).n;
      const hour = new Date(Date.now() - 3600000).toISOString();
      const perDoc = (
        await this.store.one(
          "SELECT count(*) AS n FROM studio_investigations WHERE artifact_id=? AND mode='spike' AND created_at>?",
          artifactId,
          hour,
        )
      ).n;
      const perUser = (
        await this.store.one(
          "SELECT count(*) AS n FROM studio_investigations WHERE user_id=? AND mode='spike' AND created_at>?",
          user.id,
          hour,
        )
      ).n;
      if (active >= 3 || perDoc >= 6 || perUser >= 10) return null;
      const record = await this.propose(user, artifactId, {
        version: input.version,
        brief: checked.brief + '\n\nPrototype rationale: ' + checked.reason,
        mode: 'spike',
      });
      await this.store.exec(
        'INSERT INTO studio_investigation_passages(artifact_id,user_id,digest,investigation_id) VALUES(?,?,?,?)',
        artifactId,
        user.id,
        input.digest,
        record.id,
      );
      return this.run(user, record.id);
    });
  }
  async assertCanDeleteArtifact(artifactId: string) {
    await this.ready;
    if (
      await this.store.one(
        "SELECT id FROM studio_investigations WHERE (artifact_id=? OR child_artifact_id=?) AND status='completed'",
        artifactId,
        artifactId,
      )
    )
      throw new HttpError(
        409,
        'This document is linked to published investigation evidence; archive it instead',
      );
  }
}

export async function registerInvestigationRoutes(
  app: FastifyInstance,
  dependencies: InvestigationDependencies,
) {
  const service = new InvestigationService(dependencies);
  await service.ready;
  const id = z.string().uuid(),
    generation = z.number().int().positive(),
    lease = z.object({ leaseToken: secret, generation }).strict();
  const browser = async (request: FastifyRequest) => {
    await dependencies.auth.assertOrigin(request);
    return dependencies.auth.user(request);
  };
  const principal = async (request: FastifyRequest, machineId: string) =>
    dependencies.machines.authenticate(request, id.parse(machineId));
  app.get<{ Params: { id: string } }>(
    '/api/artifacts/:id/investigations',
    async (request) =>
      service.list(
        await dependencies.auth.user(request),
        id.parse(request.params.id),
      ),
  );
  app.post<{ Params: { id: string } }>(
    '/api/artifacts/:id/investigations',
    async (request) =>
      service.propose(
        await browser(request),
        id.parse(request.params.id),
        z
          .object({
            version: z.number().int().positive(),
            brief: z.string().trim().min(1).max(8000),
            sourceCommit: commitSchema.optional(),
            requiredReason: z.string().max(2000).optional(),
          })
          .strict()
          .parse(request.body),
      ),
  );
  app.get<{ Params: { id: string } }>(
    '/api/investigations/:id',
    async (request) =>
      service.get(
        await dependencies.auth.user(request),
        id.parse(request.params.id),
      ),
  );
  for (const action of ['run', 'retry', 'cancel', 'withdraw'] as const)
    app.post<{ Params: { id: string } }>(
      `/api/investigations/:id/${action}`,
      async (request) =>
        action === 'run'
          ? service.run(await browser(request), id.parse(request.params.id))
          : service.transition(
              await browser(request),
              id.parse(request.params.id),
              action,
            ),
    );
  app.post<{ Params: { id: string } }>(
    '/api/investigations/:id/incorporate',
    async (request) =>
      service.acknowledgeFindings(
        await browser(request),
        id.parse(request.params.id),
      ),
  );
  app.put<{ Params: { id: string; viewId: string } }>(
    '/api/investigations/:id/views/:viewId/selection',
    async (request) =>
      service.selection(
        await browser(request),
        id.parse(request.params.id),
        request.params.viewId,
        z
          .object({
            revision: z.number().int().positive(),
            selection: selectionSchema,
          })
          .strict()
          .parse(request.body),
      ),
  );
  app.post<{ Params: { id: string; viewId: string } }>(
    '/api/investigations/:id/views/:viewId/decisions',
    async (request) =>
      service.decide(
        await browser(request),
        id.parse(request.params.id),
        request.params.viewId,
        z
          .object({
            revision: z.number().int().positive(),
            conclusion: z.string().trim().min(1).max(4000),
            rationale: z.string().trim().min(1).max(8000),
          })
          .strict()
          .parse(request.body),
      ),
  );
  app.put<{ Params: { machineId: string } }>(
    '/api/machines/:machineId/investigations/consent',
    async (request) =>
      service.consent(
        await browser(request),
        id.parse(request.params.machineId),
        z.object({ enabled: z.boolean() }).strict().parse(request.body).enabled,
      ),
  );
  app.post<{ Params: { machineId: string } }>(
    '/api/machines/:machineId/investigations/checkout',
    async (request) =>
      service.registerCheckout(
        await principal(request, request.params.machineId),
        z
          .object({
            repository: repositorySchema,
            sourceCommit: commitSchema,
            branch: z.string().max(250),
          })
          .strict()
          .parse(request.body),
      ),
  );
  app.post<{ Params: { machineId: string } }>(
    '/api/machines/:machineId/investigations/claim',
    async (request) =>
      service.claim(await principal(request, request.params.machineId)),
  );
  app.post<{ Params: { machineId: string; id: string } }>(
    '/api/machines/:machineId/investigations/:id/heartbeat',
    async (request) => {
      const body = lease.parse(request.body);
      return service.heartbeat(
        await principal(request, request.params.machineId),
        id.parse(request.params.id),
        body.leaseToken,
        body.generation,
      );
    },
  );
  app.post<{ Params: { machineId: string; id: string } }>(
    '/api/machines/:machineId/investigations/:id/complete',
    async (request) =>
      service.complete(
        await principal(request, request.params.machineId),
        id.parse(request.params.id),
        lease
          .extend({ result: investigationResultSchema })
          .strict()
          .parse(request.body),
      ),
  );
  app.post<{ Params: { machineId: string; id: string } }>(
    '/api/machines/:machineId/investigations/:id/fail',
    async (request) =>
      service.fail(
        await principal(request, request.params.machineId),
        id.parse(request.params.id),
        lease
          .extend({ reason: z.string().max(1000).optional() })
          .strict()
          .parse(request.body),
      ),
  );
  app.post<{ Params: { machineId: string; id: string } }>(
    '/api/machines/:machineId/investigations/:id/image',
    async (request) =>
      service.uploadImage(
        await principal(request, request.params.machineId),
        id.parse(request.params.id),
        lease
          .extend({
            mime: z.enum(['image/png', 'image/jpeg', 'image/webp']),
            base64: z.string().max(1398104),
            name: z.string().min(1).max(180),
          })
          .strict()
          .parse(request.body),
      ),
  );
  return service;
}
