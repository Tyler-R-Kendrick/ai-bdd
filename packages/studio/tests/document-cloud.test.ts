import {
  documentImplementationReadiness,
  documentImplementationReady,
} from '../server/document-readiness.ts';
import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import * as Y from 'yjs';
import {
  prosemirrorToYXmlFragment,
  yXmlFragmentToProsemirrorJSON,
} from 'y-prosemirror';
import { z } from 'zod';
import { Store, HttpError, hash } from '../server/store.ts';
import {
  openDatabase,
  postgresPoolConfig,
} from '../server/persistence/index.ts';
import {
  registerDocumentReview,
  documentReviewExportPage,
} from '../server/document-review.ts';
import { editorSchema } from '../shared/editor.ts';
import { documentBlockDefaults } from '../shared/document-blocks.ts';
import type { User } from '../shared/domain.ts';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const postgresUrl = process.env.STUDIO_TEST_POSTGRES_URL;
function observeLock(store: Store, projectId: string) {
  let entered!: () => void;
  const attempt = new Promise<void>((resolve) => (entered = resolve)),
    original = store.db.lock.bind(store.db);
  store.db.lock = async (key) => {
    if (key === 'project:' + projectId) entered();
    return original(key);
  };
  return {
    async wait() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          attempt,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    'The competing request did not reach the project lock',
                  ),
                ),
              3000,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    restore() {
      store.db.lock = original;
    },
  };
}

