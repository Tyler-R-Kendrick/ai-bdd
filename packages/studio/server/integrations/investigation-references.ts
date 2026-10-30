import { createHash } from 'node:crypto';
import { investigationReferences } from '../../shared/investigation-blocks.ts';
import { investigationResultSchema } from '../../shared/investigations.ts';
import type { ArtifactKind } from '../../shared/domain.ts';
import { HttpError, type Store } from '../store.ts';
/** Invoked by the canonical source writer inside its project transaction, including imports, MCP and incoming Yjs. */
export async function validateInvestigationReferences(
  store: Store,
  input: {
    artifactId: string;
    projectId: string;
    kind: ArtifactKind;
    content: Record<string, any>;
  },
) {
  if (input.kind !== 'document' && input.kind !== 'design') return;
  const references = investigationReferences(input.content.doc);
  if (!references.length) return;
  if (!store.db.inTransaction())
    throw new Error(
      'Investigation source references must be checked inside the source transaction',
    );
  await store.db.lock('project:' + input.projectId);
  const ids = [
    ...new Set(references.map((reference) => reference.investigationId)),
  ];
  const rows = await store.all(
    'SELECT id,artifact_id,project_id,child_artifact_id,length(result_json) AS result_bytes,result_hash,status FROM studio_investigations WHERE project_id=? AND id IN (' +
      ids.map(() => '?').join(',') +
      ')',
    input.projectId,
    ...ids,
  );
  const records = new Map(rows.map((row) => [row.id, row]));
  let resultBytes = 0;
  const parsedResults = new Map<
    string,
    ReturnType<typeof investigationResultSchema.parse>
  >();
  for (const reference of references) {
    const record = records.get(reference.investigationId);
    if (!record || record.project_id !== input.projectId || !input.artifactId)
      throw new HttpError(
        400,
        'Investigation references must name a record belonging to this artifact',
      );
    if (reference.kind === 'investigationCard') {
      if (record.artifact_id !== input.artifactId)
        throw new HttpError(
          400,
          'Investigation request cards belong only in their source artifact',
        );
      continue;
    }
    if (
      record.status !== 'completed' ||
      !record.result_bytes ||
      !record.result_hash ||
      ![record.artifact_id, record.child_artifact_id].includes(input.artifactId)
    )
      throw new HttpError(
        400,
        'Investigation views require a completed result in its source or published child artifact',
      );
    let result = parsedResults.get(record.id);
    if (!result) {
      if (resultBytes + Number(record.result_bytes) > 8_000_000)
        throw new HttpError(
          400,
          'Inline investigation results exceed the 8 MB document reference budget',
        );
      const stored = await store.one(
        'SELECT result_json FROM studio_investigations WHERE id=? AND project_id=?',
        record.id,
        input.projectId,
      );
      if (
        !stored?.result_json ||
        createHash('sha256').update(stored.result_json).digest('hex') !==
          record.result_hash
      )
        throw new HttpError(
          409,
          'The investigation result failed its integrity check',
        );
      resultBytes += Buffer.byteLength(stored.result_json);
      if (resultBytes > 8_000_000)
        throw new HttpError(
          400,
          'Inline investigation results exceed the 8 MB document reference budget',
        );
      try {
        result = investigationResultSchema.parse(
          JSON.parse(stored.result_json),
        );
        parsedResults.set(record.id, result);
      } catch {
        throw new HttpError(409, 'The investigation result is invalid');
      }
    }
    if (!result.views.some((view) => view.id === reference.viewId))
      throw new HttpError(
        400,
        'The investigation does not contain this published view',
      );
  }
}
