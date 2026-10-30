import { hash, type Store } from '../store.ts';
/** Stream at most one bounded source/receipt record at a time; credentials and machine identities are excluded. */
export async function* rebuildExportRows(
  store: Store,
  artifactId: string,
  checkAccess: () => Promise<void>,
) {
  await checkAccess();
  const baseline = await store.one(
    'SELECT artifact_id AS artifactId,user_id AS ownerId,run_id AS baseRunId,repository,source_json AS source,source_sha256 AS sourceSha256,source_version AS sourceVersion,graph_json AS reviewedGraph,prs_json AS pullRequests,revision,updated_at AS updatedAt FROM studio_rebuild_baselines WHERE artifact_id=?',
    artifactId,
  );
  if (baseline) {
    if (hash(baseline.source) !== baseline.sourceSha256)
      throw new Error('Delivered source failed export integrity verification');
    for (const key of ['source', 'reviewedGraph', 'pullRequests'])
      baseline[key] = JSON.parse(baseline[key]);
    await checkAccess();
    yield { kind: 'rebuildBaseline', value: baseline };
  }
  const upper = await store.one(
    'SELECT created_at,id FROM studio_rebuild_runs WHERE artifact_id=? ORDER BY created_at DESC,id DESC LIMIT 1',
    artifactId,
  );
  if (!upper) return;
  let createdAt = '',
    id = '';
  for (let count = 0; count < 100; count++) {
    await checkAccess();
    const row = await store.one(
      'SELECT id,artifact_id AS artifactId,user_id AS ownerId,baseline_revision AS baselineRevision,base_run_id AS baseRunId,repository,before_json AS beforeSource,source_json AS source,source_sha256 AS sourceSha256,source_version AS sourceVersion,graph_json AS reviewedGraph,prs_json AS pullRequests,automatic,status,generation,report_json AS implementation,report_hash AS implementationSha256,verification_json AS verification,error,created_at AS createdAt,updated_at AS updatedAt FROM studio_rebuild_runs WHERE artifact_id=? AND (created_at>? OR (created_at=? AND id>?)) AND (created_at<? OR (created_at=? AND id<=?)) ORDER BY created_at,id LIMIT 1',
      artifactId,
      createdAt,
      createdAt,
      id,
      upper.created_at,
      upper.created_at,
      upper.id,
    );
    if (!row) return;
    createdAt = row.createdAt;
    id = row.id;
    if (
      hash(row.source) !== row.sourceSha256 ||
      (row.implementation &&
        hash(row.implementation) !== row.implementationSha256)
    )
      throw new Error(
        'Rebuild snapshot or implementation receipt failed export integrity verification',
      );
    const execution = await store.one(
      'SELECT authoring_profile_json,runtime_json FROM studio_rebuild_execution_receipts WHERE rebuild_id=?',
      row.id,
    );
    row.selectedAuthoringProfile = execution?.authoring_profile_json
      ? JSON.parse(execution.authoring_profile_json)
      : null;
    row.connectedRuntime = execution?.runtime_json
      ? JSON.parse(execution.runtime_json)
      : null;
    for (const key of [
      'beforeSource',
      'source',
      'reviewedGraph',
      'pullRequests',
      'implementation',
      'verification',
    ])
      if (row[key]) row[key] = JSON.parse(row[key]);
    await checkAccess();
    yield { kind: 'rebuildRun', value: row };
  }
}
