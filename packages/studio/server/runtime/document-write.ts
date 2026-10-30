import * as Y from 'yjs';
import { prosemirrorToYXmlFragment } from 'y-prosemirror';
import type { RichNode, User } from '../../shared/domain.ts';
import { editorSchema } from '../../shared/editor.ts';
import type { Store } from '../store.ts';
import type { Collaboration } from '../collaboration.ts';

/** Durable-only document mutation. Caller refreshes local rooms after its outer SQL transaction commits. */
export async function mutateDocument(
  store: Store,
  collab: Collaboration,
  user: User,
  id: string,
  mutate: (doc: RichNode) => boolean,
) {
  return store.tx(async () => {
    const original = await store.artifact(id, user.id, 'write');
    await store.db.lock('project:' + original.projectId);
    const artifact = await store.artifact(id, user.id, 'write');
    if (!['design', 'document'].includes(artifact.kind)) return artifact;
    const content = structuredClone(artifact.content);
    if (!mutate(content.doc)) return artifact;
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, await store.documentState(id, user.id));
      const next = editorSchema().nodeFromJSON(content.doc);
      next.check();
      prosemirrorToYXmlFragment(next, doc.getXmlFragment('default'));
      return (
        await store.persistDoc(
          user,
          id,
          Y.encodeStateAsUpdate(doc),
          content,
          () => collab.publishDocumentMetadata(artifact.projectId, id),
          artifact.version,
        )
      ).artifact;
    } finally {
      doc.destroy();
    }
  });
}
