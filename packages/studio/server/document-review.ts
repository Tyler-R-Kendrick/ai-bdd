import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Auth } from './auth.ts';
import { Store, HttpError } from './store.ts';
import type { Artifact, User } from '../shared/domain.ts';
import {
  applyDocumentSuggestion,
  questionnaireAt,
  suggestionPassage,
  type DocumentSuggestion,
} from '../shared/document-review.ts';

type AtomicCollaboration = {
  notify: (projectId: string, artifactId?: string) => void;
  replace: (
    id: string,
    user: User,
    content: Record<string, any>,
    version: number,
    onPersist?: () => void,
  ) => Artifact;
};
const stamp = () => new Date().toISOString(),
  identifier = z.string().min(1).max(100),
  version = z.number().int().positive();
const suggestionColumns =
  'rowid AS sequence,id,artifact_id AS artifactId,anchor,before_text AS before,after_text AS after,range_from AS "from",range_to AS "to",base_version AS baseVersion,author_id AS authorId,author,status,resolved_by AS resolvedBy,created_at AS createdAt,resolved_at AS resolvedAt,comment';
const answerColumns =
  'rowid AS sequence,id,artifact_id AS artifactId,anchor,question_id AS questionId,option_id AS optionId,answer,author_id AS authorId,author,created_at AS createdAt,decision_id AS decisionId,question,option,supersedes_id AS supersedesId';
export const documentReviewExportTables = [
  'document_suggestions',
  'document_answers',
  'document_decision_anchors',
] as const;
export type DocumentReviewExportTable =
  (typeof documentReviewExportTables)[number];
