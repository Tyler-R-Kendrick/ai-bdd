import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.ts';
import { openDatabase } from '../server/persistence/index.ts';
import { DecisionModels } from '../server/decisions/models.ts';
import { decisionExportRows } from '../server/decisions/export.ts';
import { decisionProfileSchema } from '../shared/decision-profile.ts';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
for (const adapter of ['sqlite', 'postgres'] as const)
  describe.skipIf(
    adapter === 'postgres' && !process.env.STUDIO_TEST_POSTGRES_URL,
  )(adapter + ' complete bounded decision history export', () => {
    async function fixture() {
      const store = await Store.open(
        adapter === 'sqlite'
          ? ':memory:'
          : await openDatabase({
              adapter: 'postgres',
              url: process.env.STUDIO_TEST_POSTGRES_URL!,
              schema: 'decision_export_' + randomUUID().replaceAll('-', ''),
            }),
      );
      cleanup.push(() => store.close());
      const user = await store.createUser(
          randomUUID() + '@test.invalid',
          'History owner',
          null,
        ),
        project = await store.createProject(user, 'Decision history', ''),
        other = await store.createProject(user, 'Other decision source', '');
      const profile = decisionProfileSchema.parse({
          provider: 'openai-decisions',
          model: 'gpt-6-luna',
        }),
        models = new DecisionModels({
          store,
          settings: {
            production: false,
            timeoutMs: 3000,
            defaultProfile: profile,
          },
        });
      await models.initialize();
      cleanup.push(() => models.close());
      await models.profile(user, project.mainArtifactId, profile);
      await store.tx(async () => {
        for (let index = 0; index < 106; index++) {
          const id = randomUUID(),
            artifactId =
              index === 105 ? other.mainArtifactId : project.mainArtifactId;
          await store.exec(
            "INSERT INTO studio_decision_calls(id,project_id,artifact_id,user_id,artifact_version,purpose,input_hash,request_hash,idempotency_key,profile_json,request_json,status,created_at,updated_at) VALUES(?,?,?,?,1,'spike-worthiness',?,?,?, ?,?,'queued',?,?)",
            id,
            index === 105 ? other.id : project.id,
            artifactId,
            user.id,
            'source-' + index,
            'request-' + index,
            'fixture-intent-' + index,
            JSON.stringify(profile),
            JSON.stringify({
              input: 'Explicit unexecuted historical intent ' + index,
              questions: [],
            }),
            new Date().toISOString(),
            new Date().toISOString(),
          );
          // Synthetic admissions exercise joined paging, without fabricating provider output or test success.
          await store.exec(
            'INSERT INTO studio_decision_admissions(call_id,fence,project_id,user_id,admitted_at) VALUES(?,1,?,?,?)',
            id,
            index === 105 ? other.id : project.id,
            user.id,
            Date.now(),
          );
        }
      });
      return { store, user, project };
    }
    it('exports retained intents beyond the latest100 page, preserving scope and excluding worker lease internals', async () => {
      const { store, user, project } = await fixture(),
        rows = [];
      for await (const row of decisionExportRows(
        store,
        project.mainArtifactId,
        () => store.role(project.id, user.id).then(() => {}),
      ))
        rows.push(row);
      const calls = rows.filter((row) => row.kind === 'evaluation'),
        admissions = rows.filter((row) => row.kind === 'admission');
      expect(calls).toHaveLength(105);
      expect(admissions).toHaveLength(105);
      expect(rows.filter((row) => row.kind === 'profile')).toHaveLength(1);
      expect(calls[0]!.value.request.input).toBe(
        'Explicit unexecuted historical intent 0',
      );
      expect(calls[104]!.value.request.input).toBe(
        'Explicit unexecuted historical intent 104',
      );
      expect(
        calls.every(
          (row) => row.value.status === 'queued' && row.value.result === null,
        ),
      ).toBe(true);
      expect(JSON.stringify(rows)).not.toMatch(
        /lease_owner|lease_expires|idempotency_key|apiKey/,
      );
    });
    it('checks permission again between streamed records after a committed revocation', async () => {
      const { store, user, project } = await fixture(),
        iterator = decisionExportRows(store, project.mainArtifactId, () =>
          store.role(project.id, user.id).then(() => {}),
        );
      expect((await iterator.next()).done).toBe(false);
      await store.tx(async () => {
        await store.lock('project:' + project.id);
        await store.exec(
          'DELETE FROM memberships WHERE project_id=? AND user_id=?',
          project.id,
          user.id,
        );
      });
      await expect(iterator.next()).rejects.toMatchObject({ statusCode: 404 });
    });
  });
