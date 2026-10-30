import { documentBlockSchemas } from '../shared/document-blocks.ts';
import { docText, type Artifact, type RichNode } from '../shared/domain.ts';
import { HttpError, type Store } from './store.ts';
export type DocumentImplementationBlocker = {
  kind: 'source' | 'questionnaire' | 'suggestion' | 'discussion';
  id: string;
  anchor?: string;
  questionId?: string;
  question?: string;
  message: string;
};
export type DocumentImplementationReadiness = {
  ready: boolean;
  blockers: DocumentImplementationBlocker[];
};
/** Read only, inside the execution planner's held project lock. Accepted unrelated/default ADRs do not resolve a questionnaire. */
export async function documentImplementationReadiness(
  store: Store,
  artifact: Artifact,
): Promise<DocumentImplementationReadiness> {
  if (artifact.kind !== 'document' && artifact.kind !== 'design')
    return { ready: true, blockers: [] };
  if (!store.db.inTransaction())
    throw new Error(
      'Document implementation readiness requires the project transaction',
    );
  const blockers: DocumentImplementationBlocker[] = [];
  if (!docText(artifact.content.doc).trim())
    blockers.push({
      kind: 'source',
      id: artifact.id,
      message: 'Write the plan before approving or starting implementation.',
    });
  const accepted = await store.all(
    `SELECT a.id,a.anchor,a.question_id,a.question_snapshot FROM document_answers a JOIN users u ON u.id=a.author_id JOIN decisions d ON d.id=a.decision_id AND d.artifact_id=a.artifact_id AND d.status='accepted' JOIN document_decision_anchors x ON x.artifact_id=a.artifact_id AND x.decision_id=d.id AND x.source_id=a.id AND x.source_kind='questionnaire-answer' AND x.anchor=a.anchor WHERE a.artifact_id=? AND NOT EXISTS(SELECT 1 FROM document_answers newer WHERE newer.supersedes_id=a.id)`,
    artifact.id,
  );
  const resolved = new Set(
    accepted.map((row) =>
      JSON.stringify([row.anchor, row.question_id, row.question_snapshot]),
    ),
  );
  let visited = 0;
  const walk = (node: RichNode, depth: number) => {
    if (++visited > 50000 || depth > 40)
      throw new Error(
        'Document readiness exceeds the document node/depth limit',
      );
    if (node.type === 'questionnaireBlock') {
      const data = documentBlockSchemas.questionnaireBlock.parse(
          node.attrs?.data,
        ),
        anchor = typeof node.attrs?.id === 'string' ? node.attrs.id : '';
      for (const question of data.questions)
        if (
          !anchor ||
          !resolved.has(
            JSON.stringify([anchor, question.id, JSON.stringify(question)]),
          )
        )
          blockers.push({
            kind: 'questionnaire',
            id: anchor || 'unanchored-questionnaire',
            anchor,
            questionId: question.id,
            question: question.question,
            message: `Resolve “${question.question}” with a current attributed answer and an accepted anchored ADR.`,
          });
    }
    for (const child of node.content ?? []) walk(child, depth + 1);
  };
  walk(artifact.content.doc, 0);
  for (const row of await store.all(
    "SELECT id,anchor FROM document_suggestions WHERE artifact_id=? AND status='pending' ORDER BY rowid",
    artifact.id,
  ))
    blockers.push({
      kind: 'suggestion',
      id: row.id,
      anchor: row.anchor,
      message: 'Accept or reject this pending text suggestion.',
    });
  for (const row of await store.all(
    "SELECT id,anchor FROM threads WHERE artifact_id=? AND resolved=0 AND anchor IS NOT NULL AND anchor<>'' ORDER BY rowid",
    artifact.id,
  ))
    blockers.push({
      kind: 'discussion',
      id: row.id,
      anchor: row.anchor,
      message: 'Resolve this anchored document discussion.',
    });
  return { ready: blockers.length === 0, blockers };
}
export async function documentImplementationReady(
  store: Store,
  artifact: Artifact,
) {
  const result = await documentImplementationReadiness(store, artifact);
  if (!result.ready) {
    const error = new HttpError(
      409,
      `The document has ${result.blockers.length} unresolved implementation prerequisite${result.blockers.length === 1 ? '' : 's'}: ${result.blockers
        .map((blocker) => blocker.question ?? `${blocker.kind} ${blocker.id}`)
        .slice(0, 8)
        .join('; ')}`,
    ) as HttpError & { blockers: DocumentImplementationBlocker[] };
    error.blockers = result.blockers;
    throw error;
  }
}
