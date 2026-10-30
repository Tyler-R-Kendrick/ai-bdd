import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, ArrowUpRight, RotateCcw, Trash2 } from 'lucide-react';
import type { Project } from '../../shared/domain.ts';
import type {
  ArchivedArtifact,
  LifecycleInspection,
} from '../../shared/artifact-lifecycle.ts';
import { kindLabels } from '../../shared/domain.ts';
import { api, date } from '../lib.ts';
import { Badge, Button, Field, Input, Modal, Spinner } from './ui.tsx';
import './archive.css';
export function ArchivePanel({
  project,
  open,
  onOpenChange,
  onOpenArtifact,
  onChanged,
  onError,
}: {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenArtifact: (id: string) => void;
  onChanged: () => void | Promise<void>;
  onError?: (message: string) => void;
}) {
  const [items, setItems] = useState<ArchivedArtifact[]>([]),
    [cursor, setCursor] = useState<number | null>(null),
    [selected, setSelected] = useState<LifecycleInspection | null>(null),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [confirming, setConfirming] = useState(false),
    [title, setTitle] = useState(''),
    [ack, setAck] = useState(false);
  const generation = useRef(0),
    selection = useRef(0);
  const load = useCallback(
    async (after = 0) => {
      const request = ++generation.current;
      setLoading(true);
      try {
        const result = await api<{
          items: ArchivedArtifact[];
          nextCursor: number | null;
        }>(`/projects/${project.id}/archive?after=${after}`);
        if (request !== generation.current) return;
        setItems((previous) =>
          after ? [...previous, ...result.items] : result.items,
        );
        setCursor(result.nextCursor);
      } finally {
        if (request === generation.current) setLoading(false);
      }
    },
    [project.id],
  );
  const inspect = useCallback(async (id: string) => {
    const request = ++selection.current;
    setSelected(null);
    setConfirming(false);
    setTitle('');
    setAck(false);
    const result = await api<LifecycleInspection>(`/artifacts/${id}/lifecycle`);
    if (request === selection.current) setSelected(result);
  }, []);
  useEffect(() => {
    if (!open) return;
    setError('');
    setSelected(null);
    setConfirming(false);
    void load().catch((error) => setError(error.message));
    return () => {
      generation.current++;
      selection.current++;
    };
  }, [open, load]);
  const act = async (action: 'restore' | 'purge') => {
    if (!selected) return;
    setBusy(true);
    setError('');
    const artifact = selected.artifact;
    try {
      const result = await api<{ cleanupPending?: boolean }>(
        `/artifacts/${artifact.id}${action === 'restore' ? '/restore' : ''}`,
        action === 'restore' ? 'POST' : 'DELETE',
        {
          version: artifact.version,
          archiveRevision: artifact.archiveRevision,
          ...(action === 'purge' ? { confirmTitle: title } : {}),
        },
      );
      setSelected(null);
      setConfirming(false);
      setTitle('');
      setAck(false);
      await load();
      await onChanged();
      if (result.cleanupPending)
        setError(
          'Artifact deleted. Private asset cleanup is queued and retries automatically.',
        );
    } catch (error) {
      const message = (error as Error).message;
      setError(message);
      onError?.(message);
      await inspect(artifact.id).catch(() => setSelected(null));
    } finally {
      setBusy(false);
    }
  };
  const owner = project.role === 'owner',
    artifact = selected?.artifact;
  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
      title="Archived artifacts"
      description="Archived artifacts retain their discussion, decisions, and evidence. Open one to read it, or restore it to the project."
    >
      <div className="archive-browser" aria-busy={busy || loading}>
        {error && (
          <p className="archive-notice" role="status">
            {error}
          </p>
        )}
        {!owner && (
          <p className="muted small">
            Project owners can restore or permanently delete eligible archived
            drafts.
          </p>
        )}
        <div className="archive-list" aria-label="Archived artifact list">
          {items.map((item) => (
            <article
              key={item.id}
              className={
                'archive-row' + (artifact?.id === item.id ? ' selected' : '')
              }
            >
              <Archive size={17} />
              <button
                className="archive-item"
                disabled={busy}
                onClick={() =>
                  void inspect(item.id).catch((error) =>
                    setError(error.message),
                  )
                }
              >
                <strong>{item.title}</strong>
                <span>
                  {kindLabels[item.kind]} ·{' '}
                  {item.archivedAt ? 'Archived' : 'Last updated'}{' '}
                  {date(item.archivedAt ?? item.updatedAt)}
                </span>
              </button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                aria-label={`Open archived ${item.title}`}
                onClick={() => {
                  onOpenChange(false);
                  onOpenArtifact(item.id);
                }}
              >
                <ArrowUpRight size={15} />
                Open
              </Button>
            </article>
          ))}
          {!items.length && !loading && (
            <p className="archive-empty">
              No archived artifacts in this project.
            </p>
          )}
        </div>
        {loading && <Spinner label="Loading archive…" />}
        {cursor !== null && (
          <Button
            variant="outline"
            disabled={loading || busy}
            onClick={() =>
              void load(cursor).catch((error) => setError(error.message))
            }
          >
            Load more
          </Button>
        )}
        {selected && (
          <section
            className="archive-detail"
            aria-label="Archived artifact details"
          >
            <header>
              <h3>{artifact!.title}</h3>
              <Badge>Archived · v{artifact!.version}</Badge>
            </header>
            <p className="muted small">
              {(
                [
                  [selected.counts.messages, 'message'],
                  [selected.counts.decisions, 'decision'],
                  [selected.counts.revisions, 'version'],
                  [selected.counts.files, 'uploaded file'],
                ] as const
              )
                .map(
                  ([count, label]) =>
                    `${count} ${label}${count === 1 ? '' : 's'}`,
                )
                .join(' · ')}
            </p>
            {selected.blockers.length > 0 && (
              <div className="archive-dependencies">
                <h4>Retained dependencies</h4>
                <ul>
                  {selected.blockers.map((blocker, index) => (
                    <li key={index}>
                      {blocker.message}
                      {blocker.retryAt && (
                        <>
                          {' '}
                          Available after{' '}
                          {date(new Date(blocker.retryAt).toISOString())}.
                        </>
                      )}
                      {blocker.artifactId &&
                        blocker.artifactId !== artifact!.id && (
                          <button
                            onClick={() => {
                              onOpenChange(false);
                              onOpenArtifact(blocker.artifactId!);
                            }}
                          >
                            Open related artifact
                          </button>
                        )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {owner && selected.canManage && (
              <>
                <div className="archive-actions">
                  <Button
                    variant="outline"
                    disabled={busy || selected.restoreBlockers.length > 0}
                    onClick={() => void act('restore')}
                  >
                    <RotateCcw size={15} />
                    Restore artifact
                  </Button>
                  <Button
                    variant="ghost"
                    className="archive-danger"
                    disabled={busy || selected.blockers.length > 0}
                    onClick={() => {
                      setConfirming(true);
                      setTitle('');
                      setAck(false);
                    }}
                  >
                    <Trash2 size={15} />
                    Delete permanently…
                  </Button>
                </div>
                {confirming && (
                  <div
                    className="archive-confirm"
                    role="group"
                    aria-label="Confirm permanent artifact deletion"
                  >
                    <h4>Permanently delete this archived draft?</h4>
                    <p>
                      This deletes its content, version history, discussion,
                      decisions, and uploaded files. This action cannot be
                      undone. Published evidence and references must remain
                      linked.
                    </p>
                    <Field label={`Type “${artifact!.title}” to confirm`}>
                      <Input
                        aria-label="Artifact title confirmation"
                        value={title}
                        onChange={(event) => setTitle(event.target.value)}
                        autoComplete="off"
                        disabled={busy}
                      />
                    </Field>
                    <label className="archive-ack">
                      <input
                        type="checkbox"
                        checked={ack}
                        onChange={(event) => setAck(event.target.checked)}
                        disabled={busy}
                      />
                      I understand this permanently deletes the archived
                      artifact and its owned context.
                    </label>
                    <div className="archive-actions">
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => setConfirming(false)}
                      >
                        Cancel deletion
                      </Button>
                      <Button
                        variant="destructive"
                        disabled={
                          busy ||
                          !ack ||
                          title !== artifact!.title ||
                          selected.blockers.length > 0
                        }
                        onClick={() => void act('purge')}
                      >
                        {busy ? 'Deleting…' : 'Permanently delete artifact'}
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
        )}
      </div>
    </Modal>
  );
}
