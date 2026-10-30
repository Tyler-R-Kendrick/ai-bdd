import { createHash } from 'node:crypto';
import { investigationReferences } from '../../shared/investigation-blocks.ts';
import { investigationResultSchema } from '../../shared/investigations.ts';
import type { ArtifactKind, RichNode } from '../../shared/domain.ts';
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
  if (!store.db.inTransaction())
    throw new Error(
      'Investigation source references must be checked inside the source transaction',
    );
  await store.db.lock('project:' + input.projectId);
  const cards = (root: RichNode) => {
    const result = new Map<string, string[]>();
    const walk = (node: RichNode) => {
      if (node.type === 'investigationCard') {
        const value = node.attrs?.data;
        const data =
          value && typeof value === 'object' && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : {};
        const id = String(data.investigationId ?? ''),
          anchor = String(node.attrs?.id ?? '');
        result.set(id, [...(result.get(id) ?? []), anchor]);
      }
      for (const child of node.content ?? []) walk(child);
    };
    walk(root);
    return result;
  };
  const current = await store.one(
    'SELECT content FROM artifacts WHERE id=? AND project_id=?',
    input.artifactId,
    input.projectId,
  );
  const before = current
      ? cards(JSON.parse(current.content).doc ?? { type: 'doc' })
      : new Map<string, string[]>(),
    after = cards(input.content.doc);
  for (const [id, anchors] of after)
    if (anchors.length !== 1)
      throw new HttpError(
        400,
        'Investigation request card ' + id + ' must occur exactly once',
      );
  const ids = [
    ...new Set([
      ...references.map((reference) => reference.investigationId),
      ...before.keys(),
    ]),
  ];
  if (!ids.length) return;
  const rows = await store.all(
    'SELECT id,artifact_id,project_id,child_artifact_id,length(result_json) AS result_bytes,result_hash,status FROM studio_investigations WHERE project_id=? AND id IN (' +
      ids.map(() => '?').join(',') +
      ')',
    input.projectId,
    ...ids,
  );
  const records = new Map(rows.map((row) => [row.id, row]));
  for (const [id, anchors] of before) {
    const record = records.get(id);
    if (
      record &&
      record.status !== 'withdrawn' &&
      (after.get(id)?.length !== 1 || after.get(id)?.[0] !== anchors[0])
    )
      throw new HttpError(
        409,
        'Keep investigation request card ' +
          id +
          ' with its stable identity. Withdraw a proposed investigation before removing its card.',
      );
  }
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
