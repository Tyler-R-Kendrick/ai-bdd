import type { Store } from '../store.ts';
/** Bounded, credential-free history. Provider leases and credentials are never export fields. */
const tables = [
  {
    name: 'studio_decision_profiles',
    kind: 'profile',
    from: 'studio_decision_profiles t',
    where: 't.artifact_id=?',
    columns:
      't.artifact_id AS artifactId,t.profile_json AS profile,t.revision,t.updated_by AS updatedBy,t.updated_at AS updatedAt',
    json: ['profile'],
  },
  {
    name: 'studio_decision_calls',
    kind: 'evaluation',
    from: 'studio_decision_calls t',
    where: 't.artifact_id=?',
    columns:
      't.id,t.project_id AS projectId,t.artifact_id AS artifactId,t.user_id AS userId,t.artifact_version AS artifactVersion,t.purpose,t.input_hash AS inputHash,t.request_hash AS requestHash,t.profile_json AS profile,t.request_json AS request,t.status,t.attempts,t.result_json AS result,t.result_sha256 AS resultSha256,t.error_code AS errorCode,t.created_at AS createdAt,t.updated_at AS updatedAt',
    json: ['profile', 'request', 'result'],
  },
  {
    name: 'studio_decision_admissions',
    kind: 'admission',
    from: 'studio_decision_admissions t JOIN studio_decision_calls c ON c.id=t.call_id',
    where: 'c.artifact_id=?',
    columns:
      't.call_id AS callId,t.fence,t.project_id AS projectId,t.user_id AS userId,t.admitted_at AS admittedAt',
    json: [],
  },
] as const;
export async function* decisionExportRows(
  store: Store,
  artifactId: string,
  checkAccess: () => Promise<void>,
) {
  const cutoffs = await Promise.all(
    tables.map(async (table) =>
      Number(
        (
          await store.one(
            `SELECT coalesce(max(t.rowid),0) AS cutoff FROM ${table.from} WHERE ${table.where}`,
            artifactId,
          )
        ).cutoff,
      ),
    ),
  );
  for (const [index, table] of tables.entries()) {
    let cursor = 0;
    while (cursor < cutoffs[index]!) {
      await checkAccess();
      const page = await store.all(
        `SELECT t.rowid AS sequence,${table.columns} FROM ${table.from} WHERE ${table.where} AND t.rowid>? AND t.rowid<=? ORDER BY t.rowid LIMIT 10`,
        artifactId,
        cursor,
        cutoffs[index]!,
      );
      if (!page.length) break;
      for (const row of page) {
        await checkAccess();
        cursor = Number(row.sequence);
        delete row.sequence;
        for (const key of table.json)
          if (typeof row[key] === 'string') row[key] = JSON.parse(row[key]);
        yield { kind: table.kind, value: row };
      }
    }
  }
}
