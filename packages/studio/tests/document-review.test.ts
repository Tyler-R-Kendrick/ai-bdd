import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.ts';
import {
  registerDocumentReview,
  documentReviewExportPage,
} from '../server/document-review.ts';
import { client, member, project, setup, testSettings } from './helpers.ts';
import { documentBlockDefaults } from '../shared/document-blocks.ts';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'studio-document-review-'));
  cleanup.push(() => rm(dir, { force: true, recursive: true }));
  const context = await createApp(testSettings(dir), { db: ':memory:' });
  if (
    !context.app.hasRoute({
      method: 'GET',
      url: '/api/artifacts/:id/document/review',
    })
  )
    await registerDocumentReview(context.app, context);
  cleanup.push(() => context.app.close());
  const owner = await setup(context.app),
    request = client(context.app, owner.cookie),
    workspace = await project(request),
    artifactId = workspace.mainArtifactId;
  const content = {
    doc: {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1, id: 'title' },
          content: [{ type: 'text', text: 'Collaborative intent' }],
        },
        {
          type: 'paragraph',
          attrs: { id: 'passage' },
          content: [{ type: 'text', text: 'Choose the quick approach.' }],
        },
        {
          type: 'questionnaireBlock',
          attrs: {
            id: 'questionnaire',
            data: documentBlockDefaults.questionnaireBlock,
          },
        },
      ],
    },
  };
  const initial = (
    await request('GET', `/api/artifacts/${artifactId}`)
  ).json().artifact;
  const response = await request('PATCH', `/api/artifacts/${artifactId}`, {
    version: initial.version,
    content,
  });
  expect(response.statusCode, response.body).toBe(200);
  const state = async () =>
    (await request('GET', `/api/artifacts/${artifactId}`)).json().artifact;
  return { ...context, owner, request, workspace, artifactId, state };
}
describe('attributed document review and questionnaire decisions', () => {
  it('persists a suggestion without applying it, accepts atomically, and denies viewer mutation/cross-artifact lookup', async () => {
    const f = await fixture(),
      viewer = await member(f.app, f.request, f.workspace.id, 'viewer'),
      view = client(f.app, viewer.cookie),
      before = await f.state();
    const input = {
      version: before.version,
      anchor: 'passage',
      from: 11,
      to: 16,
      before: 'quick',
      after: 'safer',
      comment: 'Trade a little speed for a clearer boundary.',
    };
    expect(
      (
        await view(
          'POST',
          `/api/artifacts/${f.artifactId}/document/suggestions`,
          input,
        )
      ).statusCode,
    ).toBe(403);
    const response = await f.request(
      'POST',
      `/api/artifacts/${f.artifactId}/document/suggestions`,
      input,
    );
    expect(response.statusCode, response.body).toBe(201);
    const suggestion = response.json();
    expect(suggestion.authorId).toBe(f.owner.user.id);
    expect(suggestion.status).toBe('pending');
    expect((await f.state()).content.doc.content[1].content[0].text).toBe(
      'Choose the quick approach.',
    );
    const resolved = await f.request(
      'POST',
      `/api/artifacts/${f.artifactId}/document/suggestions/${suggestion.id}/resolve`,
      { version: before.version, action: 'accept' },
    );
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect(resolved.json().status).toBe('accepted');
    expect((await f.state()).content.doc.content[1].content[0].text).toBe(
      'Choose the safer approach.',
    );
    const read = await view(
      'GET',
      `/api/artifacts/${f.artifactId}/document/review`,
    );
    expect(read.json().suggestions[0].resolvedBy).toBe('Test owner');
    const other = await project(f.request, 'Other scope');
    expect(
      (
        await f.request(
          'POST',
          `/api/artifacts/${other.mainArtifactId}/document/suggestions/${suggestion.id}/resolve`,
          { version: 1, action: 'reject' },
        )
      ).statusCode,
    ).toBe(404);
    const rows = (
      await documentReviewExportPage(
        f.store,
        f.artifactId,
        'document_suggestions',
      )
    ).rows;
    expect(rows[0].status).toBe('accepted');
    expect(rows[0].block_snapshot).toContain('quick');
  });
  it('keeps a stale suggestion pending and rolls back both document and review metadata if persistence callback fails', async () => {
    const f = await fixture(),
      before = await f.state(),
      response = await f.request(
        'POST',
        `/api/artifacts/${f.artifactId}/document/suggestions`,
        {
          version: before.version,
          anchor: 'passage',
          from: 11,
          to: 16,
          before: 'quick',
          after: 'safer',
        },
      ),
      suggestion = response.json();
    expect(response.statusCode, response.body).toBe(201);
    await f.store.db.exec(
      `CREATE TRIGGER fail_review_resolution BEFORE UPDATE ON document_suggestions WHEN NEW.status='accepted' BEGIN SELECT RAISE(ABORT,'test-only simulated persistence failure'); END;`,
    );
    const failed = await f.request(
      'POST',
      `/api/artifacts/${f.artifactId}/document/suggestions/${suggestion.id}/resolve`,
      { version: before.version, action: 'accept' },
    );
    expect(failed.statusCode).toBe(500);
    expect((await f.state()).version).toBe(before.version);
    expect(
      (
        await f.store.one(
          'SELECT status FROM document_suggestions WHERE id=?',
          suggestion.id,
        )
      ).status,
    ).toBe('pending');
    await f.store.db.exec('DROP TRIGGER fail_review_resolution');
    const changed = structuredClone(before.content);
    changed.doc.content[1].content[0].text = 'Choose a measured approach.';
    expect(
      (
        await f.request('PATCH', `/api/artifacts/${f.artifactId}`, {
          version: before.version,
          content: changed,
        })
      ).statusCode,
    ).toBe(200);
    const current = await f.state(),
      stale = await f.request(
        'POST',
        `/api/artifacts/${f.artifactId}/document/suggestions/${suggestion.id}/resolve`,
        { version: current.version, action: 'accept' },
      );
    expect(stale.statusCode).toBe(409);
    expect(stale.body).toContain('passage changed');
    const reject = await f.request(
      'POST',
      `/api/artifacts/${f.artifactId}/document/suggestions/${suggestion.id}/resolve`,
      { version: current.version, action: 'reject' },
    );
    expect(reject.statusCode).toBe(200);
    expect(reject.json().status).toBe('rejected');
  });
  it('retains attributed answer history and accepts the latest unchanged answer as an anchored ADR', async () => {
    const f = await fixture(),
      before = await f.state(),
      input = {
        version: before.version,
        questionId: 'approach',
        optionId: 'a',
        answer: 'It fits the integration boundary.',
      },
      first = await f.request(
        'POST',
        `/api/artifacts/${f.artifactId}/document/questionnaires/questionnaire/answers`,
        input,
      );
    expect(first.statusCode, first.body).toBe(201);
    const second = await f.request(
      'POST',
      `/api/artifacts/${f.artifactId}/document/questionnaires/questionnaire/answers`,
      {
        ...input,
        version: (await f.state()).version,
        optionId: 'b',
        answer: 'After review, the alternative has better evidence.',
      },
    );
    expect(second.statusCode).toBe(201);
    expect(second.json().supersedesId).toBe(first.json().id);
    const duplicate = await f.request(
      'POST',
      `/api/artifacts/${f.artifactId}/document/questionnaires/questionnaire/answers`,
      {
        ...input,
        optionId: 'b',
        answer: 'After review, the alternative has better evidence.',
      },
    );
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().id).toBe(second.json().id);
    const stale = await f.request(
      'POST',
      `/api/artifacts/${f.artifactId}/document/answers/${first.json().id}/accept-decision`,
      { version: (await f.state()).version },
    );
    expect(stale.statusCode).toBe(409);
    const accepted = await f.request(
      'POST',
      `/api/artifacts/${f.artifactId}/document/answers/${second.json().id}/accept-decision`,
      { version: (await f.state()).version },
    );
    expect(accepted.statusCode, accepted.body).toBe(201);
    const bundle = (
        await f.request('GET', `/api/artifacts/${f.artifactId}`)
      ).json(),
      decision = bundle.decisions.find(
        (d: any) => d.id === accepted.json().decisionId,
      );
    expect(decision.status).toBe('accepted');
    expect(decision.decision).toContain('Approach B');
    expect(decision.context).toContain('Answered by Test owner');
    const review = (
      await f.request(
        'GET',
        `/api/artifacts/${f.artifactId}/document/review?limit=1`,
      )
    ).json();
    expect(review.answers).toHaveLength(1);
    expect(review.pagination.answers.hasMore).toBe(true);
    expect(review.anchors[0].anchor).toBe('questionnaire');
    const older = (
      await f.request(
        'GET',
        `/api/artifacts/${f.artifactId}/document/review?beforeAnswers=${review.pagination.answers.nextCursor}`,
      )
    ).json();
    expect(older.answers[0].id).toBe(first.json().id);
    const exported = (
      await documentReviewExportPage(
        f.store,
        f.artifactId,
        'document_answers',
      )
    ).rows;
    expect(exported).toHaveLength(2);
    expect(exported[1].decision_id).toBe(decision.id);
  });
  it('refuses a decision after its question or options change and never accepts client-authored identities', async () => {
    const f = await fixture(),
      before = await f.state(),
      input = {
        version: before.version,
        questionId: 'approach',
        optionId: 'a',
        answer: 'Initial answer.',
      },
      answer = await f.request(
        'POST',
        `/api/artifacts/${f.artifactId}/document/questionnaires/questionnaire/answers`,
        input,
      );
    expect(answer.statusCode).toBe(201);
    expect(
      (
        await f.request(
          'POST',
          `/api/artifacts/${f.artifactId}/document/questionnaires/questionnaire/answers`,
          { ...input, author: 'Spoofed owner' },
        )
      ).statusCode,
    ).toBe(400);
    const changed = structuredClone(before.content);
    changed.doc.content[2].attrs.data.questions[0].options[0].label =
      'A different promise';
    expect(
      (
        await f.request('PATCH', `/api/artifacts/${f.artifactId}`, {
          version: (await f.state()).version,
          content: changed,
        })
      ).statusCode,
    ).toBe(200);
    const result = await f.request(
      'POST',
      `/api/artifacts/${f.artifactId}/document/answers/${answer.json().id}/accept-decision`,
      { version: (await f.state()).version },
    );
    expect(result.statusCode).toBe(409);
    expect(result.body).toContain('question changed');
  });
  it('looks up retained evidence by its exact run identity beyond the recent-run window and enforces project scope', async () => {
    const f = await fixture(),
      source = (
        await f.request('POST', `/api/projects/${f.workspace.id}/artifacts`, {
          kind: 'code',
          title: 'Evidence source',
        })
      ).json(),
      old = randomUUID();
    await f.store.exec(
      'INSERT INTO runs(id,artifact_id,artifact_version,status,result,created_at) VALUES(?,?,?,?,?,?)',
      old,
      source.id,
      1,
      'failed',
      JSON.stringify({
        scenarios: [
          {
            scenarioId: 'fixture',
            title: 'Lookup fixture',
            status: 'failed',
          },
        ],
      }),
      '2020-01-01T00:00:00.000Z',
    );
    for (let index = 0; index < 101; index++)
      await f.store.exec(
        'INSERT INTO runs(id,artifact_id,artifact_version,status,created_at) VALUES(?,?,?,?,?)',
        randomUUID(),
        source.id,
        1,
        'error',
        new Date().toISOString(),
      );
    expect(
      (await f.store.runs(source.id)).some((run) => run.id === old),
    ).toBe(false);
    const evidence = await f.request(
      'GET',
      `/api/artifacts/${f.artifactId}/document/evidence/${old}`,
    );
    expect(evidence.statusCode).toBe(200);
    expect(evidence.json().run.id).toBe(old);
    expect(evidence.json().artifact.id).toBe(source.id);
    const other = await project(f.request, 'Another project');
    expect(
      (
        await f.request(
          'GET',
          `/api/artifacts/${other.mainArtifactId}/document/evidence/${old}`,
        )
      ).statusCode,
    ).toBe(404);
  });
});
