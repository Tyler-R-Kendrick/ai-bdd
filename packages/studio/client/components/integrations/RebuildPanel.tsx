import { useCallback, useEffect, useState } from 'react';
import type { Artifact } from '../../../shared/domain.ts';
import { api, date } from '../../lib.ts';
import { Badge, Button, Spinner } from '../ui.tsx';
import './rebuild.css';
type Snapshot = {
  pending?: { dueAt: number; error: string | null } | null;
  currentSourceSha256: string;
  automaticEnabled: boolean;
  baseline: {
    revision: number;
    sourceVersion: number;
    sourceSha256: string;
    updatedAt: string;
    machineId?: string;
  } | null;
  changes: number;
  runs: {
    id: string;
    status: string;
    automatic: number;
    error?: string;
    machineId?: string;
    sourceVersion: number;
    createdAt: string;
  }[];
};
export function RebuildPanel({
  artifact,
  readOnly = false,
  onError,
  onChanged,
}: {
  artifact: Artifact;
  readOnly?: boolean;
  onError?: (message: string) => void;
  onChanged?: () => void | Promise<void>;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const refresh = useCallback(
    async () =>
      setSnapshot(
        await api<Snapshot>(`/artifacts/${artifact.id}/implementation/rebuild`),
      ),
    [artifact.id],
  );
  useEffect(() => {
    let active = true;
    const load = () =>
      void refresh().catch((error) => {
        if (active) setError(error.message);
      });
    load();
    const timer = setInterval(load, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [refresh, artifact.version]);
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await work();
      await refresh();
      await onChanged?.();
    } catch (error) {
      const message = (error as Error).message;
      setError(message);
      onError?.(message);
    } finally {
      setBusy(false);
    }
  };
  if (!snapshot)
    return error ? <p className="field-error">{error}</p> : <Spinner />;
  if (!snapshot.baseline)
    return (
      <section className="rebuild-panel">
        <h3>Living document</h3>
        <p>
          A verified build with an open pull request establishes the source
          baseline. Later document changes can rebuild those existing PRs.
        </p>
      </section>
    );
  const running = snapshot.runs.find((run) =>
      ['queued', 'running'].includes(run.status),
    ),
    last = snapshot.runs[0];
  return (
    <section className="rebuild-panel" aria-label="Living document rebuild">
      <header>
        <h3>Living document</h3>
        <Badge
          tone={running ? 'amber' : snapshot.changes ? 'neutral' : 'green'}
        >
          {running
            ? 'Building changes'
            : snapshot.changes
              ? `${snapshot.changes} changes to build`
              : 'Built'}
        </Badge>
      </header>
      <p>
        Delivered source v{snapshot.baseline.sourceVersion} ·{' '}
        {date(snapshot.baseline.updatedAt)}. Rebuild keeps the existing PRs and
        the reviewed base graph.
      </p>
      {!readOnly && (
        <div className="rebuild-actions">
          <Button
            disabled={busy || !!running || !snapshot.changes}
            onClick={() =>
              void act(() =>
                api(
                  `/artifacts/${artifact.id}/implementation/rebuild`,
                  'POST',
                  { expectedSourceSha256: snapshot.currentSourceSha256 },
                ),
              )
            }
          >
            {busy ? (
              <Spinner />
            ) : last?.status === 'failed' ? (
              'Retry changes'
            ) : (
              'Build changes'
            )}
          </Button>
          {running?.machineId && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void act(() =>
                  api(
                    `/artifacts/${artifact.id}/implementation/rebuild/${running.id}/cancel`,
                    'POST',
                    {},
                  ),
                )
              }
            >
              Stop rebuild
            </Button>
          )}
        </div>
      )}
      {!readOnly && snapshot.baseline.machineId && (
        <label className="rebuild-consent">
          <input
            type="checkbox"
            checked={snapshot.automaticEnabled}
            disabled={busy}
            onChange={(event) => {
              const enabled = event.target.checked;
              void act(() =>
                api(
                  `/machines/${snapshot.baseline!.machineId}/rebuild-consent`,
                  'PUT',
                  { enabled },
                ),
              );
            }}
          />
          <span>
            Let this machine rebuild this repository automatically after
            document edits settle. Agent work runs on your machine; existing PR
            branches may change.
          </span>
        </label>
      )}
      {snapshot.pending?.error && (
        <p role="status">Waiting: {snapshot.pending.error}</p>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <p>
        History retains up to 100 rebuilds. Older ended entries are pruned when
        new work is admitted.
      </p>
      <ol>
        {snapshot.runs.slice(0, 5).map((run) => (
          <li key={run.id}>
            <strong>{run.status.replaceAll('_', ' ')}</strong> · source v
            {run.sourceVersion} · {run.automatic ? 'automatic' : 'requested'}
            <span>{date(run.createdAt)}</span>
            {run.error && <p>{run.error}</p>}
          </li>
        ))}
      </ol>
    </section>
  );
}
