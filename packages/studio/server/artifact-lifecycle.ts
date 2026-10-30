import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Auth } from './auth.ts';
import { HttpError, hash, type Store } from './store.ts';
import type { Artifact, User } from '../shared/domain.ts';
import type { ObjectStore } from './hosting/ports.ts';
import {
  restoreArtifactSchema,
  purgeArtifactSchema,
  type LifecycleBlocker,
  type ArchivedArtifact,
} from '../shared/artifact-lifecycle.ts';
const now = () => new Date().toISOString(),
  identifier = (name: string) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      throw new Error('Untrusted database identifier');
    return '"' + name + '"';
  };
const ownedCascade = new Set([
  'decisions',
  'threads',
  'messages',
  'revisions',
  'audit',
  'runs',
  'files',
  'links',
  'document_suggestions',
  'document_answers',
  'document_decision_anchors',
  'studio_decision_profiles',
  'studio_decision_calls',
  'studio_design_review_requests',
  'studio_agent_profiles',
  'studio_design_flows',
  'studio_uploads',
  'studio_spike_candidates',
  'studio_spike_checks',
  'studio_machine_work',
  'studio_remote_planners',
  'studio_remote_requests',
  'implementation_heads',
  'implementation_graphs',
  'implementation_runs',
  'implementation_events',
  'studio_implementation_machine_queue',
  'studio_rebuild_baselines',
  'studio_rebuild_pending',
  'studio_rebuild_runs',
  'studio_title_state',
  'implementation_draft_requests',
  'studio_conversation_snapshots',
  'studio_conversation_cards',
  'studio_agent_policy',
  'studio_agent_jobs',
  'studio_planner_owners',
  'studio_agent_schedule',
  'studio_durable_jobs',
  'studio_runner_workspaces',
  'video_render_jobs',
  'audio_render_jobs',
  'studio_artifact_lifecycle',
  'studio_investigation_passages',
]);
export type ArtifactLifecycleDependencies = {
  store: Store;
  auth: Auth;
  objects: ObjectStore;
  assertEditable?: (artifact: Artifact) => Promise<void>;
  hasActivity?: (artifactId: string) => Promise<boolean>;
  notify?: (projectId: string, artifactId: string) => void | Promise<void>;
};
export class ArtifactLifecycle {
  readonly ready: Promise<void>;
  constructor(readonly options: ArtifactLifecycleDependencies) {
    this.ready = this.initialize();
  }
  get store() {
    return this.options.store;
  }
  private async initialize() {
    await this.store.tx(async () => {
      await this.store.lock('schema:studio.artifact-lifecycle');
      await this.store.db.exec(`
CREATE TABLE IF NOT EXISTS studio_artifact_lifecycle(artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,revision BIGINT NOT NULL DEFAULT 0,archived_at TEXT,archived_by TEXT,restored_at TEXT);
CREATE TABLE IF NOT EXISTS studio_artifact_deletions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,artifact_id TEXT UNIQUE NOT NULL,title TEXT NOT NULL,kind TEXT NOT NULL,source_version BIGINT NOT NULL,archive_revision BIGINT NOT NULL,actor_id TEXT NOT NULL,actor_name TEXT NOT NULL,counts_json TEXT NOT NULL,deleted_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS studio_artifact_object_cleanup(id TEXT PRIMARY KEY,storage_key TEXT UNIQUE,project_id TEXT NOT NULL,deletion_id TEXT NOT NULL,state TEXT NOT NULL,lease_owner TEXT,lease_expires BIGINT NOT NULL DEFAULT 0,attempts BIGINT NOT NULL DEFAULT 0,next_attempt BIGINT NOT NULL DEFAULT 0,created_at TEXT NOT NULL,finished_at TEXT);
CREATE INDEX IF NOT EXISTS studio_artifact_cleanup_due ON studio_artifact_object_cleanup(state,next_attempt,lease_expires);
`);
    });
    const previous = this.store.fileStorageGuard;
    this.store.fileStorageGuard = async (key, artifact) => {
      await previous?.(key, artifact);
      await this.guardStorageKey(key);
    };
  }
  async guardStorageKey(key: string) {
    await this.ready;
    if (!this.store.db.inTransaction())
      throw new Error('Object registration guard requires its transaction');
    await this.store.lock('artifact-object-lifecycle');
    if (
      await this.store.one(
        'SELECT id FROM studio_artifact_object_cleanup WHERE storage_key=? OR id=?',
        key,
        'sha256:' + hash(key),
      )
    )
      throw new HttpError(
        409,
        'This immutable asset key belongs to a permanently deleted artifact',
      );
  }
  private async atomic<T>(projectId: string, work: () => Promise<T>) {
    await this.ready;
    return this.store.tx(async () => {
      await this.store.lock('project:' + projectId);
      return work();
    });
  }
  private async tables() {
    return new Set(
      (
        await this.store.all(
          this.store.db.dialect === 'sqlite'
            ? "SELECT name AS name FROM sqlite_master WHERE type='table'"
            : 'SELECT table_name AS name FROM information_schema.tables WHERE table_schema=current_schema()',
        )
      ).map((row) => row.name as string),
    );
  }
  private async columns(table: string) {
    return new Set(
      (
        await this.store.all(
          this.store.db.dialect === 'sqlite'
            ? `PRAGMA table_info(${identifier(table)})`
            : 'SELECT column_name AS name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=?',
          ...(this.store.db.dialect === 'sqlite' ? [] : [table]),
        )
      ).map((row) => row.name as string),
    );
  }
  private async foreignEdges(tables: Set<string>) {
    const edges: {
      table: string;
      column: string;
      target: string;
      rule: string;
    }[] = [];
    if (this.store.db.dialect === 'sqlite') {
      for (const table of tables) {
        if (table.startsWith('sqlite_')) continue;
        for (const row of await this.store.all(
          `PRAGMA foreign_key_list(${identifier(table)})`,
        ))
          if (['artifacts', 'files'].includes(row.table))
            edges.push({
              table,
              column: row.from,
              target: row.table,
              rule: row.on_delete,
            });
      }
    } else {
      const rows = await this.store.all(
        "SELECT src.relname AS table_name,attr.attname AS column_name,dst.relname AS target,con.confdeltype AS rule FROM pg_constraint con JOIN pg_class src ON src.oid=con.conrelid JOIN pg_namespace ns ON ns.oid=src.relnamespace JOIN pg_class dst ON dst.oid=con.confrelid CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS key(attnum,position) JOIN pg_attribute attr ON attr.attrelid=src.oid AND attr.attnum=key.attnum WHERE con.contype='f' AND ns.nspname=current_schema() AND dst.relname IN ('artifacts','files')",
      );
      for (const row of rows)
        edges.push({
          table: row.table_name,
          column: row.column_name,
          target: row.target,
          rule:
            (
              {
                c: 'CASCADE',
                n: 'SET NULL',
                r: 'RESTRICT',
                a: 'NO ACTION',
                d: 'SET DEFAULT',
              } as any
            )[row.rule] ?? row.rule,
        });
    }
    return edges;
  }
  private async main(artifact: Artifact) {
    return (
      (
        await this.store.one(
          'SELECT main_artifact_id FROM projects WHERE id=?',
          artifact.projectId,
        )
      )?.main_artifact_id === artifact.id
    );
  }
  private reject(blockers: LifecycleBlocker[]) {
    const error = new HttpError(
      409,
      blockers[0]?.message ?? 'Related workflow records prevent this action',
    ) as HttpError & { blockers: LifecycleBlocker[] };
    error.blockers = blockers;
    throw error;
  }
  private async activity(
    artifact: Artifact,
    tables: Set<string>,
    allowRunningBuild = false,
  ) {
    const result: LifecycleBlocker[] = [];
    for (const [table, activeFilter, label] of [
      [
        'studio_durable_jobs',
        "status IN ('queued','running')",
        'A durable workflow is queued or running. Stop it before changing the archive.',
      ],
      [
        'studio_decision_calls',
        "status IN ('queued','running')",
        'A model assessment is queued or running. Wait for it to finish.',
      ],
      [
        'studio_machine_work',
        "status IN ('queued','running')",
        'A connected machine still has active work. Stop it in Connections first.',
      ],
      [
        'studio_implementation_machine_queue',
        "status IN ('queued','launching','claiming','running')",
        'An implementation is active. Stop it and review the retained checkout first.',
      ],
      [
        'implementation_runs',
        "status='running'",
        'An approved implementation graph is locked by its running agent.',
      ],
      [
        'studio_rebuild_runs',
        "status IN ('queued','running')",
        'An existing-PR rebuild is active. Stop the rebuild first.',
      ],
      [
        'studio_investigations',
        "status IN ('queued','running')",
        'An investigation is active. Stop or withdraw it first.',
      ],
    ] as const) {
      if (!tables.has(table)) continue;
      if (allowRunningBuild && table === 'implementation_runs') continue;
      const filter =
        allowRunningBuild &&
        ['studio_implementation_machine_queue', 'studio_rebuild_runs'].includes(
          table,
        )
          ? "status IN ('queued','launching','claiming')"
          : activeFilter;
      const row = await this.store.one(
        `SELECT id FROM ${identifier(table)} WHERE artifact_id=? AND ${filter} LIMIT 1`,
        artifact.id,
      );
      if (row) result.push({ kind: 'active-work', message: label, id: row.id });
    }
    if (
      tables.has('studio_runner_workspaces') &&
      (await this.store.one(
        'SELECT artifact_id FROM studio_runner_workspaces WHERE artifact_id=? AND task_token IS NOT NULL AND task_expires>?',
        artifact.id,
        Date.now(),
      ))
    )
      result.push({
        kind: 'active-work',
        message:
          'A test workspace is being prepared. Wait for its lease to finish.',
      });
    if (await this.options.hasActivity?.(artifact.id))
      result.push({
        kind: 'active-work',
        message:
          'An assistant has live background work or unanswered questions. Stop that activity before changing the archive.',
      });
    return result;
  }
  private async counts(id: string, tables: Set<string>) {
    const value = {
      messages: 0,
      threads: 0,
      decisions: 0,
      revisions: 0,
      files: 0,
    };
    for (const table of Object.keys(value) as (keyof typeof value)[])
      if (tables.has(table))
        value[table] = Number(
          (
            await this.store.one(
              `SELECT COUNT(*) AS n FROM ${identifier(table)} WHERE artifact_id=?`,
              id,
            )
          ).n,
        );
    return value;
  }
  private async blockers(
    artifact: Artifact,
    tables: Set<string>,
    purge = true,
  ) {
    const blockers: LifecycleBlocker[] = [];
    if (await this.main(artifact))
      blockers.push({
        kind: 'main-design',
        message: 'The main design artifact must remain in its project.',
      });
    blockers.push(...(await this.activity(artifact, tables, !purge)));
    if (!purge) return blockers;
    for (const [table, filter, message] of [
      [
        'runs',
        '1=1',
        'Recorded acceptance runs and their evidence must remain linked. Keep this artifact archived.',
      ],
      [
        'implementation_runs',
        '1=1',
        'Implementation runs and pull-request evidence must remain linked. Keep this artifact archived.',
      ],
      [
        'studio_rebuild_baselines',
        '1=1',
        'The delivered source baseline must remain linked to its reviewed implementation.',
      ],
      [
        'studio_rebuild_runs',
        '1=1',
        'Rebuild source and verification receipts must remain linked.',
      ],
      [
        'studio_runner_workspaces',
        'reference_json IS NOT NULL',
        'A retained test workspace depends on this artifact.',
      ],
      [
        'studio_agent_jobs',
        'child_artifact_id IS NOT NULL',
        'A published child artifact depends on this research record.',
      ],
    ] as const)
      if (
        tables.has(table) &&
        (await this.store.one(
          `SELECT artifact_id FROM ${identifier(table)} WHERE artifact_id=? AND ${filter} LIMIT 1`,
          artifact.id,
        ))
      )
        blockers.push({ kind: 'published-evidence', message });
    if (tables.has('studio_agent_jobs')) {
      const row = await this.store.one(
        'SELECT id,artifact_id FROM studio_agent_jobs WHERE child_artifact_id=? LIMIT 1',
        artifact.id,
      );
      if (row)
        blockers.push({
          kind: 'published-child',
          id: row.id,
          artifactId: row.artifact_id,
          message:
            'This published child belongs to a retained research lifecycle.',
        });
    }
    if (tables.has('studio_investigations')) {
      const row = await this.store.one(
        "SELECT id,artifact_id,child_artifact_id FROM studio_investigations WHERE (artifact_id=? OR child_artifact_id=?) AND (child_artifact_id IS NOT NULL OR result_json IS NOT NULL OR status='completed') LIMIT 1",
        artifact.id,
        artifact.id,
      );
      if (row)
        blockers.push({
          kind: 'published-evidence',
          id: row.id,
          artifactId: row.artifact_id,
          message:
            'Published investigation evidence and its parent/child relationship are immutable. Keep this artifact archived.',
        });
    }
    if (
      tables.has('studio_investigation_decisions') &&
      (await this.store.one(
        'SELECT d.id FROM studio_investigation_decisions d JOIN studio_investigations i ON i.id=d.investigation_id WHERE i.artifact_id=? OR i.child_artifact_id=? LIMIT 1',
        artifact.id,
        artifact.id,
      ))
    )
      blockers.push({
        kind: 'published-evidence',
        message:
          'An attributed investigation decision must remain linked to its exact source.',
      });
    if (tables.has('studio_uploads')) {
      const row = await this.store.one(
        'SELECT id,expires_at FROM studio_uploads WHERE artifact_id=? AND expires_at>? ORDER BY expires_at DESC LIMIT 1',
        artifact.id,
        Date.now(),
      );
      if (row)
        blockers.push({
          kind: 'pending-upload',
          id: row.id,
          retryAt: Number(row.expires_at),
          message:
            'A private upload capability is still valid. Wait for it to expire before permanently deleting this artifact.',
        });
    }
    const contains = (column: string, needle: string) =>
      this.store.db.dialect === 'sqlite'
        ? `instr(lower(${column}),lower(${needle}))>0`
        : `strpos(lower(${column}),lower(${needle}))>0`;
    const foreignEdges = await this.foreignEdges(tables);
    // Every artifact-owned text record participates, including future workflow JSON.
    // Unknown dependency tables still default to a typed denial below.
    const referenceTables = new Set([
      'artifacts',
      ...foreignEdges
        .filter(
          (edge) =>
            edge.target === 'artifacts' && edge.column === 'artifact_id',
        )
        .map((edge) => edge.table),
    ]);
    for (const table of referenceTables) {
      const textRows = await this.store.all(
        this.store.db.dialect === 'sqlite'
          ? `PRAGMA table_info(${identifier(table)})`
          : 'SELECT column_name AS name,data_type AS type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=?',
        ...(this.store.db.dialect === 'sqlite' ? [] : [table]),
      );
      const fields = textRows
        .filter(
          (row) =>
            /TEXT|CHAR/i.test(row.type) &&
            ![
              'id',
              'artifact_id',
              'project_id',
              'user_id',
              'created_at',
              'updated_at',
            ].includes(row.name),
        )
        .map((row) => `coalesce(s.${identifier(row.name)},'')`);
      if (!fields.length) continue;
      const content = '(' + fields.join(' || ') + ')',
        own = table === 'artifacts',
        scope = own
          ? 's.project_id=? AND s.id<>?'
          : 'a.project_id=? AND s.artifact_id<>?',
        from =
          identifier(table) +
          ' s' +
          (own ? '' : ' JOIN artifacts a ON a.id=s.artifact_id');
      const row = await this.store.one(
        `SELECT ${own ? 's.id' : 's.artifact_id'} AS artifact_id FROM ${from} WHERE ${scope} AND (${contains(content, '?')} OR EXISTS(SELECT 1 FROM files f WHERE f.artifact_id=? AND ${contains(content, 'f.id')})) LIMIT 1`,
        artifact.projectId,
        artifact.id,
        artifact.id,
        artifact.id,
      );
      if (row)
        blockers.push({
          kind: 'source-reference',
          artifactId: row.artifact_id,
          message:
            'Another artifact or its retained history references this artifact or one of its assets.',
        });
    }

    for (const edge of foreignEdges) {
      if (edge.table === 'studio_investigations') continue;
      if (edge.target === 'artifacts') {
        if (
          edge.column === 'artifact_id' &&
          ownedCascade.has(edge.table) &&
          edge.rule === 'CASCADE'
        )
          continue;
        if (
          edge.table === 'studio_agent_jobs' &&
          edge.column === 'child_artifact_id'
        )
          continue;
        const row = await this.store.one(
          `SELECT COUNT(*) AS n FROM ${identifier(edge.table)} WHERE ${identifier(edge.column)}=?`,
          artifact.id,
        );
        if (Number(row.n))
          blockers.push({
            kind: 'retained-records',
            count: Number(row.n),
            message:
              'Related saved workflow records require this artifact. Restore it to review those dependencies.',
          });
      } else {
        const cols = await this.columns(edge.table),
          owned =
            cols.has('artifact_id') &&
            ['video_render_jobs', 'audio_render_jobs'].includes(edge.table);
        const row = await this.store.one(
          `SELECT COUNT(*) AS n FROM ${identifier(edge.table)} WHERE ${identifier(edge.column)} IN (SELECT id FROM files WHERE artifact_id=?)${owned ? ' AND artifact_id<>?' : ''}`,
          artifact.id,
          ...(owned ? [artifact.id] : []),
        );
        if (Number(row.n))
          blockers.push({
            kind: 'asset-reference',
            count: Number(row.n),
            message:
              'An immutable evidence or workflow record still references an uploaded asset.',
          });
      }
    }
    return blockers.slice(0, 200);
  }
  private async item(artifact: Artifact): Promise<ArchivedArtifact> {
    const state = await this.store.one(
      'SELECT * FROM studio_artifact_lifecycle WHERE artifact_id=?',
      artifact.id,
    );
    return {
      id: artifact.id,
      projectId: artifact.projectId,
      title: artifact.title,
      kind: artifact.kind,
      version: artifact.version,
      archived: artifact.archived,
      updatedAt: artifact.updatedAt,
      archiveRevision: Number(state?.revision ?? 0),
      archivedAt: state?.archived_at ?? null,
    };
  }
  async list(user: User, projectId: string, after = 0, limit = 50) {
    await this.ready;
    await this.store.role(projectId, user.id);
    const rows = await this.store.all(
      'SELECT a.id,a.rowid AS cursor FROM artifacts a WHERE a.project_id=? AND a.archived=1 AND a.rowid>? ORDER BY a.rowid LIMIT ?',
      projectId,
      after,
      limit + 1,
    );
    const items = [];
    for (const row of rows.slice(0, limit))
      items.push(await this.item(await this.store.artifact(row.id, user.id)));
    await this.store.role(projectId, user.id);
    return {
      items,
      nextCursor: rows.length > limit ? Number(rows[limit - 1]!.cursor) : null,
    };
  }
  async inspect(user: User, id: string) {
    const initial = await this.store.artifact(id, user.id);
    return this.atomic(initial.projectId, async () => {
      const artifact = await this.store.artifact(id, user.id),
        role = await this.store.role(artifact.projectId, user.id);
      const tables = await this.tables();
      return {
        artifact: await this.item(artifact),
        canManage: role === 'owner',
        restoreBlockers: await this.blockers(artifact, tables, false),
        blockers: await this.blockers(artifact, tables),
        counts: await this.counts(id, tables),
      };
    });
  }
  private async notify(projectId: string, id: string) {
    try {
      await this.options.notify?.(projectId, id);
    } catch {}
  }
  async archive(user: User, id: string, version?: number) {
    const initial = await this.store.artifact(id, user.id);
    await this.store.role(initial.projectId, user.id, 'admin');
    await this.atomic(initial.projectId, async () => {
      await this.store.role(initial.projectId, user.id, 'admin');
      const artifact = await this.store.artifact(id, user.id);
      if (artifact.archived) return;
      if (version !== undefined && artifact.version !== version)
        throw new HttpError(
          409,
          'The source changed; review it before archiving',
        );
      const tables = await this.tables(),
        blocked = await this.blockers(artifact, tables, false);
      if (blocked.length) this.reject(blocked);
      await this.store.exec(
        'UPDATE artifacts SET archived=1,updated_at=? WHERE id=?',
        now(),
        id,
      );
      await this.store.exec(
        'INSERT INTO studio_artifact_lifecycle(artifact_id,revision,archived_at,archived_by) VALUES(?,1,?,?) ON CONFLICT(artifact_id) DO UPDATE SET revision=studio_artifact_lifecycle.revision+1,archived_at=excluded.archived_at,archived_by=excluded.archived_by',
        id,
        now(),
        user.id,
      );
      if (tables.has('studio_agent_policy'))
        await this.store.exec(
          'UPDATE studio_agent_policy SET paused=1 WHERE artifact_id=?',
          id,
        );
      if (tables.has('studio_title_state'))
        await this.store.exec(
          'UPDATE studio_title_state SET epoch=epoch+1 WHERE artifact_id=?',
          id,
        );
      for (const table of [
        'studio_rebuild_pending',
        'studio_spike_candidates',
        'studio_planner_owners',
        'studio_remote_planners',
      ])
        if (tables.has(table))
          await this.store.exec(
            `DELETE FROM ${identifier(table)} WHERE artifact_id=?`,
            id,
          );
      await this.store.audit(
        artifact.projectId,
        id,
        user.name,
        'artifact.archived',
      );
    });
    await this.notify(initial.projectId, id);
    return { ok: true };
  }
  async restore(
    user: User,
    id: string,
    input: z.infer<typeof restoreArtifactSchema>,
  ) {
    const initial = await this.store.artifact(id, user.id);
    await this.store.role(initial.projectId, user.id, 'admin');
    await this.atomic(initial.projectId, async () => {
      await this.store.role(initial.projectId, user.id, 'admin');
      const artifact = await this.store.artifact(id, user.id),
        item = await this.item(artifact);
      if (
        !artifact.archived ||
        artifact.version !== input.version ||
        item.archiveRevision !== input.archiveRevision
      )
        throw new HttpError(
          409,
          'The archive changed; refresh before restoring',
        );
      const blocked = await this.blockers(artifact, await this.tables(), false);
      if (blocked.length) this.reject(blocked);
      await this.store.exec(
        'UPDATE artifacts SET archived=0,updated_at=? WHERE id=?',
        now(),
        id,
      );
      await this.store.exec(
        'INSERT INTO studio_artifact_lifecycle(artifact_id,revision,restored_at) VALUES(?,1,?) ON CONFLICT(artifact_id) DO UPDATE SET revision=studio_artifact_lifecycle.revision+1,restored_at=excluded.restored_at',
        id,
        now(),
      );
      await this.store.audit(
        artifact.projectId,
        id,
        user.name,
        'artifact.restored',
      );
    });
    await this.notify(initial.projectId, id);
    return { ok: true };
  }
  async purge(
    user: User,
    id: string,
    input: z.infer<typeof purgeArtifactSchema>,
  ) {
    await this.ready;
    const previous = await this.store.one(
      'SELECT * FROM studio_artifact_deletions WHERE artifact_id=?',
      id,
    );
    if (previous) {
      await this.store.role(previous.project_id, user.id, 'admin');
      return { deleted: true, alreadyDeleted: true, receiptId: previous.id };
    }
    const initial = await this.store.artifact(id, user.id);
    await this.store.role(initial.projectId, user.id, 'admin');
    const output = await this.atomic(initial.projectId, async () => {
      await this.store.role(initial.projectId, user.id, 'admin');
      const existing = await this.store.one(
        'SELECT id FROM studio_artifact_deletions WHERE artifact_id=?',
        id,
      );
      if (existing)
        return { deleted: true, alreadyDeleted: true, receiptId: existing.id };
      const artifact = await this.store.artifact(id, user.id),
        state = await this.item(artifact);
      if (
        !artifact.archived ||
        artifact.version !== input.version ||
        state.archiveRevision !== input.archiveRevision ||
        input.confirmTitle !== artifact.title
      )
        throw new HttpError(
          409,
          'Permanent deletion requires the exact archived source, archive revision and title',
        );
      const tables = await this.tables(),
        blocked = await this.blockers(artifact, tables);
      if (blocked.length) this.reject(blocked);
      await this.options.assertEditable?.(artifact);
      await this.store.lock('artifact-object-lifecycle');
      const receipt = randomUUID(),
        counts = await this.counts(id, tables),
        date = now();
      await this.store.exec(
        'INSERT INTO studio_artifact_deletions(id,project_id,artifact_id,title,kind,source_version,archive_revision,actor_id,actor_name,counts_json,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        receipt,
        artifact.projectId,
        id,
        artifact.title,
        artifact.kind,
        artifact.version,
        state.archiveRevision,
        user.id,
        user.name,
        JSON.stringify(counts),
        date,
      );
      await this.store.exec(
        "INSERT INTO studio_artifact_object_cleanup(id,storage_key,project_id,deletion_id,state,created_at) SELECT DISTINCT 'raw:'||f.storage_key,f.storage_key,?,?, 'pending',? FROM files f WHERE f.artifact_id=? AND f.storage_key IS NOT NULL AND NOT EXISTS(SELECT 1 FROM files other WHERE other.storage_key=f.storage_key AND other.artifact_id<>?) ON CONFLICT(id) DO NOTHING",
        artifact.projectId,
        receipt,
        date,
        id,
        id,
      );
      if (tables.has('studio_uploads'))
        await this.store.exec(
          "INSERT INTO studio_artifact_object_cleanup(id,storage_key,project_id,deletion_id,state,created_at) SELECT 'raw:'||u.storage_key,u.storage_key,?,?, 'pending',? FROM studio_uploads u WHERE u.artifact_id=? AND NOT EXISTS(SELECT 1 FROM files f WHERE f.storage_key=u.storage_key AND f.artifact_id<>?) ON CONFLICT(id) DO NOTHING",
          artifact.projectId,
          receipt,
          date,
          id,
          id,
        );
      for (const table of ['studio_video_staging', 'studio_audio_staging'])
        if (tables.has(table))
          await this.store.exec(
            `INSERT INTO studio_artifact_object_cleanup(id,storage_key,project_id,deletion_id,state,created_at) SELECT 'raw:'||s.object_key,s.object_key,?,?, 'pending',? FROM ${identifier(table)} s JOIN studio_durable_jobs j ON j.id=s.job_id WHERE j.artifact_id=? AND NOT EXISTS(SELECT 1 FROM files f WHERE f.storage_key=s.object_key AND f.artifact_id<>?) ON CONFLICT(id) DO NOTHING`,
            artifact.projectId,
            receipt,
            date,
            id,
            id,
          );
      if (tables.has('studio_investigations')) {
        if (tables.has('studio_investigation_passages'))
          await this.store.exec(
            'DELETE FROM studio_investigation_passages WHERE investigation_id IN (SELECT id FROM studio_investigations WHERE artifact_id=?)',
            id,
          );
        await this.store.exec(
          'DELETE FROM studio_investigations WHERE artifact_id=? AND child_artifact_id IS NULL AND result_json IS NULL',
          id,
        );
      }
      await this.store.exec(
        'DELETE FROM artifacts WHERE id=? AND archived=1',
        id,
      );
      await this.store.audit(
        artifact.projectId,
        null,
        user.name,
        'artifact.permanently-deleted',
        JSON.stringify({
          receiptId: receipt,
          artifactId: id,
          title: artifact.title,
          counts,
        }),
      );
      const pending = Number(
        (
          await this.store.one(
            "SELECT COUNT(*) AS n FROM studio_artifact_object_cleanup WHERE deletion_id=? AND state IN ('pending','deleting')",
            receipt,
          )
        ).n,
      );
      return {
        deleted: true,
        alreadyDeleted: false,
        receiptId: receipt,
        cleanupPending: pending > 0,
      };
    });
    await this.notify(initial.projectId, id);
    return output;
  }
  async cleanup(limit = 3) {
    await this.ready;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20)
      throw new Error('Cleanup batch must be between1 and20');
    const rows = await this.store.all(
      "SELECT id,project_id FROM studio_artifact_object_cleanup WHERE (state='pending' AND next_attempt<=?) OR (state='deleting' AND lease_expires<?) ORDER BY created_at,id LIMIT ?",
      Date.now(),
      Date.now(),
      limit,
    );
    for (const candidate of rows) {
      const owner = randomUUID(),
        row = await this.atomic(candidate.project_id, async () => {
          await this.store.lock('artifact-object-lifecycle');
          const current = await this.store.one(
            "SELECT * FROM studio_artifact_object_cleanup WHERE id=? AND ((state='pending' AND next_attempt<=?) OR (state='deleting' AND lease_expires<?))",
            candidate.id,
            Date.now(),
            Date.now(),
          );
          if (!current) return null;
          if (
            await this.store.one(
              'SELECT id FROM files WHERE storage_key=? LIMIT 1',
              current.storage_key,
            )
          ) {
            await this.store.exec(
              "UPDATE studio_artifact_object_cleanup SET id=?,storage_key=NULL,state='retained',finished_at=? WHERE id=?",
              'sha256:' + hash(current.storage_key),
              now(),
              current.id,
            );
            return null;
          }
          await this.store.exec(
            "UPDATE studio_artifact_object_cleanup SET state='deleting',lease_owner=?,lease_expires=?,attempts=attempts+1 WHERE id=?",
            owner,
            Date.now() + 60000,
            current.id,
          );
          return current;
        });
      if (!row) continue;
      try {
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            this.options.objects.delete(row.storage_key),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error('Object cleanup deadline')),
                20000,
              );
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        await this.atomic(row.project_id, async () => {
          await this.store.exec(
            "UPDATE studio_artifact_object_cleanup SET id=?,storage_key=NULL,state='deleted',lease_owner=NULL,lease_expires=0,finished_at=? WHERE id=? AND state='deleting' AND lease_owner=?",
            'sha256:' + hash(row.storage_key),
            now(),
            row.id,
            owner,
          );
        });
      } catch {
        await this.atomic(row.project_id, () =>
          this.store.exec(
            "UPDATE studio_artifact_object_cleanup SET state='pending',lease_owner=NULL,lease_expires=0,next_attempt=? WHERE id=? AND lease_owner=?",
            Date.now() +
              Math.min(3600000, 1000 * 2 ** Math.min(Number(row.attempts), 10)),
            row.id,
            owner,
          ),
        );
      }
    }
  }
}
export async function registerArtifactLifecycle(
  app: FastifyInstance,
  options: ArtifactLifecycleDependencies,
) {
  const service = new ArtifactLifecycle(options);
  await service.ready;
  const id = z.string().uuid();
  const person = async (request: any) => {
    options.auth.assertOrigin(request);
    if (request.headers.authorization)
      throw new HttpError(
        403,
        'Permanent deletion requires a person and explicit confirmation',
      );
    return options.auth.user(request);
  };
  app.get<{
    Params: { id: string };
    Querystring: { after?: string; limit?: string };
  }>('/api/projects/:id/archive', async (request) => {
    const query = z
      .object({
        after: z.coerce.number().int().nonnegative().default(0),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .strict()
      .parse(request.query);
    return service.list(
      await options.auth.user(request),
      id.parse(request.params.id),
      query.after,
      query.limit,
    );
  });
  app.get<{ Params: { id: string } }>(
    '/api/artifacts/:id/lifecycle',
    async (request) =>
      service.inspect(
        await options.auth.user(request),
        id.parse(request.params.id),
      ),
  );
  app.post<{ Params: { id: string } }>(
    '/api/artifacts/:id/restore',
    async (request) => {
      options.auth.assertOrigin(request);
      return service.restore(
        await options.auth.user(request),
        id.parse(request.params.id),
        restoreArtifactSchema.parse(request.body),
      );
    },
  );
  app.delete<{ Params: { id: string } }>(
    '/api/artifacts/:id',
    async (request) =>
      service.purge(
        await person(request),
        id.parse(request.params.id),
        purgeArtifactSchema.parse(request.body),
      ),
  );
  return service;
}