/** Every persisted record, including rejected/superseded history, is available in bounded export pages. */
export function documentReviewExportPage(
  store: Store,
  artifactId: string,
  table: DocumentReviewExportTable,
  after = 0,
  limit = 100,
) {
  if (!documentReviewExportTables.includes(table))
    throw new Error('Unknown document review export table');
  const rows = store.all(
    `SELECT rowid AS sequence,* FROM ${table} WHERE artifact_id=? AND rowid>? ORDER BY rowid LIMIT ?`,
    artifactId,
    after,
    Math.max(1, Math.min(200, limit)),
  );
  return {
    rows,
    nextCursor: rows.length ? (rows.at(-1)!.sequence as number) : null,
  };
}
export function registerDocumentReview(
  app: FastifyInstance,
  {
    store,
    auth,
    collab,
  }: { store: Store; auth: Auth; collab: AtomicCollaboration },
) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS document_suggestions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,anchor TEXT NOT NULL,before_text TEXT NOT NULL,after_text TEXT NOT NULL,range_from INTEGER NOT NULL,range_to INTEGER NOT NULL,block_snapshot TEXT NOT NULL,base_version INTEGER NOT NULL,author_id TEXT NOT NULL REFERENCES users(id),author TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')),resolved_by TEXT,created_at TEXT NOT NULL,resolved_at TEXT,comment TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS document_answers(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,anchor TEXT NOT NULL,question_id TEXT NOT NULL,option_id TEXT NOT NULL,answer TEXT NOT NULL,question TEXT NOT NULL,option TEXT NOT NULL,question_snapshot TEXT NOT NULL,author_id TEXT NOT NULL REFERENCES users(id),author TEXT NOT NULL,created_at TEXT NOT NULL,decision_id TEXT REFERENCES decisions(id) ON DELETE SET NULL,supersedes_id TEXT REFERENCES document_answers(id) ON DELETE SET NULL);
    CREATE TABLE IF NOT EXISTS document_decision_anchors(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,anchor TEXT NOT NULL,source_id TEXT NOT NULL,source_kind TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS document_suggestions_artifact ON document_suggestions(artifact_id);
    CREATE INDEX IF NOT EXISTS document_answers_artifact ON document_answers(artifact_id);
    CREATE INDEX IF NOT EXISTS document_decision_anchors_artifact ON document_decision_anchors(artifact_id);
  `);
  const document = (
    id: string,
    user: User,
    action: 'read' | 'write' = 'read',
  ) => {
    const a = store.artifact(id, user.id, action);
    if (a.kind !== 'document' && a.kind !== 'design')
      throw new HttpError(
        400,
        'Document review requires a design document or regular document',
      );
    return a;
  };
  const current = (a: Artifact, expected: number) => {
    if (a.version !== expected)
      throw new HttpError(
        409,
        'The document changed. Review the latest version before continuing.',
      );
  };
  const quota = (
    table: 'document_suggestions' | 'document_answers',
    id: string,
  ) => {
    if (
      store.one(
        `SELECT count(*) AS count FROM ${table} WHERE artifact_id=?`,
        id,
      ).count >= 5000
    )
      throw new HttpError(
        409,
        'This artifact has reached its 5,000 review-record limit. Export its history and continue in a new artifact.',
      );
  };
  const conflict = (operation: () => any) => {
    try {
      return operation();
    } catch (error) {
      if (error instanceof HttpError || error instanceof z.ZodError)
        throw error;
      throw new HttpError(409, (error as Error).message);
    }
  };
  app.get<{ Params: { id: string; runId: string } }>(
    '/api/artifacts/:id/document/evidence/:runId',
    async (req) => {
      const user = auth.user(req),
        parent = document(req.params.id, user),
        row = store.one(
          'SELECT artifact_id AS artifactId FROM runs WHERE id=?',
          req.params.runId,
        );
      if (!row) throw new HttpError(404, 'Evidence run not found');
      const source = store.artifact(row.artifactId, user.id);
      if (source.projectId !== parent.projectId)
        throw new HttpError(404, 'Evidence run not found in this project');
      const run = store
        .runs(source.id)
        .find((value) => value.id === req.params.runId);
      return {
        artifact: {
          id: source.id,
          title: source.title,
          version: source.version,
        },
        run,
      };
    },
  );
  app.get<{ Params: { id: string } }>(
    '/api/artifacts/:id/document/review',
    async (req) => {
      const user = auth.user(req),
        a = document(req.params.id, user),
        query = z
          .object({
            beforeSuggestions: z.coerce.number().int().nonnegative().optional(),
            beforeAnswers: z.coerce.number().int().nonnegative().optional(),
            limit: z.coerce.number().int().min(1).max(200).default(100),
          })
          .strict()
          .parse(req.query);
      const page = (table: string, columns: string, before?: number) => {
        const result = store.all(
            `SELECT ${columns} FROM ${table} WHERE artifact_id=? ${before === undefined ? '' : 'AND rowid<?'} ORDER BY rowid DESC LIMIT ?`,
            a.id,
            ...(before === undefined ? [] : [before]),
            query.limit + 1,
          ),
          hasMore = result.length > query.limit,
          rows = result.slice(0, query.limit).reverse();
        return {
          rows,
          hasMore,
          nextCursor:
            hasMore && rows.length ? (rows[0]!.sequence as number) : null,
        };
      };
      const suggestions = page(
          'document_suggestions',
          suggestionColumns,
          query.beforeSuggestions,
        ),
        answers = page('document_answers', answerColumns, query.beforeAnswers);
      return {
        suggestions: suggestions.rows,
        answers: answers.rows,
        anchors: store.all(
          'SELECT id,decision_id AS decisionId,anchor,source_id AS sourceId,source_kind AS sourceKind,created_at AS createdAt FROM document_decision_anchors WHERE artifact_id=? ORDER BY rowid',
          a.id,
        ),
        pagination: {
          suggestions: {
            hasMore: suggestions.hasMore,
            nextCursor: suggestions.nextCursor,
          },
          answers: { hasMore: answers.hasMore, nextCursor: answers.nextCursor },
        },
      };
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/artifacts/:id/document/suggestions',
    async (req, reply) => {
      const user = auth.user(req),
        a = document(req.params.id, user, 'write'),
        body = z
          .object({
            version,
            anchor: identifier,
            from: z.number().int().nonnegative(),
            to: z.number().int().nonnegative(),
            before: z.string().max(20000),
            after: z.string().max(20000),
            comment: z.string().max(2000).default(''),
          })
          .strict()
          .parse(req.body);
      current(a, body.version);
      quota('document_suggestions', a.id);
      const passage = conflict(() =>
        suggestionPassage(a.content.doc, body.anchor, body.from, body.to),
      );
      if (passage.before !== body.before)
        throw new HttpError(
          409,
          'The selected passage changed. Select it again before suggesting an edit.',
        );
      if (passage.snapshot.length > 100000)
        throw new HttpError(
          413,
          'This paragraph is too large for a review suggestion. Split it into smaller paragraphs.',
        );
      if (body.before === body.after)
        throw new HttpError(400, 'A suggestion must change the selected text');
      const id = randomUUID();
      store.tx(() => {
        store.exec(
          'INSERT INTO document_suggestions(id,project_id,artifact_id,anchor,before_text,after_text,range_from,range_to,block_snapshot,base_version,author_id,author,created_at,comment) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          id,
          a.projectId,
          a.id,
          body.anchor,
          body.before,
          body.after,
          body.from,
          body.to,
          passage.snapshot,
          a.version,
          user.id,
          user.name,
          stamp(),
          body.comment,
        );
        store.audit(
          a.projectId,
          a.id,
          user.name,
          'document.suggestion.created',
          id,
        );
      });
      collab.notify(a.projectId, a.id);
      return reply
        .code(201)
        .send(
          store.one(
            `SELECT ${suggestionColumns} FROM document_suggestions WHERE id=?`,
            id,
          ),
        );
    },
  );
  app.post<{ Params: { id: string; suggestionId: string } }>(
    '/api/artifacts/:id/document/suggestions/:suggestionId/resolve',
    async (req) => {
      const user = auth.user(req),
        a = document(req.params.id, user, 'write'),
        body = z
          .object({ version, action: z.enum(['accept', 'reject']) })
          .strict()
          .parse(req.body),
        row = store.one(
          `SELECT ${suggestionColumns},block_snapshot AS snapshot FROM document_suggestions WHERE artifact_id=? AND id=?`,
          a.id,
          req.params.suggestionId,
        );
      current(a, body.version);
      if (!row) throw new HttpError(404, 'Suggestion not found');
      if (row.status !== 'pending')
        throw new HttpError(409, 'This suggestion has already been resolved');
      const resolve = () => {
        const result = store.exec(
          "UPDATE document_suggestions SET status=?,resolved_by=?,resolved_at=? WHERE id=? AND status='pending'",
          body.action === 'accept' ? 'accepted' : 'rejected',
          user.name,
          stamp(),
          row.id,
        );
        if (result.changes !== 1)
          throw new HttpError(409, 'This suggestion has already been resolved');
        store.audit(
          a.projectId,
          a.id,
          user.name,
          `document.suggestion.${body.action === 'accept' ? 'accepted' : 'rejected'}`,
          row.id,
        );
      };
      if (body.action === 'accept') {
        const next = conflict(() =>
          applyDocumentSuggestion(
            a.content.doc,
            row as DocumentSuggestion,
            row.snapshot,
          ),
        );
        collab.replace(a.id, user, { doc: next }, a.version, resolve);
      } else store.tx(resolve);
      collab.notify(a.projectId, a.id);
      return store.one(
        `SELECT ${suggestionColumns} FROM document_suggestions WHERE id=?`,
        row.id,
      );
    },
  );
  app.post<{ Params: { id: string; anchor: string } }>(
    '/api/artifacts/:id/document/questionnaires/:anchor/answers',
    async (req, reply) => {
      const user = auth.user(req),
        a = document(req.params.id, user, 'write'),
        body = z
          .object({
            version,
            questionId: identifier,
            optionId: identifier,
            answer: z.string().max(4000).default(''),
          })
          .strict()
          .parse(req.body);
      current(a, body.version);
      quota('document_answers', a.id);
      const questionnaire = conflict(() =>
          questionnaireAt(a.content.doc, req.params.anchor),
        ),
        question = questionnaire.questions.find(
          (q: any) => q.id === body.questionId,
        ),
        option = question?.options.find((o: any) => o.id === body.optionId);
      if (!question || !option)
        throw new HttpError(
          400,
          'Choose an option from the current questionnaire',
        );
      if (!question.allowText && body.answer)
        throw new HttpError(
          400,
          'This question does not accept a written answer',
        );
      const previous = store.one(
          'SELECT id FROM document_answers WHERE artifact_id=? AND anchor=? AND question_id=? AND author_id=? ORDER BY rowid DESC LIMIT 1',
          a.id,
          req.params.anchor,
          question.id,
          user.id,
        ),
        id = randomUUID();
      store.tx(() => {
        store.exec(
          'INSERT INTO document_answers(id,project_id,artifact_id,anchor,question_id,option_id,answer,question,option,question_snapshot,author_id,author,created_at,supersedes_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          id,
          a.projectId,
          a.id,
          req.params.anchor,
          question.id,
          option.id,
          body.answer,
          question.question,
          option.label,
          JSON.stringify(question),
          user.id,
          user.name,
          stamp(),
          previous?.id ?? null,
        );
        store.audit(
          a.projectId,
          a.id,
          user.name,
          'document.questionnaire.answered',
          id,
        );
      });
      collab.notify(a.projectId, a.id);
      return reply
        .code(201)
        .send(
          store.one(
            `SELECT ${answerColumns} FROM document_answers WHERE id=?`,
            id,
          ),
        );
    },
  );
  app.post<{ Params: { id: string; answerId: string } }>(
    '/api/artifacts/:id/document/answers/:answerId/accept-decision',
    async (req, reply) => {
      const user = auth.user(req),
        a = document(req.params.id, user, 'write'),
        body = z
          .object({
            version,
            consequences: z
              .string()
              .max(4000)
              .default(
                'Accepted from an attributed questionnaire response. Revisit this decision when its context changes.',
              ),
          })
          .strict()
          .parse(req.body),
        answer = store.one(
          'SELECT * FROM document_answers WHERE artifact_id=? AND id=?',
          a.id,
          req.params.answerId,
        );
      current(a, body.version);
      if (!answer) throw new HttpError(404, 'Questionnaire answer not found');
      if (answer.decision_id)
        throw new HttpError(
          409,
          'This answer already has an accepted decision',
        );
      const questionnaire = conflict(() =>
          questionnaireAt(a.content.doc, answer.anchor),
        ),
        question = questionnaire.questions.find(
          (q: any) => q.id === answer.question_id,
        );
      if (!question || JSON.stringify(question) !== answer.question_snapshot)
        throw new HttpError(
          409,
          'This question changed after the answer was written. Collect a new answer before accepting a decision.',
        );
      const later = store.one(
        'SELECT id FROM document_answers WHERE supersedes_id=?',
        answer.id,
      );
      if (later)
        throw new HttpError(
          409,
          'This person has submitted a newer answer. Review the latest response.',
        );
      const id = randomUUID(),
        time = stamp();
      store.tx(() => {
        store.exec(
          "INSERT INTO decisions(id,artifact_id,title,context,decision,consequences,status,author,updated_at) VALUES(?,?,?,?,?,?,'accepted',?,?)",
          id,
          a.id,
          question.question,
          `Questionnaire: ${questionnaire.title}\nAnswered by ${answer.author} on ${answer.created_at}\nDocument v${a.version}; anchored block ${answer.anchor}`,
          `${answer.option}${answer.answer ? '\n\n' + answer.answer : ''}`,
          body.consequences,
          user.name,
          time,
        );
        store.exec(
          'UPDATE document_answers SET decision_id=? WHERE id=?',
          id,
          answer.id,
        );
        store.exec(
          'INSERT INTO document_decision_anchors VALUES(?,?,?,?,?,?,?,?)',
          randomUUID(),
          a.projectId,
          a.id,
          id,
          answer.anchor,
          answer.id,
          'questionnaire-answer',
          time,
        );
        store.audit(
          a.projectId,
          a.id,
          user.name,
          'decision.accepted-from-questionnaire',
          id,
        );
      });
      collab.notify(a.projectId, a.id);
      return reply.code(201).send({ decisionId: id });
    },
  );
}
