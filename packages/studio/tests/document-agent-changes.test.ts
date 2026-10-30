import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.ts';
import { openDatabase } from '../server/persistence/index.ts';
import { paragraph } from '../shared/domain.ts';
import {
  recordAgentDocumentChanges,
  recentAgentDocumentChanges,
} from '../server/document-agent-changes.ts';
import { RECENT_AGENT_CHANGE_MS } from '../shared/document-agent-changes.ts';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const postgres = process.env.STUDIO_TEST_POSTGRES_URL;
for (const adapter of [
  'sqlite',
  ...(postgres ? ['postgres'] : []),
] as const) {
  describe(`attributed recent agent document changes (${adapter})`, () => {
    async function fixture() {
      const store = await Store.open(
        adapter === 'postgres'
          ? await openDatabase({
              adapter: 'postgres',
              url: postgres!,
              schema: 'marks_' + randomUUID().replaceAll('-', ''),
            })
          : ':memory:',
      );
      cleanup.push(() => store.close());
      const user = await store.createUser(
        randomUUID() + '@test.invalid',
        'Human approver',
        null,
      );
      const project = await store.createProject(user, 'Attribution test', '');
      const artifact = await store.artifact(project.mainArtifactId, user.id);
      const current = await store.updateArtifact(
        user,
        artifact.id,
        artifact.version,
        {
          doc: {
            type: 'doc',
            content: [
              paragraph('Retained paragraph'),
              paragraph('Original requirement'),
            ],
          },
        },
      );
      const accept = async () =>
        store.tx(async () => {
          const before = await store.artifact(current.id, user.id);
          const content = structuredClone(before.content);
          content.doc.content[1].content[0].text =
            'Human accepted agent requirement';
          const next = await store.updateArtifact(
            user,
            before.id,
            before.version,
            content,
          );
          await recordAgentDocumentChanges(
            store,
            user,
            before.id,
            before.content.doc,
            'Accepted agent proposal',
          );
          return next;
        });
      return { store, user, project, current, accept };
    }
    it('attributes only changed canonical nodes after a committed agent publication and expires them', async () => {
      const c = await fixture();
      expect(
        await recentAgentDocumentChanges(c.store, c.user, c.current.id),
      ).toEqual([]);
      const saved = await c.accept();
      const markers = await recentAgentDocumentChanges(
        c.store,
        c.user,
        saved.id,
      );
      expect(markers).toHaveLength(1);
      expect(markers[0]).toMatchObject({
        anchor: saved.content.doc.content[1].attrs.id,
        version: saved.version,
        actor: 'Human approver',
        source: 'Accepted agent proposal',
      });
      expect(
        await recentAgentDocumentChanges(
          c.store,
          c.user,
          saved.id,
          markers[0]!.expiresAt + 1,
        ),
      ).toEqual([]);
      expect(markers[0]!.expiresAt - Date.parse(markers[0]!.createdAt)).toBe(
        RECENT_AGENT_CHANGE_MS,
      );
      expect(saved.content.doc.content[0]).toEqual(
        c.current.content.doc.content[0],
      );
    });
    it('rejects attribution outside source transactions and rolls it back with a failed source publication', async () => {
      const c = await fixture();
      await expect(
        recordAgentDocumentChanges(
          c.store,
          c.user,
          c.current.id,
          c.current.content.doc,
          'Accepted agent proposal',
        ),
      ).rejects.toThrow('source publication transaction');
      await expect(
        c.store.tx(async () => {
          await c.accept();
          throw new Error('Aborted publication');
        }),
      ).rejects.toThrow('Aborted publication');
      expect(
        (await c.store.artifact(c.current.id, c.user.id)).content,
      ).toEqual(c.current.content);
      expect(
        await recentAgentDocumentChanges(c.store, c.user, c.current.id),
      ).toEqual([]);
    });
    it('drops changed-node markers after human edits and rechecks revoked read permissions', async () => {
      const c = await fixture();
      const saved = await c.accept();
      const viewer = await c.store.createUser(
        randomUUID() + '@test.invalid',
        'Viewer',
        null,
      );
      await c.store.exec(
        'INSERT INTO memberships VALUES(?,?,?)',
        c.project.id,
        viewer.id,
        'viewer',
      );
      expect(
        await recentAgentDocumentChanges(c.store, viewer, saved.id),
      ).toHaveLength(1);
      const human = structuredClone(saved.content);
      human.doc.content[1].content[0].text = 'A later human edit';
      await c.store.updateArtifact(c.user, saved.id, saved.version, human);
      expect(
        await recentAgentDocumentChanges(c.store, viewer, saved.id),
      ).toEqual([]);
      await c.store.exec(
        'DELETE FROM memberships WHERE project_id=? AND user_id=?',
        c.project.id,
        viewer.id,
      );
      await expect(
        recentAgentDocumentChanges(c.store, viewer, saved.id),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });
}
