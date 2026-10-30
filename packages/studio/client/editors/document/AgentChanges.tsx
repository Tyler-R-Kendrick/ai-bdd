import { documentNodeSource } from '../../../shared/document-digest.ts';
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { useEffect } from 'react';
import type { DocumentAgentChange } from '../../../shared/document-agent-changes.ts';
import { api } from '../../lib.ts';
import { useDocumentWorkspace } from './Workspace.tsx';
const key = new PluginKey('studio-agent-changes');
export const AgentChangeDecorations = Extension.create({
  name: 'agentChangeDecorations',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key,
        state: {
          init: () => DecorationSet.empty,
          apply(transaction, previous) {
            const update = transaction.getMeta(key) as
              | Decoration[]
              | undefined;
            if (update) return DecorationSet.create(transaction.doc, update);
            return transaction.docChanged ? DecorationSet.empty : previous;
          },
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
        },
      }),
    ];
  },
});
export function AgentChangeMarkers() {
  const { artifact, editor } = useDocumentWorkspace();
  useEffect(() => {
    if (!editor) return;
    let stopped = false, generation = 0;
    let retained: DocumentAgentChange[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const render = async (markers: DocumentAgentChange[]) => {
      if (stopped || editor.isDestroyed) return;
      const attempt = ++generation;
      if (timer) clearTimeout(timer);
      const now = Date.now(),
        decorations: Decoration[] = [],
        candidates: Promise<void>[] = [];
      const active = new Map(
        markers
          .filter((item) => item.expiresAt > now)
          .map((item) => [item.anchor, item]),
      );
      const doc = editor.state.doc;
      doc.descendants((node, position) => {
        const marker = active.get(node.attrs.id);
        if (!marker) return;
        candidates.push(
          (async () => {
            const bytes = await crypto.subtle.digest(
              'SHA-256',
              new TextEncoder().encode(documentNodeSource(node.toJSON())),
            );
            const digest = Array.from(new Uint8Array(bytes), (n) =>
              n.toString(16).padStart(2, '0'),
            ).join('');
            if (digest !== marker.digest) return;
            const elapsed = Math.min(
              30,
              Math.max(0, (now - Date.parse(marker.createdAt)) / 1000),
            );
            decorations.push(
              Decoration.node(position, position + node.nodeSize, {
                class: 'document-agent-change',
                'data-agent-change': 'true',
                title: `${marker.source} · ${marker.actor}`,
                style: `animation-delay: -${elapsed}s`,
              }),
            );
          })(),
        );
      });
      await Promise.all(candidates);
      if (stopped || editor.isDestroyed || editor.state.doc !== doc || attempt !== generation) return;
      editor.view.dispatch(editor.state.tr.setMeta(key, decorations));
      const expiry = Math.min(
        ...[...active.values()].map((item) => item.expiresAt),
      );
      if (Number.isFinite(expiry))
        timer = setTimeout(
          () => void render(markers),
          Math.max(20, expiry - Date.now() + 10),
        );
    };
    const updated = () => void render(retained);
    editor.on('update', updated);
    void api<DocumentAgentChange[]>(
      `/artifacts/${artifact.id}/document/agent-changes`,
    )
      .then((markers) => { retained = markers; return render(markers); })
      .catch(() => {
        if (!stopped && !editor.isDestroyed)
          editor.view.dispatch(editor.state.tr.setMeta(key, []));
      });
    return () => {
      stopped = true;
      generation++;
      editor.off('update', updated);
      if (timer) clearTimeout(timer);
    };
  }, [artifact.id, artifact.version, editor]);
  return null;
}
