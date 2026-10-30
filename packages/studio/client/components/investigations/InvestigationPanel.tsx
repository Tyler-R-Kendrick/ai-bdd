import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, date } from '../../lib.ts';
import {
  emptySelection,
  filteredRows,
  type Investigation,
  type Selection,
  type NativeView,
  type Dataset,
} from '../../../shared/investigations.ts';
import './investigations.css';

type ViewProps = {
  investigation: Investigation;
  viewId: string;
  canWrite: boolean;
  onRefresh: () => void | Promise<void>;
};
export function InvestigationView({
  investigation,
  viewId,
  canWrite,
  onRefresh,
}: ViewProps) {
  const view = investigation.result?.views.find((v) => v.id === viewId),
    dataset = investigation.result?.datasets.find(
      (d) => d.id === view?.datasetId,
    ),
    saved = investigation.selections[viewId];
  const [selection, setSelection] = useState<Selection>(
      saved?.selection ?? emptySelection(),
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [conclusion, setConclusion] = useState(''),
    [rationale, setRationale] = useState('');
  useEffect(() => {
    setSelection(saved?.selection ?? emptySelection());
  }, [saved?.revision, viewId]);
  if (!view || !dataset || !saved)
    return (
      <p role="status">This view is unavailable in the published evidence.</p>
    );
  const dirty = JSON.stringify(selection) !== JSON.stringify(saved.selection),
    rows = filteredRows(dataset, selection);
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await api(
        `/investigations/${investigation.id}/views/${viewId}/selection`,
        'PUT',
        { revision: saved.revision, selection },
      );
      await onRefresh();
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 409
          ? 'A collaborator changed these selections. Refresh to review the current evidence before saving.'
          : (e as Error).message,
      );
    } finally {
      setBusy(false);
    }
  };
  const decide = async () => {
    setBusy(true);
    setError('');
    try {
      await api(
        `/investigations/${investigation.id}/views/${viewId}/decisions`,
        'POST',
        { revision: saved.revision, conclusion, rationale },
      );
      setConclusion('');
      setRationale('');
      await onRefresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="investigation-view" aria-label={view.title}>
      <header>
        <h4>{view.title}</h4>
        <span>
          {rows.length} / {dataset.rows.length} rows · selection r
          {saved.revision}
        </span>
      </header>
      {error && (
        <p className="inv-error" role="alert">
          {error}
        </p>
      )}
      <div className="inv-filter">
        <label>
          Filter column
          <select
            aria-label="Filter column"
            disabled={!canWrite || busy}
            value={selection.filters[0]?.columnId ?? ''}
            onChange={(e) => {
              const column = dataset.columns.find(
                (c) => c.id === e.target.value,
              );
              setSelection({
                ...selection,
                filters: column
                  ? [
                      {
                        columnId: column.id,
                        operator: column.type === 'string' ? 'contains' : 'eq',
                        value:
                          column.type === 'number'
                            ? 0
                            : column.type === 'boolean'
                              ? true
                              : '',
                      },
                    ]
                  : [],
              });
            }}
          >
            <option value="">All rows</option>
            {dataset.columns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        {selection.filters[0] && (
          <label>
            Filter value
            <input
              aria-label="Filter value"
              disabled={!canWrite || busy}
              value={String(selection.filters[0].value ?? '')}
              onChange={(e) => {
                const column = dataset.columns.find(
                  (c) => c.id === selection.filters[0]!.columnId,
                )!;
                const value =
                  column.type === 'number'
                    ? Number(e.target.value)
                    : column.type === 'boolean'
                      ? e.target.value === 'true'
                      : e.target.value;
                setSelection({
                  ...selection,
                  filters: [{ ...selection.filters[0]!, value }],
                });
              }}
            />
          </label>
        )}
        <span>{selection.rowIds.length} selected</span>
        {canWrite && (
          <button disabled={busy || !dirty} onClick={() => void save()}>
            Share selections
          </button>
        )}
        {dirty && (
          <button onClick={() => setSelection(saved.selection)} disabled={busy}>
            Reset changes
          </button>
        )}
      </div>
      {view.type !== 'table' && (
        <NativeChart dataset={dataset} view={view} selection={selection} />
      )}
      <div className="inv-table-scroll">
        <table>
          <caption>{dataset.title}</caption>
          <thead>
            <tr>
              <th scope="col">Select</th>
              {view.columns.map((id) => (
                <th scope="col" key={id}>
                  {dataset.columns.find((c) => c.id === id)!.label}
                  {dataset.columns.find((c) => c.id === id)!.unit &&
                    ` (${dataset.columns.find((c) => c.id === id)!.unit})`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 200).map((row) => (
              <tr
                key={row.id}
                className={selection.rowIds.includes(row.id) ? 'selected' : ''}
              >
                <td>
                  <input
                    aria-label={`Select row ${row.id}`}
                    type="checkbox"
                    checked={selection.rowIds.includes(row.id)}
                    disabled={!canWrite || busy}
                    onChange={(e) =>
                      setSelection({
                        ...selection,
                        rowIds: e.target.checked
                          ? [...selection.rowIds, row.id]
                          : selection.rowIds.filter((id) => id !== row.id),
                      })
                    }
                  />
                </td>
                {view.columns.map((id) => (
                  <td key={id}>
                    {row.values[id] === null ? '—' : String(row.values[id])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length > 200 && (
          <p>
            Showing the first 200 matching rows. The shared filter applies to
            all {dataset.rows.length} rows.
          </p>
        )}
      </div>
      {canWrite && (
        <details>
          <summary>Record a decision against this evidence</summary>
          <label>
            Conclusion
            <textarea
              value={conclusion}
              maxLength={4000}
              onChange={(e) => setConclusion(e.target.value)}
            />
          </label>
          <label>
            Rationale
            <textarea
              value={rationale}
              maxLength={8000}
              onChange={(e) => setRationale(e.target.value)}
            />
          </label>
          <button
            disabled={busy || dirty || !conclusion.trim() || !rationale.trim()}
            onClick={() => void decide()}
          >
            Record decision · selection r{saved.revision}
          </button>
          {dirty && (
            <p>
              Share or reset your selection changes before recording a decision.
            </p>
          )}
        </details>
      )}
      <div className="inv-decisions">
        {investigation.decisions
          .filter((d) => d.viewId === viewId)
          .map((d) => (
            <article key={d.id}>
              <strong>{d.conclusion}</strong>
              <p>{d.rationale}</p>
              <small>
                {d.authorName} · {date(d.createdAt)} ·{' '}
                {d.selection.rowIds.length} rows · selection r
                {d.selectionRevision}
              </small>
              <code title={d.sha256}>
                Evidence {d.resultHash.slice(0, 12)} · decision{' '}
                {d.sha256.slice(0, 12)}
              </code>
            </article>
          ))}
      </div>
    </section>
  );
}
function NativeChart({
  dataset,
  view,
  selection,
}: {
  dataset: Dataset;
  view: NativeView;
  selection: Selection;
}) {
  const filtered = filteredRows(dataset, selection),
    rows = (
      selection.rowIds.length
        ? filtered.filter((r) => selection.rowIds.includes(r.id))
        : filtered
    ).filter((r) => typeof r.values[view.y!] === 'number');
  if (!rows.length) return <p>No numeric observations match this selection.</p>;
  if (view.type === 'metric')
    return (
      <div className="inv-metrics">
        {rows.slice(0, 32).map((row) => (
          <div key={row.id}>
            <small>
              {String(row.values[view.x ?? view.columns[0]!] ?? row.id)}
            </small>
            <strong>{String(row.values[view.y!])}</strong>
            <span>{dataset.columns.find((c) => c.id === view.y)?.unit}</span>
          </div>
        ))}
      </div>
    );
  const values = rows.map((row) => Number(row.values[view.y!])),
    min = Math.min(0, ...values),
    max = Math.max(0, ...values),
    span = max - min || 1,
    plot = rows.slice(0, 200),
    y = (v: number) => 230 - ((v - min) / span) * 195,
    zero = y(0);
  if (view.type === 'bar')
    return (
      <svg
        role="img"
        aria-label={`${view.title}: ${rows.length} observations`}
        viewBox="0 0 680 280"
      >
        <title>{view.title}</title>
        <line x1="45" y1={zero} x2="670" y2={zero} stroke="currentColor" />
        {plot.map((row, i) => {
          const v = Number(row.values[view.y!]),
            w = 610 / plot.length;
          return (
            <g key={row.id}>
              <rect
                x={50 + i * w}
                width={Math.max(1, w - 3)}
                y={Math.min(zero, y(v))}
                height={Math.max(1, Math.abs(y(v) - zero))}
                fill="#835cef"
              >
                <title>
                  {String(row.values[view.x!])}: {v}
                </title>
              </rect>
              {plot.length < 12 && (
                <text x={50 + i * w + w / 2} y="254" textAnchor="middle">
                  {String(row.values[view.x!]).slice(0, 16)}
                </text>
              )}
            </g>
          );
        })}
        <text x="4" y="28">
          {max.toPrecision(4)}
        </text>
        <text x="4" y="235">
          {min.toPrecision(4)}
        </text>
      </svg>
    );
  const xColumn = dataset.columns.find((c) => c.id === view.x)!,
    ordered = [...plot].sort((a, b) =>
      xColumn.type === 'date'
        ? Date.parse(String(a.values[view.x!])) -
          Date.parse(String(b.values[view.x!]))
        : Number(a.values[view.x!]) - Number(b.values[view.x!]),
    );
  const xs = ordered.map((row) =>
      xColumn.type === 'date'
        ? Date.parse(String(row.values[view.x!]))
        : Number(row.values[view.x!]),
    ),
    xMin = Math.min(...xs),
    xMax = Math.max(...xs),
    x = (v: number) => 50 + ((v - xMin) / (xMax - xMin || 1)) * 610;
  return (
    <svg
      role="img"
      aria-label={`${view.title}: ${rows.length} observations`}
      viewBox="0 0 680 280"
    >
      <title>{view.title}</title>
      <line x1="45" y1={zero} x2="670" y2={zero} stroke="currentColor" />
      <polyline
        fill="none"
        stroke="#835cef"
        strokeWidth="3"
        points={ordered
          .map((row, i) => `${x(xs[i]!)},${y(Number(row.values[view.y!]))}`)
          .join(' ')}
      />
      {ordered.map((row, i) => (
        <circle
          key={row.id}
          cx={x(xs[i]!)}
          cy={y(Number(row.values[view.y!]))}
          r="3"
          fill="#835cef"
        >
          <title>
            {String(row.values[view.x!])}: {String(row.values[view.y!])}
          </title>
        </circle>
      ))}
      <text x="4" y="28">
        {max.toPrecision(4)}
      </text>
      <text x="4" y="235">
        {min.toPrecision(4)}
      </text>
      <text x="50" y="258">
        {String(ordered[0]?.values[view.x!])}
      </text>
      <text x="660" y="258" textAnchor="end">
        {String(ordered.at(-1)?.values[view.x!])}
      </text>
    </svg>
  );
}
export function InvestigationPanel({
  artifactId,
  artifactVersion,
  currentUserId,
  canWrite,
  onOpenArtifact,
}: {
  artifactId: string;
  artifactVersion: number;
  currentUserId: string;
  canWrite: boolean;
  onOpenArtifact?: (id: string) => void;
}) {
  const [records, setRecords] = useState<Investigation[]>([]),
    [checkouts, setCheckouts] = useState<
      { sourceCommit: string; label: string; machineId: string }[]
    >([]),
    [brief, setBrief] = useState(''),
    [sourceCommit, setSourceCommit] = useState(''),
    [requiredReason, setRequiredReason] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    const result = await api<{
      records: Investigation[];
      checkouts: { sourceCommit: string; label: string; machineId: string }[];
    }>(`/artifacts/${artifactId}/investigations`);
    setRecords(result.records);
    setCheckouts(result.checkouts);
  }, [artifactId]);
  useEffect(() => {
    setRecords([]);
    setSourceCommit('');
    void refresh().catch((e) => setError(e.message));
    const timer = setInterval(() => void refresh().catch(() => {}), 5000);
    return () => clearInterval(timer);
  }, [refresh]);
  const action = async (id: string, action: string) => {
    setBusy(true);
    setError('');
    try {
      await api(`/investigations/${id}/${action}`, 'POST', {});
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const propose = async () => {
    setBusy(true);
    setError('');
    try {
      await api(`/artifacts/${artifactId}/investigations`, 'POST', {
        version: artifactVersion,
        brief,
        sourceCommit: sourceCommit || checkouts[0]?.sourceCommit,
        ...(requiredReason ? { requiredReason } : {}),
      });
      setBrief('');
      setRequiredReason('');
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="investigation-panel">
      <header>
        <h3>Local investigations</h3>
        <p>
          Measure against a fixed checkout, compare native data, and record
          decisions with exact evidence.
        </p>
      </header>
      {error && (
        <p className="inv-error" role="alert">
          {error}
        </p>
      )}
      {canWrite && (
        <details>
          <summary>Propose investigation</summary>
          <label>
            Brief
            <textarea
              placeholder="What should the investigation measure?"
              value={brief}
              maxLength={8000}
              onChange={(e) => setBrief(e.target.value)}
            />
          </label>
          <label>
            Checkout commit
            <input
              placeholder={
                checkouts[0]?.sourceCommit ?? '40 character Git commit'
              }
              value={sourceCommit}
              onChange={(e) => setSourceCommit(e.target.value.toLowerCase())}
              pattern="[a-f0-9]{40}"
            />
          </label>
          {checkouts[0] && (
            <small>Latest registered checkout: {checkouts[0].label}</small>
          )}
          <label>
            Required before implementation (optional)
            <input
              value={requiredReason}
              maxLength={2000}
              onChange={(e) => setRequiredReason(e.target.value)}
            />
          </label>
          <button
            disabled={
              busy ||
              !brief.trim() ||
              !/^[a-f0-9]{40}$/.test(
                sourceCommit || checkouts[0]?.sourceCommit || '',
              )
            }
            onClick={() => void propose()}
          >
            Propose investigation
          </button>
        </details>
      )}
      {records.length === 0 && (
        <p>No investigations have been proposed for this document.</p>
      )}
      {records.map((record) => (
        <article className="inv-card" key={record.id}>
          <header>
            <strong>{record.brief}</strong>
            <span className={`inv-status inv-status-${record.status}`}>
              {record.status === 'proposed' ? 'Ready to run' : record.status}
            </span>
          </header>
          <small>
            Document revision {record.artifactVersion} · checkout{' '}
            {record.sourceCommit.slice(0, 12)} ·{' '}
            {record.mode === 'spike'
              ? 'Consented prototype'
              : 'Manual investigation'}
          </small>
          {record.requiredReason && (
            <p className="inv-required">
              Required before implementation: {record.requiredReason}
            </p>
          )}
          {record.error && <p role="status">{record.error}</p>}
          {canWrite && record.ownerId === currentUserId && (
            <div className="inv-actions">
              {record.status === 'proposed' && (
                <>
                  <button
                    disabled={busy}
                    onClick={() => void action(record.id, 'run')}
                  >
                    Run on my machine
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => void action(record.id, 'withdraw')}
                  >
                    Withdraw
                  </button>
                </>
              )}
              {['failed', 'cancelled', 'interrupted'].includes(
                record.status,
              ) && (
                <button
                  disabled={busy}
                  onClick={() => void action(record.id, 'retry')}
                >
                  Retry
                </button>
              )}
              {['queued', 'running'].includes(record.status) && (
                <button
                  disabled={busy}
                  onClick={() => void action(record.id, 'cancel')}
                >
                  Stop investigation
                </button>
              )}
            </div>
          )}
          {record.result && (
            <>
              <p>{record.result.method}</p>
              <p className="inv-limitation">
                Limitations: {record.result.limitations}
              </p>
              {record.childArtifactId && (
                <button
                  onClick={() => onOpenArtifact?.(record.childArtifactId!)}
                >
                  Open published report
                </button>
              )}
              {record.result.views.map((view) => (
                <InvestigationView
                  key={view.id}
                  investigation={record}
                  viewId={view.id}
                  canWrite={canWrite}
                  onRefresh={refresh}
                />
              ))}
            </>
          )}
        </article>
      ))}
    </div>
  );
}
