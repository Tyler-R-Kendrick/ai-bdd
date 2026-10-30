import type { Store } from '../store.ts';
/** Credential-free investigation records and native view state. Source text and evidence are bounded by admission validation. */
const tables = [
  {
    name: 'studio_investigations',
    kind: 'investigation',
    columns:
      't.id,t.artifact_id AS artifactId,t.project_id AS projectId,t.user_id AS ownerId,t.artifact_version AS artifactVersion,t.source_commit AS sourceCommit,t.repository,t.brief,t.brief_hash AS briefHash,t.snapshot_json AS sourceSnapshot,t.status,t.generation,t.result_json AS result,t.result_hash AS resultHash,t.child_artifact_id AS childArtifactId,t.error,t.required_reason AS requiredReason,t.mode,t.created_at AS createdAt,t.updated_at AS updatedAt',
    own: true,
    json: ['sourceSnapshot', 'result'],
  },
  {
    name: 'studio_investigation_selections',
    kind: 'investigationSelection',
    columns:
      't.investigation_id AS investigationId,t.view_id AS viewId,t.revision,t.state_json AS state',
    own: false,
    json: ['state'],
  },
  {
    name: 'studio_investigation_decisions',
    kind: 'investigationDecision',
    columns:
      't.id,t.investigation_id AS investigationId,t.view_id AS viewId,t.selection_revision AS selectionRevision,t.selection_json AS selection,t.conclusion,t.rationale,t.result_hash AS resultHash,t.author_id AS authorId,t.author_name AS author,t.created_at AS createdAt,t.sha256',
    own: false,
    json: ['selection'],
  },
  {
    name: 'studio_investigation_images',
    kind: 'investigationImage',
    columns:
      't.investigation_id AS investigationId,t.file_id AS fileId,t.sha256,t.generation',
    own: false,
    json: [],
  },
] as const;
export async function* investigationExportRows(
  store: Store,
  artifactId: string,
  checkAccess: () => Promise<void>,
) {
  const scopes = tables.map((table) => ({
    table,
    from: `${table.name} t${table.own ? '' : ' JOIN studio_investigations i ON i.id=t.investigation_id'}`,
    filter: `(${table.own ? 't' : 'i'}.artifact_id=? OR ${table.own ? 't' : 'i'}.child_artifact_id=?)`,
  }));
  const bounds = await Promise.all(
    scopes.map(async (scope) =>
      Number(
        (
          await store.one(
            `SELECT coalesce(max(t.rowid),0) AS cutoff FROM ${scope.from} WHERE ${scope.filter}`,
            artifactId,
            artifactId,
          )
        ).cutoff,
      ),
    ),
  );
  for (const [index, scope] of scopes.entries()) {
    let cursor = 0;
    while (cursor < bounds[index]!) {
      await checkAccess();
      const rows = await store.all(
        `SELECT t.rowid AS sequence,${scope.table.columns} FROM ${scope.from} WHERE ${scope.filter} AND t.rowid>? AND t.rowid<=? ORDER BY t.rowid LIMIT 10`,
        artifactId,
        artifactId,
        cursor,
        bounds[index],
      );
      if (!rows.length) break;
      for (const row of rows) {
        await checkAccess();
        cursor = Number(row.sequence);
        delete row.sequence;
        for (const field of scope.table.json)
          if (typeof row[field] === 'string')
            row[field] = JSON.parse(row[field]);
        yield { kind: scope.table.kind, value: row };
      }
    }
  }
}
