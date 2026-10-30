import { documentNodeSource } from '../shared/document-digest.ts';
import type { RichNode, User } from '../shared/domain.ts';
import {
  RECENT_AGENT_CHANGE_MS,
  type DocumentAgentChange,
  type DocumentAgentChangeSource,
} from '../shared/document-agent-changes.ts';
import { hash, type Store } from './store.ts';

const action = 'document.agent.changed';
function nodeHashes(doc: RichNode | undefined) {
  const nodes = new Map<string, string>();
  const visit = (node: RichNode) => {
    const anchor = node.attrs?.id;
    if (
      typeof anchor === 'string' &&
      anchor.length <= 100 &&
      nodes.size < 2000
    )
      nodes.set(anchor, hash(documentNodeSource(node)));
    for (const child of node.content ?? []) visit(child);
  };
  if (doc) visit(doc);
  return nodes;
}
/** Trusted server publication hook; the source write and provenance must commit together. */
export async function recordAgentDocumentChanges(
  store: Store,
  user: User,
  artifactId: string,
  before: RichNode | undefined,
  source: DocumentAgentChangeSource,
) {
  if (!store.db.inTransaction())
    throw new Error(
      'Agent change attribution requires the source publication transaction',
    );
  const artifact = await store.artifact(artifactId, user.id, 'write');
  if (!['design', 'document'].includes(artifact.kind)) return;
  const previous = nodeHashes(before),
    current = nodeHashes(artifact.content.doc);
  const changes = [...current]
    .filter(([anchor, digest]) => previous.get(anchor) !== digest)
    .slice(0, 200)
    .map(([anchor, digest]) => ({ anchor, digest }));
  if (!changes.length) return;
  await store.audit(
    artifact.projectId,
    artifactId,
    user.name,
    action,
    JSON.stringify({ version: artifact.version, source, changes }),
  );
}
/** A marker is visible only while the exact attributed node still exists and the viewer remains authorized. */
export async function recentAgentDocumentChanges(
  store: Store,
  user: User,
  artifactId: string,
  now = Date.now(),
): Promise<DocumentAgentChange[]> {
  return store.tx(async () => {
    const artifact = await store.artifact(artifactId, user.id);
    await store.db.lock('project:' + artifact.projectId);
    await store.role(artifact.projectId, user.id);
    const nodes = nodeHashes(
      (await store.artifact(artifactId, user.id)).content.doc,
    );
    const events = await store.all(
      'SELECT actor,detail,created_at FROM audit WHERE artifact_id=? AND action=? AND created_at>=? ORDER BY id DESC LIMIT 12',
      artifactId,
      action,
      new Date(now - RECENT_AGENT_CHANGE_MS).toISOString(),
    );
    const result = new Map<string, DocumentAgentChange>();
    for (const event of events) {
      const created = Date.parse(event.created_at),
        expiresAt = created + RECENT_AGENT_CHANGE_MS;
      if (!Number.isFinite(created) || created > now || expiresAt <= now)
        continue;
      let detail: any;
      try {
        detail = JSON.parse(event.detail);
      } catch {
        continue;
      }
      if (
        !Number.isSafeInteger(detail.version) ||
        typeof detail.source !== 'string' ||
        detail.source.length > 100 ||
        !Array.isArray(detail.changes)
      )
        continue;
      for (const item of detail.changes.slice(0, 200)) {
        if (result.size >= 200) break;
        if (
          !item ||
          typeof item.anchor !== 'string' ||
          typeof item.digest !== 'string' ||
          !/^[a-f0-9]{64}$/.test(item.digest) ||
          result.has(item.anchor) ||
          nodes.get(item.anchor) !== item.digest
        )
          continue;
        result.set(item.anchor, {
          anchor: item.anchor,
          digest: item.digest,
          version: detail.version,
          actor: event.actor,
          source: detail.source,
          createdAt: event.created_at,
          expiresAt,
        });
      }
    }
    return [...result.values()];
  });
}
