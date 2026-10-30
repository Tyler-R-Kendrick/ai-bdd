import { documentNodeSource } from '../../../shared/document-digest.ts';
import { useEffect, useState } from 'react';
import type { Editor } from '@tiptap/core';
import type { Artifact, RichNode } from '../../../shared/domain.ts';
import type { InvestigationPlacement } from '../../../shared/investigations.ts';
import { Button, Input, Modal } from '../../components/ui.tsx';
import { api } from '../../lib.ts';

export type PassageCommandTarget = {
  version: number;
  blockIndex: number;
  block: RichNode;
  left: number;
  top: number;
};
export async function passagePlacement(
  target: Pick<PassageCommandTarget, 'version' | 'blockIndex' | 'block'>,
): Promise<InvestigationPlacement> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(documentNodeSource(target.block)),
  );
  return {
    version: target.version,
    blockIndex: target.blockIndex,
    digest: Array.from(new Uint8Array(digest), (n) =>
      n.toString(16).padStart(2, '0'),
    ).join(''),
  };
}
export function DocumentCommands({
  target,
  editor,
  artifact,
  readOnly,
  onClose,
  onInvestigations,
  onError,
}: {
  target: PassageCommandTarget | null;
  editor: Editor | null;
  artifact: Artifact;
  readOnly: boolean;
  onClose: () => void;
  onInvestigations?: (
    id?: string,
    placement?: InvestigationPlacement,
  ) => void;
  onError: (message: string) => void;
}) {
  const [query, setQuery] = useState(''),
    [research, setResearch] = useState<InvestigationPlacement | null>(null),
    [brief, setBrief] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [requestId, setRequestId] = useState('');
  useEffect(() => {
    setQuery('');
  }, [target]);
  useEffect(() => { if (readOnly) { setResearch(null); onClose(); } }, [readOnly]);
  useEffect(() => {
    setResearch(null);
    setError('');
  }, [artifact.id]);
  const select = async (command: 'research' | 'investigate') => {
    if (!target || busy || readOnly) return;
    setBusy(true);
    try {
      const placement = await passagePlacement(target);
      if (command === 'research') {
        setResearch(placement);
        setRequestId(crypto.randomUUID());
        setBrief('');
        setError('');
      } else onInvestigations?.(undefined, placement);
      onClose();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const start = async () => {
    if (!research || busy || readOnly || !brief.trim()) return;
    setBusy(true);
    setError('');
    try {
      const bundle = await api<{
        threads: { id: string; anchor: string | null }[];
      }>(`/artifacts/${artifact.id}`);
      const thread = bundle.threads.find((thread) => !thread.anchor);
      if (!thread)
        throw new Error(
          'The artifact conversation is unavailable. Reload before starting research.',
        );
      await api(`/artifacts/${artifact.id}/agent`, 'POST', {
        threadId: thread.id,
        intent: 'research',
        brief,
        artifactVersion: research.version,
        idempotencyKey: requestId,
        placement: {
          blockIndex: research.blockIndex,
          digest: research.digest,
        },
      });
      setResearch(null);
      editor?.commands.focus();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const keepText = () => {
    if (!editor || readOnly || busy) return;
    editor.chain().focus().insertContent({ type: 'text', text: '/' + query }).run();
    onClose();
  };
  const commands = (['research', 'investigate'] as const).filter((command) =>
    command.startsWith(query.toLowerCase().replace(/^\//, '').trim()),
  );
  return (
    <>
      {target && (
        <div
          className="document-command-menu"
          style={{
            left: Math.max(
              12,
              Math.min(target.left, window.innerWidth - 292),
            ),
            top: Math.max(
              12,
              Math.min(target.top + 8, window.innerHeight - 220),
            ),
          }}
          role="dialog"
          aria-label="Document commands"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              keepText();
            }
          }}
        >
          <Input
            autoFocus
            aria-label="Document command"
            placeholder="Research or investigate…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && commands[0]) {
                e.preventDefault();
                void select(commands[0]);
              }
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                e.currentTarget.parentElement
                  ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
                  ?.focus();
              }
            }}
          />
          <div role="menu" aria-label="Passage actions">
            {commands.includes('research') && (
              <Button
                role="menuitem"
                variant="ghost"
                disabled={busy}
                onClick={() => void select('research')}
              >
                Research · /research
              </Button>
            )}
            {commands.includes('investigate') && (
              <Button
                role="menuitem"
                variant="ghost"
                disabled={busy || !onInvestigations}
                onClick={() => void select('investigate')}
              >
                Investigate · /investigate
              </Button>
            )}
            {!commands.length && <p>No matching command.</p>}
          </div>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={keepText}
          >
            Keep as text
          </Button>
        </div>
      )}
      <Modal
        open={!!research}
        onOpenChange={(open) => {
          if (!open && !busy) setResearch(null);
        }}
        title="Research this passage"
        description="Review the exact brief before starting research with this artifact's selected agent. The report stays linked beside this passage."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
          <label>
            Research brief
            <textarea
              autoFocus
              aria-label="Research brief"
              value={brief}
              maxLength={2000}
              onChange={(e) => setBrief(e.target.value)}
              className="document-command-brief"
            />
          </label>
          {research && <p>Selected passage · source v{research.version}</p>}
          {error && (
            <p role="alert" className="document-error">
              {error}
            </p>
          )}
          <div className="modal-footer">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setResearch(null)}
            >
              Cancel
            </Button>
            <Button disabled={busy || !brief.trim()}>
              {busy ? 'Starting…' : 'Start research'}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