/** Only authentication/transport are fixture doubles. Both SQL adapters, locks, source CRDT state, and transactions are real. */
async function fixture(adapter: 'sqlite' | 'postgres') {
  const schema = 'doc_' + randomUUID().replaceAll('-', '');
  const first =
    adapter === 'sqlite'
      ? await Store.open(':memory:')
      : await Store.open(
          await openDatabase({ adapter, url: postgresUrl!, schema }),
        );
  const second =
    adapter === 'sqlite'
      ? first
      : await Store.open(
          await openDatabase({ adapter, url: postgresUrl!, schema }),
        );
  const apps: Awaited<ReturnType<typeof router>>[] = [];
  cleanup.push(async () => {
    for (const context of apps.reverse()) await context.app.close();
    if (second !== first) await second.close();
    await first.close();
    if (adapter === 'postgres') {
      const pool = new Pool(postgresPoolConfig({ url: postgresUrl! }));
      try {
        await pool.query('DROP SCHEMA "' + schema + '" CASCADE');
      } finally {
        await pool.end();
      }
    }
  });
  const user = await first.createUser(
      `document-owner-${randomUUID()}@example.test`,
      'Document owner',
      null,
    ),
    project = (await first.createProject(
      user,
      'Concurrent document review',
      'Synthetic persistence test',
    ))!;
  const a = await router(first),
    b = await router(second);
  apps.push(a, b);
  const content = {
    doc: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { id: 'passage' },
          content: [{ type: 'text', text: 'Choose the quick approach.' }],
        },
        {
          type: 'questionnaireBlock',
          attrs: {
            id: 'questionnaire',
            data: structuredClone(documentBlockDefaults.questionnaireBlock),
          },
        },
      ],
    },
  };
  await a.collab.replace(project.mainArtifactId, user, content, 1);
  return {
    first,
    second,
    a,
    b,
    user,
    project,
    artifactId: project.mainArtifactId,
    state: () => first.artifact(project.mainArtifactId, user.id),
    request: (
      context: typeof a,
      method: 'GET' | 'POST',
      path: string,
      body?: unknown,
      actor: User = user,
    ) =>
      context.app.inject({
        method,
        url: `/api/artifacts/${project.mainArtifactId}/document${path}`,
        headers: { 'x-test-user': actor.id },
        ...(body === undefined ? {} : { payload: body as any }),
      }),
  };
}
async function router(store: Store) {
  const app = Fastify(),
    notifications: string[] = [];
  app.setErrorHandler((error, _request, reply) =>
    reply
      .code(
        error instanceof z.ZodError ? 400 : ((error as any).statusCode ?? 500),
      )
      .send({
        error: error instanceof Error ? error.message : 'Unknown test failure',
      }),
  );
  const collab = {
    notify: async (_projectId: string, artifactId?: string) => {
      notifications.push(artifactId ?? '');
    },
    replace: async (
      id: string,
      user: User,
      content: Record<string, any>,
      version: number,
      onPersist?: () => Promise<void>,
    ) => {
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, await store.documentState(id, user.id));
        doc.transact(() =>
          prosemirrorToYXmlFragment(
            editorSchema().nodeFromJSON(content.doc),
            doc.getXmlFragment('default'),
          ),
        );
        const persisted = await store.persistDoc(
          user,
          id,
          Y.encodeStateAsUpdate(doc),
          content,
          onPersist,
          version,
        );
        notifications.push(id);
        return persisted.artifact;
      } finally {
        doc.destroy();
      }
    },
  };
  await registerDocumentReview(app, {
    store,
    collab,
    auth: {
      user: async (request) => {
        const id = request.headers['x-test-user'];
        if (typeof id !== 'string')
          throw new HttpError(401, 'Test session required');
        return store.publicUser(id);
      },
    },
  });
  return { app, collab, notifications };
}
for (const adapter of ['sqlite', 'postgres'] as const)
  describe.skipIf(adapter === 'postgres' && !postgresUrl)(
    `${adapter} asynchronous document transactions`,
    () => {
      it('refuses a new answer at the real 5,000-row history cap while replaying an exact answer without another row', async () => {
        const f = await fixture(adapter),
          version = (await f.state()).version,
          input = {
            version,
            questionId: 'approach',
            optionId: 'a',
            answer: 'Keep this exact attributed response after a lost reply.',
          },
          first = await f.request(
            f.a,
            'POST',
            '/questionnaires/questionnaire/answers',
            input,
          );
        expect(first.statusCode, first.body).toBe(201);
        const answer = first.json();
        // Retained historical questions consume the same artifact-wide quota as current answers.
        // Use actual persisted rows rather than intercepting count(*) or changing the production limit.
        await f.first.tx(async () => {
          await f.first.db.lock('project:' + f.project.id);
          await f.first.exec(
            `WITH RECURSIVE quota_sequence(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM quota_sequence WHERE n<4999)
             INSERT INTO document_answers(id,project_id,artifact_id,anchor,question_id,option_id,answer,question,option,question_snapshot,author_id,author,created_at)
             SELECT ?||'-quota-'||n,project_id,artifact_id,anchor,'historical-'||n,option_id,answer,question,option,question_snapshot,author_id,author,created_at
             FROM document_answers CROSS JOIN quota_sequence WHERE id=?`,
            randomUUID(),
            answer.id,
          );
        });
        const count = async () =>
          Number(
            (
              await f.second.one(
                'SELECT count(*) AS count FROM document_answers WHERE artifact_id=?',
                f.artifactId,
              )
            ).count,
          );
        expect(await count()).toBe(5000);
        const duplicate = await f.request(
          f.b,
          'POST',
          '/questionnaires/questionnaire/answers',
          input,
        );
        expect(duplicate.statusCode, duplicate.body).toBe(200);
        expect(duplicate.json()).toEqual(answer);
        const denied = await f.request(
          f.b,
          'POST',
          '/questionnaires/questionnaire/answers',
          {
            ...input,
            optionId: 'b',
            answer: 'A genuinely new response needs another history row.',
          },
        );
        expect(denied.statusCode, denied.body).toBe(409);
        expect(denied.json().error).toContain('5,000 review-record limit');
        expect(await count()).toBe(5000);
        expect(
          await f.first.one(
            'SELECT answer,option_id FROM document_answers WHERE id=?',
            answer.id,
          ),
        ).toEqual({
          answer: input.answer,
          option_id: 'a',
        });
      });
      it('gives agent/MCP-authored blocks canonical IDs shared by source JSON and durable Yjs without a viewer rewrite', async () => {
        const f = await fixture(adapter),
          authored = await f.first.createArtifact(
            f.user,
            f.project.id,
            'document',
            'Agent/MCP source',
            {
              doc: {
                type: 'doc',
                content: [
                  {
                    type: 'heading',
                    attrs: { level: 1 },
                    content: [
                      { type: 'text', text: 'Authored outside the browser' },
                    ],
                  },
                  {
                    type: 'questionnaireBlock',
                    attrs: {
                      data: structuredClone(
                        documentBlockDefaults.questionnaireBlock,
                      ),
                    },
                  },
                ],
              },
            },
          );
        const anchor = authored.content.doc.content[1].attrs.id;
        expect(typeof anchor).toBe('string');
        expect(anchor.length).toBeGreaterThan(0);
        const encoded = await f.first.documentState(authored.id, f.user.id),
          doc = new Y.Doc();
        try {
          Y.applyUpdate(doc, encoded);
          const json = yXmlFragmentToProsemirrorJSON(
            doc.getXmlFragment('default'),
          );
          expect(json.content[1].attrs.id).toBe(anchor);
        } finally {
          doc.destroy();
        }
        const viewer = await f.first.createUser(
          `viewer-${randomUUID()}@example.test`,
          'Read-only viewer',
          null,
        );
        await f.first.tx(async () => {
          await f.first.db.lock('project:' + f.project.id);
          await f.first.exec(
            'INSERT INTO memberships VALUES(?,?,?)',
            f.project.id,
            viewer.id,
            'viewer',
          );
        });
        const before = await f.first.artifact(authored.id, f.user.id),
          stateHash = hash((await f.first.state(authored.id))!);
        await f.second.documentState(authored.id, viewer.id);
        expect((await f.first.artifact(authored.id, f.user.id)).version).toBe(
          before.version,
        );
        expect(hash((await f.second.state(authored.id))!)).toBe(stateHash);
        const answer = await f.a.app.inject({
          method: 'POST',
          url: `/api/artifacts/${authored.id}/document/questionnaires/${anchor}/answers`,
          headers: { 'x-test-user': f.user.id },
          payload: {
            version: before.version,
            questionId: 'approach',
            optionId: 'a',
            answer:
              'The anchor is usable without a browser normalization write.',
          },
        });
        expect(answer.statusCode, answer.body).toBe(201);
      });
      it('persists attributed answers and cursor history, keeps retries idempotent, and exports every superseded record', async () => {
        const f = await fixture(adapter),
          version = (await f.state()).version,
          first = await f.request(
            f.a,
            'POST',
            '/questionnaires/questionnaire/answers',
            {
              version,
              questionId: 'approach',
              optionId: 'a',
              answer: 'First reasoning',
            },
          );
        expect(first.statusCode, first.body).toBe(201);
        const second = await f.request(
          f.b,
          'POST',
          '/questionnaires/questionnaire/answers',
          {
            version,
            questionId: 'approach',
            optionId: 'b',
            answer: 'A revised answer',
          },
        );
        expect(second.statusCode, second.body).toBe(201);
        expect(second.json().supersedesId).toBe(first.json().id);
        const duplicate = await f.request(
          f.a,
          'POST',
          '/questionnaires/questionnaire/answers',
          {
            version,
            questionId: 'approach',
            optionId: 'b',
            answer: 'A revised answer',
          },
        );
        expect(duplicate.statusCode).toBe(200);
        expect(duplicate.json().id).toBe(second.json().id);
        const review = await f.request(f.b, 'GET', '/review?limit=1');
        expect(review.statusCode, review.body).toBe(200);
        expect(review.json().answers[0].authorId).toBe(f.user.id);
        expect(review.json().pagination.answers.hasMore).toBe(true);
        const old = await f.request(
          f.a,
          'GET',
          '/review?beforeAnswers=' +
            review.json().pagination.answers.nextCursor,
        );
        expect(old.json().answers[0].id).toBe(first.json().id);
        const accepted = await f.request(
          f.b,
          'POST',
          `/answers/${second.json().id}/accept-decision`,
          { version },
        );
        expect(accepted.statusCode, accepted.body).toBe(201);
        const exported = await documentReviewExportPage(
          f.first,
          f.artifactId,
          'document_answers',
        );
        expect(exported.rows).toHaveLength(2);
        expect(exported.rows[1].decision_id).toBe(accepted.json().decisionId);
        expect(exported.rows[0].author).toBe('Document owner');
        expect(
          (
            await documentReviewExportPage(
              f.second,
              f.artifactId,
              'document_decision_anchors',
            )
          ).rows[0].anchor,
        ).toBe('questionnaire');
      });
      it('deduplicates an identical answer retried concurrently across two application instances', async () => {
        const f = await fixture(adapter),
          version = (await f.state()).version,
          input = {
            version,
            questionId: 'approach',
            optionId: 'a',
            answer: 'The same authenticated answer was retried.',
          };
        const responses = await Promise.all([
          f.request(
            f.a,
            'POST',
            '/questionnaires/questionnaire/answers',
            input,
          ),
          f.request(
            f.b,
            'POST',
            '/questionnaires/questionnaire/answers',
            input,
          ),
        ]);
        expect(responses.map((response) => response.statusCode).sort()).toEqual(
          [200, 201],
        );
        expect(responses[0]!.json().id).toBe(responses[1]!.json().id);
        expect(
          (
            await f.first.one(
              'SELECT count(*) AS n FROM document_answers WHERE artifact_id=?',
              f.artifactId,
            )
          ).n,
        ).toBe(1);
      });
      it('allows exactly one concurrent suggestion acceptance and commits its source revision and review together', async () => {
        const f = await fixture(adapter),
          before = await f.state(),
          created = await f.request(f.a, 'POST', '/suggestions', {
            version: before.version,
            anchor: 'passage',
            from: 11,
            to: 16,
            before: 'quick',
            after: 'safer',
          });
        expect(created.statusCode).toBe(201);
        const id = created.json().id;
        const responses = await Promise.all([
          f.request(f.a, 'POST', `/suggestions/${id}/resolve`, {
            version: before.version,
            action: 'accept',
          }),
          f.request(f.b, 'POST', `/suggestions/${id}/resolve`, {
            version: before.version,
            action: 'accept',
          }),
        ]);
        expect(responses.map((response) => response.statusCode).sort()).toEqual(
          [200, 409],
        );
        const after = await f.state();
        expect(after.version).toBe(before.version + 1);
        expect(after.content.doc.content[0].content[0].text).toBe(
          'Choose the safer approach.',
        );
        expect(
          (
            await f.second.one(
              'SELECT status FROM document_suggestions WHERE id=?',
              id,
            )
          ).status,
        ).toBe('accepted');
        expect(
          (
            await f.first.one(
              'SELECT count(*) AS n FROM audit WHERE artifact_id=? AND action=?',
              f.artifactId,
              'document.suggestion.accepted',
            )
          ).n,
        ).toBe(1);
      });
      it('rolls back source, CRDT state, review status and audit when an awaited resolution write fails', async () => {
        const f = await fixture(adapter),
          before = await f.state(),
          state = await f.first.state(f.artifactId),
          created = await f.request(f.a, 'POST', '/suggestions', {
            version: before.version,
            anchor: 'passage',
            from: 11,
            to: 16,
            before: 'quick',
            after: 'safer',
          }),
          id = created.json().id,
          notifications = f.a.notifications.length,
          revisionCount = (
            await f.first.one(
              'SELECT count(*) AS n FROM revisions WHERE artifact_id=?',
              f.artifactId,
            )
          ).n,
          auditCount = (
            await f.first.one(
              'SELECT count(*) AS n FROM audit WHERE artifact_id=?',
              f.artifactId,
            )
          ).n,
          execute = f.first.exec.bind(f.first);
        f.first.exec = async (sql, ...args) => {
          const result = await execute(sql, ...args);
          if (
            sql.startsWith('UPDATE document_suggestions SET status=') &&
            args[0] === 'accepted'
          ) {
            await setImmediate();
            throw new Error('Test-only awaited resolution failure');
          }
          return result;
        };
        try {
          const response = await f.request(
            f.a,
            'POST',
            `/suggestions/${id}/resolve`,
            { version: before.version, action: 'accept' },
          );
          expect(response.statusCode).toBe(500);
        } finally {
          f.first.exec = execute;
        }
        expect((await f.state()).version).toBe(before.version);
        expect(hash((await f.second.state(f.artifactId))!)).toBe(hash(state!));
        expect(
          (
            await f.second.one(
              'SELECT status FROM document_suggestions WHERE id=?',
              id,
            )
          ).status,
        ).toBe('pending');
        expect(
          (
            await f.first.one(
              'SELECT count(*) AS n FROM audit WHERE artifact_id=? AND action=?',
              f.artifactId,
              'document.suggestion.accepted',
            )
          ).n,
        ).toBe(0);
        expect(f.a.notifications).toHaveLength(notifications);
        expect(
          (
            await f.second.one(
              'SELECT count(*) AS n FROM revisions WHERE artifact_id=?',
              f.artifactId,
            )
          ).n,
        ).toBe(revisionCount);
        expect(
          (
            await f.second.one(
              'SELECT count(*) AS n FROM audit WHERE artifact_id=?',
              f.artifactId,
            )
          ).n,
        ).toBe(auditCount);
      });
      it('honors an active execution-plan guard for metadata-only suggestions and questionnaire answers', async () => {
        const f = await fixture(adapter),
          before = await f.state();
        f.first.artifactWriteGuard = async () => {
          throw new HttpError(409, 'The execution plan is locked');
        };
        const suggestion = await f.request(f.a, 'POST', '/suggestions', {
          version: before.version,
          anchor: 'passage',
          from: 11,
          to: 16,
          before: 'quick',
          after: 'safer',
        });
        expect(suggestion.statusCode).toBe(409);
        const answer = await f.request(
          f.a,
          'POST',
          '/questionnaires/questionnaire/answers',
          {
            version: before.version,
            questionId: 'approach',
            optionId: 'a',
            answer: 'Blocked',
          },
        );
        expect(answer.statusCode).toBe(409);
        expect(
          Number(
            (
              await f.first.one(
                'SELECT count(*) AS n FROM document_suggestions',
              )
            ).n,
          ),
        ).toBe(0);
        expect(
          Number(
            (await f.first.one('SELECT count(*) AS n FROM document_answers')).n,
          ),
        ).toBe(0);
        expect((await f.request(f.a, 'GET', '/review')).statusCode).toBe(200);
      });
      it('requires the exact current questionnaire answer and accepted anchor while exposing concrete review blockers', async () => {
        const f = await fixture(adapter),
          state = await f.state();
        const readiness = () =>
          f.first.tx(async () => {
            await f.first.db.lock('project:' + f.project.id);
            return documentImplementationReadiness(f.first, await f.state());
          });
        expect((await readiness()).blockers[0]).toMatchObject({
          kind: 'questionnaire',
          anchor: 'questionnaire',
          questionId: 'approach',
        });
        const answer = await f.request(
          f.a,
          'POST',
          '/questionnaires/questionnaire/answers',
          {
            version: state.version,
            questionId: 'approach',
            optionId: 'a',
            answer: 'Use a contract fixture.',
          },
        );
        expect((await readiness()).ready).toBe(false);
        const accepted = await f.request(
          f.a,
          'POST',
          '/answers/' + answer.json().id + '/accept-decision',
          { version: state.version },
        );
        expect(accepted.statusCode, accepted.body).toBe(201);
        expect((await readiness()).ready).toBe(true);
        const pending = await f.request(f.a, 'POST', '/suggestions', {
          version: state.version,
          anchor: 'passage',
          from: 11,
          to: 16,
          before: 'quick',
          after: 'safer',
        });
        expect((await readiness()).blockers).toContainEqual(
          expect.objectContaining({
            kind: 'suggestion',
            id: pending.json().id,
          }),
        );
        await f.request(
          f.a,
          'POST',
          '/suggestions/' + pending.json().id + '/resolve',
          { version: state.version, action: 'reject' },
        );
        await f.first.exec(
          'INSERT INTO threads(id,artifact_id,anchor,quote,resolved,created_at) VALUES(?,?,?,?,0,?)',
          'blocking-discussion',
          f.artifactId,
          'passage',
          'Review this wording',
          new Date().toISOString(),
        );
        expect((await readiness()).blockers).toContainEqual(
          expect.objectContaining({
            kind: 'discussion',
            id: 'blocking-discussion',
          }),
        );
        await f.first.exec(
          'UPDATE threads SET resolved=1 WHERE id=?',
          'blocking-discussion',
        );
        expect((await readiness()).ready).toBe(true);
        const newer = await f.request(
          f.a,
          'POST',
          '/questionnaires/questionnaire/answers',
          {
            version: state.version,
            questionId: 'approach',
            optionId: 'b',
            answer: 'Changed recommendation.',
          },
        );
        expect(newer.statusCode).toBe(201);
        expect((await readiness()).ready).toBe(false);
        await f.request(
          f.a,
          'POST',
          '/answers/' + newer.json().id + '/accept-decision',
          { version: state.version },
        );
        expect((await readiness()).ready).toBe(true);
        const changed = structuredClone(state.content);
        changed.doc.content[1].attrs.data.questions[0].question =
          'Which boundary is appropriate now?';
        await f.a.collab.replace(f.artifactId, f.user, changed, state.version);
        expect((await readiness()).blockers[0]).toMatchObject({
          kind: 'questionnaire',
          question: 'Which boundary is appropriate now?',
        });
        await expect(
          f.first.tx(async () => {
            await f.first.db.lock('project:' + f.project.id);
            await documentImplementationReady(f.first, await f.state());
          }),
        ).rejects.toMatchObject({
          statusCode: 409,
          blockers: expect.any(Array),
        });
      });
      it('rechecks the locked source question before accepting a concurrent answer as an ADR', async () => {
        const f = await fixture(adapter),
          before = await f.state(),
          answer = await f.request(
            f.b,
            'POST',
            '/questionnaires/questionnaire/answers',
            {
              version: before.version,
              questionId: 'approach',
              optionId: 'a',
              answer: 'Before the question changed',
            },
          );
        expect(answer.statusCode).toBe(201);
        let release!: () => void, entered!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve)),
          inside = new Promise<void>((resolve) => (entered = resolve)),
          content = structuredClone(before.content);
        content.doc.content[1].attrs.data.questions[0].question =
          'A different question';
        const changing = f.a.collab.replace(
          f.artifactId,
          f.user,
          content,
          before.version,
          async () => {
            entered();
            await gate;
          },
        );
        await inside;
        const observed =
          adapter === 'postgres'
            ? observeLock(f.second, f.project.id)
            : undefined;
        const accepting = f.request(
          f.b,
          'POST',
          `/answers/${answer.json().id}/accept-decision`,
          { version: before.version },
        );
        try {
          if (observed) await observed.wait();
          else await setImmediate();
        } finally {
          release();
          observed?.restore();
        }
        await changing;
        const result = await accepting;
        expect(result.statusCode).toBe(409);
        expect(
          (
            await f.first.one(
              'SELECT decision_id FROM document_answers WHERE id=?',
              answer.json().id,
            )
          ).decision_id,
        ).toBeNull();
        expect(
          (
            await f.first.one(
              'SELECT count(*) AS n FROM document_decision_anchors WHERE artifact_id=?',
              f.artifactId,
            )
          ).n,
        ).toBe(0);
      });
      it('serializes metadata writes with membership revocation and rejects a writer who lost access while awaiting the project lock', async () => {
        const f = await fixture(adapter),
          editor = await f.first.createUser(
            `editor-${randomUUID()}@example.test`,
            'Editor',
            null,
          ),
          version = (await f.state()).version;
        await f.first.tx(async () => {
          await f.first.db.lock('project:' + f.project.id);
          await f.first.exec(
            'INSERT INTO memberships VALUES(?,?,?)',
            f.project.id,
            editor.id,
            'editor',
          );
        });
        let release!: () => void, entered!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve)),
          inside = new Promise<void>((resolve) => (entered = resolve));
        const revoking = f.first.tx(async () => {
          await f.first.db.lock('project:' + f.project.id);
          await f.first.exec(
            'DELETE FROM memberships WHERE project_id=? AND user_id=?',
            f.project.id,
            editor.id,
          );
          entered();
          await gate;
        });
        await inside;
        const observed =
          adapter === 'postgres'
            ? observeLock(f.second, f.project.id)
            : undefined;
        const answering = f.request(
          f.b,
          'POST',
          '/questionnaires/questionnaire/answers',
          {
            version,
            questionId: 'approach',
            optionId: 'a',
            answer: 'Must not be stored',
          },
          editor,
        );
        try {
          if (observed) await observed.wait();
          else await setImmediate();
        } finally {
          release();
          observed?.restore();
        }
        await revoking;
        const result = await answering;
        expect(result.statusCode).toBe(404);
        expect(
          (
            await f.first.one(
              'SELECT count(*) AS n FROM document_answers WHERE author_id=?',
              editor.id,
            )
          ).n,
        ).toBe(0);
      });
    },
  );
