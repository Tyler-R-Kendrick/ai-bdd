import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import * as Y from 'yjs';
import {
  prosemirrorJSONToYDoc,
  yXmlFragmentToProsemirrorJSON,
} from 'y-prosemirror';
import { canonicalDocument } from '../shared/document-canonical.ts';
import { editorSchema } from '../shared/editor.ts';
import { documentBlockDefaults } from '../shared/document-blocks.ts';
import type { RichNode } from '../shared/domain.ts';
import { Store } from '../server/store.ts';
import {
  openDatabase,
  postgresPoolConfig,
} from '../server/persistence/index.ts';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const terminal: RichNode[] = [
  {
    type: 'heading',
    attrs: { id: 'heading-id', level: 2 },
    content: [{ type: 'text', text: 'Final section' }],
  },
  { type: 'horizontalRule', attrs: { id: 'rule-id' } },
  {
    type: 'questionnaireBlock',
    attrs: {
      id: 'questionnaire-id',
      data: structuredClone(documentBlockDefaults.questionnaireBlock),
    },
  },
  {
    type: 'codeBlock',
    attrs: { id: 'code-id', language: 'typescript' },
    content: [{ type: 'text', text: 'const exact = true;' }],
  },
];
describe('canonical editable document ending', () => {
  it.each(terminal)(
    'adds exactly one editable paragraph after $type before IDs without mutating source',
    (node) => {
      const source: RichNode = { type: 'doc', content: [node] },
        before = structuredClone(source);
      let index = 0;
      const first = canonicalDocument(source, () => `canonical-${++index}`);
      expect(source).toEqual(before);
      expect(first.doc.content).toHaveLength(2);
      expect(first.doc.content?.[0]).toEqual(node);
      expect(first.doc.content?.at(-1)).toEqual({
        type: 'paragraph',
        attrs: { id: 'canonical-1' },
      });
      expect(
        canonicalDocument(first.doc, () => {
          throw new Error('Canonical replay must preserve IDs');
        }),
      ).toEqual({ doc: first.doc, changed: false });
    },
  );
  it('preserves a meaningful or empty existing final paragraph and its identity, and normalizes an empty document once', () => {
    for (const content of [
      [],
      [{ type: 'text', text: 'Keep this exact final prose.' }],
    ]) {
      const source: RichNode = {
        type: 'doc',
        content: [{ type: 'paragraph', attrs: { id: 'keep-tail' }, content }],
      };
      expect(
        canonicalDocument(source, () => {
          throw new Error('Existing final paragraph must survive');
        }),
      ).toEqual({ doc: source, changed: false });
    }
    expect(canonicalDocument({ type: 'doc' }, () => 'first-tail').doc).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { id: 'first-tail' } }],
    });
  });
});
const pg = process.env.STUDIO_TEST_POSTGRES_URL;
for (const adapter of ['sqlite', 'postgres'] as const)
  describe.skipIf(adapter === 'postgres' && !pg)(
    adapter + ' durable JSON/Yjs document canonicalization',
    () => {
      async function fixture() {
        const schema = 'canonical_' + randomUUID().replaceAll('-', '');
        const store = await Store.open(
          adapter === 'sqlite'
            ? ':memory:'
            : await openDatabase({ adapter, url: pg!, schema }),
        );
        cleanup.push(async () => {
          await store.close();
          if (adapter === 'postgres') {
            const pool = new Pool(postgresPoolConfig({ url: pg! }));
            try {
              await pool.query('DROP SCHEMA "' + schema + '" CASCADE');
            } finally {
              await pool.end();
            }
          }
        });
        const user = await store.createUser(
            randomUUID() + '@test.invalid',
            'Canonical writer',
            null,
          ),
          project = await store.createProject(user, 'Canonical plan', '');
        const readState = async (id: string) => {
          const doc = new Y.Doc();
          try {
            Y.applyUpdate(doc, (await store.state(id))!);
            return yXmlFragmentToProsemirrorJSON(doc.getXmlFragment('default'));
          } finally {
            doc.destroy();
          }
        };
        return { store, user, project, readState };
      }
      it('canonicalizes terminal atoms in authored create/update before seed serialization and never rewrites on viewer reads', async () => {
        const w = await fixture();
        const created = await w.store.createArtifact(
          w.user,
          w.project.id,
          'document',
          'Final widget',
          { doc: { type: 'doc', content: [terminal[2]!] } },
        );
        expect(created.content.doc.content.at(-1).type).toBe('paragraph');
        expect(await w.readState(created.id)).toEqual(created.content.doc);
        const tail = created.content.doc.content.at(-1).attrs.id;
        const viewer = await w.store.createUser(
          randomUUID() + '@test.invalid',
          'Viewer',
          null,
        );
        await w.store.exec(
          'INSERT INTO memberships VALUES(?,?,?)',
          w.project.id,
          viewer.id,
          'viewer',
        );
        const state = await w.store.state(created.id),
          version = created.version;
        for (let i = 0; i < 3; i++) {
          await w.store.artifact(created.id, viewer.id);
          await w.store.documentState(created.id, viewer.id);
        }
        expect(await w.store.state(created.id)).toEqual(state);
        expect((await w.store.artifact(created.id, w.user.id)).version).toBe(
          version,
        );
        const updated = await w.store.updateArtifact(
          w.user,
          created.id,
          version,
          { doc: { type: 'doc', content: [terminal[0]!] } },
        );
        expect(updated.version).toBe(version + 1);
        expect(await w.readState(created.id)).toEqual(updated.content.doc);
        expect(updated.content.doc.content.at(-1).attrs.id).not.toBe(tail);
        const replay = await w.store.updateArtifact(
          w.user,
          created.id,
          updated.version,
          updated.content,
        );
        expect(replay.content).toEqual(updated.content);
        expect(await w.readState(created.id)).toEqual(updated.content.doc);
      });
      it('merges a terminal remote heading, normalizes identical JSON/Yjs once under the source lock, and makes canonical update replay version-idempotent', async () => {
        const w = await fixture(),
          initial = await w.store.artifact(w.project.mainArtifactId, w.user.id);
        const candidate = prosemirrorJSONToYDoc(editorSchema(), {
          type: 'doc',
          content: [terminal[0]!],
        });
        const source = Y.encodeStateAsUpdate(candidate);
        candidate.destroy();
        // A remote source update may carry no trailing paragraph and no existing local state.
        await w.store.exec(
          'UPDATE artifacts SET ystate=NULL WHERE id=?',
          initial.id,
        );
        const first = await w.store.persistDoc(
          w.user,
          initial.id,
          source,
          { doc: { type: 'doc', content: [terminal[0]!] } },
          undefined,
          initial.version,
        );
        expect(first.artifact.version).toBe(initial.version + 1);
        expect(first.artifact.content.doc.content.at(-1).type).toBe(
          'paragraph',
        );
        expect(await w.readState(initial.id)).toEqual(
          first.artifact.content.doc,
        );
        const tail = first.artifact.content.doc.content.at(-1).attrs.id;
        const replay = await w.store.persistDoc(
          w.user,
          initial.id,
          first.state,
          first.artifact.content,
          undefined,
          first.artifact.version,
        );
        expect(replay.artifact.version).toBe(first.artifact.version);
        expect(replay.artifact.content.doc.content.at(-1).attrs.id).toBe(tail);
        expect(await w.readState(initial.id)).toEqual(
          replay.artifact.content.doc,
        );
      });
    },
  );
