import { hash, HttpError, type Store } from '../store.ts';
/** Retained proposal/acceptance history; no connection credentials or private machine state are exported. */
export async function* findingsExportRows(
  store: Store,
  artifactId: string,
  checkAccess: () => Promise<void>,
) {
  await checkAccess();
  const cutoff = Number(
    (
      await store.one(
        'SELECT coalesce(max(rowid),0) AS n FROM studio_findings_reviews WHERE artifact_id=?',
        artifactId,
      )
    ).n,
  );
  const acknowledgementCutoff = Number(
    (
      await store.one(
        'SELECT coalesce(max(rowid),0) AS n FROM studio_findings_acknowledgements WHERE artifact_id=?',
        artifactId,
      )
    ).n,
  );
  let cursor = 0;
  while (cursor < cutoff) {
    await checkAccess();
    const row = await store.one(
      'SELECT r.rowid AS sequence,r.id,r.investigation_id AS investigationId,r.user_id AS requestedBy,r.source_version AS sourceVersion,r.source_hash AS sourceHash,r.evidence_hash AS evidenceHash,r.automatic,r.accepted_by AS acceptedBy,r.accepted_at AS acceptedAt,r.created_at AS createdAt,j.status,j.error,j.output_json AS result,j.input_json AS snapshot,j.input_sha256 AS snapshotSha256 FROM studio_findings_reviews r JOIN studio_durable_jobs j ON j.id=r.job_id WHERE r.artifact_id=? AND r.rowid>? AND r.rowid<=? ORDER BY r.rowid LIMIT 1',
      artifactId,
      cursor,
      cutoff,
    );
    if (!row) break;
    cursor = Number(row.sequence);
    delete row.sequence;
    if (hash(row.snapshot) !== row.snapshotSha256)
      throw new HttpError(
        409,
        'The findings source snapshot failed its integrity check',
      );
    delete row.snapshotSha256;
    const snapshot = JSON.parse(row.snapshot);
    row.snapshot = {
      artifact: snapshot.artifact,
      sourceHash: snapshot.sourceHash,
      evidenceHash: snapshot.evidenceHash,
      input: snapshot.input,
      generationProfile: snapshot.generationProfile,
      decisionProfile: snapshot.decisionProfile,
    };
    row.result = row.result ? JSON.parse(row.result) : null;
    row.automatic = !!row.automatic;
    await checkAccess();
    yield { kind: 'findings-review', value: row };
  }
  cursor = 0;
  while (cursor < acknowledgementCutoff) {
    await checkAccess();
    const row = await store.one(
      'SELECT rowid AS sequence,id,investigation_id AS investigationId,user_id AS authorId,result_hash AS resultHash,source_version AS sourceVersion,source_hash AS sourceHash,rationale,created_at AS createdAt FROM studio_findings_acknowledgements WHERE artifact_id=? AND rowid>? AND rowid<=? ORDER BY rowid LIMIT 1',
      artifactId,
      cursor,
      acknowledgementCutoff,
    );
    if (!row) break;
    cursor = Number(row.sequence);
    delete row.sequence;
    await checkAccess();
    yield { kind: 'findings-acknowledgement', value: row };
  }
}
