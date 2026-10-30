import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  GitBranch,
  GitPullRequest,
  ListChecks,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import type { Artifact, Project } from '../../../shared/domain.ts';
import {
  dependencyReady,
  implementationDefinitionSchema,
  implementationPointer,
  type ImplementationDefinition,
  type ImplementationEvent,
  type ImplementationPointer,
  type ImplementationReport,
  type ImplementationRun,
  type ImplementationSnapshot,
  type ImplementationTaskProgress,
} from '../../../shared/implementation.ts';
import { api, date } from '../../lib.ts';
import {
  Badge,
  Button,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  Textarea,
} from '../ui.tsx';
import './implementation.css';

const label = (value: string) =>
  value.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());
const tone = (state: string) =>
  ['complete', 'delivered', 'implemented'].includes(state)
    ? ('green' as const)
    : state === 'blocked'
      ? ('red' as const)
      : ['running', 'in_progress', 'locked'].includes(state)
        ? ('amber' as const)
        : ('neutral' as const);
type Props = {
  artifact: Artifact;
  project: Project;
  readOnly?: boolean;
  onChanged?: () => void | Promise<void>;
  onError?: (message: string) => void;
};
type Reporter = (command: ImplementationReport['command']) => Promise<void>;
type DraftJob = {
  id: string;
  status: string;
  error?: string | null;
  createdAt: string;
};
type Readiness = {
  ready: boolean;
  blockers: { id: string; message: string; question?: string }[];
};

function GraphDiagram({
  definition,
  run,
}: {
  definition: ImplementationDefinition;
  run?: ImplementationRun | null;
}) {
  const depth = new Map<string, number>();
  const level = (id: string): number => {
    if (depth.has(id)) return depth.get(id)!;
    const result =
      Math.max(
        -1,
        ...definition.edges
          .filter((edge) => edge.to === id)
          .map((edge) => level(edge.from)),
      ) + 1;
    depth.set(id, result);
    return result;
  };
  definition.tasks.forEach((task) => level(task.id));
  const rows = new Map<number, number>();
  const positions = new Map(
    definition.tasks.map((task) => {
      const column = depth.get(task.id)!,
        row = rows.get(column) ?? 0;
      rows.set(column, row + 1);
      return [task.id, { x: column * 240 + 12, y: row * 86 + 12 }];
    }),
  );
  return (
    <figure className="implementation-graph">
      <div className="implementation-graph-scroll">
        <svg
          role="img"
          aria-label="Implementation task dependency graph"
          width={(Math.max(...depth.values()) + 1) * 240}
          height={Math.max(...rows.values()) * 86 + 4}
        >
          <defs>
            <marker
              id="implementation-arrow"
              markerWidth="7"
              markerHeight="7"
              refX="6"
              refY="3.5"
              orient="auto"
            >
              <path d="M0 0L7 3.5L0 7" fill="#89917e" />
            </marker>
          </defs>
          {definition.edges.map((edge) => {
            const a = positions.get(edge.from)!,
              b = positions.get(edge.to)!;
            return (
              <path
                key={edge.from + ':' + edge.to}
                d={`M${a.x + 208} ${a.y + 31} C${a.x + 226} ${a.y + 31},${b.x - 18} ${b.y + 31},${b.x - 3} ${b.y + 31}`}
                fill="none"
                stroke="#a7ad9f"
                markerEnd="url(#implementation-arrow)"
              />
            );
          })}
          {definition.tasks.map((task) => {
            const p = positions.get(task.id)!,
              state =
                run?.tasks.find((item) => item.taskId === task.id)?.status ??
                'planned';
            return (
              <g key={task.id} transform={`translate(${p.x},${p.y})`}>
                <rect
                  width="208"
                  height="62"
                  rx="7"
                  className={'implementation-node node-' + state}
                />
                <text x="12" y="24">
                  {task.title.length > 26
                    ? task.title.slice(0, 24) + '…'
                    : task.title}
                </text>
                <text x="12" y="45" className="implementation-node-state">
                  {label(state)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <figcaption>
        {definition.edges.length
          ? definition.edges
              .map(
                (edge) =>
                  `${definition.tasks.find((task) => task.id === edge.from)?.title} → ${definition.tasks.find((task) => task.id === edge.to)?.title}`,
              )
              .join(' · ')
          : 'Tasks have no dependencies.'}
      </figcaption>
    </figure>
  );
}

function DefinitionEditor({
  value,
  onChange,
  disabled,
}: {
  value: ImplementationDefinition;
  onChange: (value: ImplementationDefinition) => void;
  disabled: boolean;
}) {
  const [from, setFrom] = useState(''),
    [to, setTo] = useState('');
  const update = (
    index: number,
    patch: Partial<ImplementationDefinition['tasks'][number]>,
  ) =>
    onChange({
      ...value,
      tasks: value.tasks.map((task, i) =>
        i === index ? { ...task, ...patch } : task,
      ),
    });
  return (
    <section
      aria-label="Edit implementation tasks"
      className="implementation-editor"
    >
      {value.tasks.map((task, index) => (
        <fieldset
          key={index}
          disabled={disabled}
          className="implementation-edit-task"
        >
          <legend>Task {index + 1}</legend>
          <div className="implementation-two">
            <Field label={`Task ${index + 1} title`}>
              <Input
                value={task.title}
                maxLength={240}
                onChange={(event) =>
                  update(index, { title: event.target.value })
                }
              />
            </Field>
            <Field label={`Task ${index + 1} identifier`}>
              <Input
                value={task.id}
                maxLength={80}
                onChange={(event) => {
                  const id = event.target.value;
                  onChange({
                    ...value,
                    tasks: value.tasks.map((item, i) =>
                      i === index ? { ...item, id } : item,
                    ),
                    edges: value.edges.map((edge) => ({
                      from: edge.from === task.id ? id : edge.from,
                      to: edge.to === task.id ? id : edge.to,
                    })),
                  });
                }}
              />
            </Field>
          </div>
          <Field label={`Task ${index + 1} description`}>
            <Textarea
              value={task.description}
              aria-label={`Task ${index + 1} description`}
              maxLength={5000}
              onChange={(event) =>
                update(index, { description: event.target.value })
              }
            />
          </Field>
          <Field label={`Task ${index + 1} acceptance criteria (one per line)`}>
            <Textarea
              value={task.acceptanceCriteria.join('\n')}
              aria-label={`Task ${index + 1} acceptance criteria (one per line)`}
              onChange={(event) =>
                update(index, {
                  acceptanceCriteria: event.target.value.split('\n'),
                })
              }
            />
          </Field>
          <Button
            size="sm"
            variant="ghost"
            disabled={value.tasks.length === 1}
            onClick={() =>
              onChange({
                ...value,
                tasks: value.tasks.filter((_, i) => i !== index),
                edges: value.edges.filter(
                  (edge) => edge.from !== task.id && edge.to !== task.id,
                ),
              })
            }
          >
            <Trash2 />
            Remove task {index + 1}
          </Button>
        </fieldset>
      ))}
      <Button
        size="sm"
        variant="outline"
        disabled={disabled || value.tasks.length >= 100}
        onClick={() => {
          let id = 'task-' + (value.tasks.length + 1);
          while (value.tasks.some((task) => task.id === id)) id += '-new';
          onChange({
            ...value,
            tasks: [
              ...value.tasks,
              { id, title: '', description: '', acceptanceCriteria: [''] },
            ],
          });
        }}
      >
        <Plus />
        Add task
      </Button>
      <fieldset disabled={disabled} className="implementation-dependencies">
        <legend>Dependencies</legend>
        <p className="small muted">
          A prerequisite must complete before its dependent task starts.
        </p>
        <div className="implementation-two">
          <Field label="Prerequisite task">
            <Select
              value={from}
              aria-label="Prerequisite task"
              onChange={(event) => setFrom(event.target.value)}
            >
              <option value="">Choose prerequisite</option>
              {value.tasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title || task.id}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Dependent task">
            <Select
              aria-label="Dependent task"
              value={to}
              onChange={(event) => setTo(event.target.value)}
            >
              <option value="">Choose dependent</option>
              {value.tasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title || task.id}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={
            !from ||
            !to ||
            from === to ||
            value.edges.some((edge) => edge.from === from && edge.to === to)
          }
          onClick={() =>
            onChange({ ...value, edges: [...value.edges, { from, to }] })
          }
        >
          Add dependency
        </Button>
        {value.edges.map((edge, index) => (
          <div key={index} className="implementation-edge">
            <span>
              {value.tasks.find((task) => task.id === edge.from)?.title ||
                edge.from}{' '}
              →{' '}
              {value.tasks.find((task) => task.id === edge.to)?.title ||
                edge.to}
            </span>
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Remove dependency ${edge.from} to ${edge.to}`}
              onClick={() =>
                onChange({
                  ...value,
                  edges: value.edges.filter((_, i) => i !== index),
                })
              }
            >
              <Trash2 />
            </Button>
          </div>
        ))}
      </fieldset>
    </section>
  );
}

function TaskReporter({
  task,
  ready,
  report,
  busy,
}: {
  task: ImplementationTaskProgress;
  ready: boolean;
  report: Reporter;
  busy: boolean;
}) {
  const [action, setAction] = useState(
      task.status === 'complete' ? 'pr' : 'block',
    ),
    [summary, setSummary] = useState(''),
    [reason, setReason] = useState(''),
    [noChangeReason, setNoChangeReason] = useState(''),
    [evidence, setEvidence] = useState(''),
    [noChange, setNoChange] = useState(false),
    [url, setUrl] = useState(task.pullRequest?.url ?? ''),
    [state, setState] = useState<'open' | 'merged' | 'closed'>(
      task.pullRequest?.state ?? 'open',
    );
  return (
    <div className="implementation-report">
      {task.status !== 'complete' && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !ready || task.status === 'in_progress'}
          onClick={() =>
            void report({ kind: 'start_task', taskId: task.taskId })
          }
        >
          Start task
        </Button>
      )}
      <details>
        <summary>Report task progress</summary>
        <div className="implementation-report-fields">
          <Field label={`Report for ${task.taskId}`}>
            <Select
              value={action}
              aria-label={`Report for ${task.taskId}`}
              onChange={(event) => setAction(event.target.value)}
            >
              {task.status !== 'complete' && (
                <option value="block">Blocker</option>
              )}
              <option value="pr">Pull request</option>
              {task.status !== 'complete' && (
                <option value="complete">Completion</option>
              )}
            </Select>
          </Field>
          {action === 'block' && (
            <Field label="Blocker reason">
              <Textarea
                aria-label="Blocker reason"
                value={reason}
                maxLength={5000}
                onChange={(event) => setReason(event.target.value)}
              />
            </Field>
          )}
          {action === 'pr' && (
            <>
              <Field label="Pull request URL">
                <Input
                  type="url"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                />
              </Field>
              <Field label="Reported pull request state">
                <Select
                  value={state}
                  aria-label="Reported pull request state"
                  onChange={(event) =>
                    setState(event.target.value as typeof state)
                  }
                >
                  <option value="open">Open</option>
                  <option value="merged">Merged</option>
                  <option value="closed">Closed without merge</option>
                </Select>
              </Field>
            </>
          )}
          {action === 'complete' && (
            <>
              <Field label="Completion summary">
                <Textarea
                  aria-label="Completion summary"
                  value={summary}
                  maxLength={5000}
                  onChange={(event) => setSummary(event.target.value)}
                />
              </Field>
              {!task.pullRequest && (
                <label className="implementation-check">
                  <input
                    type="checkbox"
                    checked={noChange}
                    onChange={(event) => setNoChange(event.target.checked)}
                  />
                  No code change needed
                </label>
              )}
              {noChange && !task.pullRequest && (
                <>
                  <Field label="No-change reason">
                    <Textarea
                      aria-label="No-change reason"
                      value={noChangeReason}
                      maxLength={1000}
                      onChange={(event) =>
                        setNoChangeReason(event.target.value)
                      }
                    />
                  </Field>
                  <Field label="No-change evidence">
                    <Textarea
                      aria-label="No-change evidence"
                      value={evidence}
                      maxLength={5000}
                      onChange={(event) => setEvidence(event.target.value)}
                    />
                  </Field>
                </>
              )}
            </>
          )}
          <Button
            size="sm"
            disabled={
              busy ||
              (action === 'block' && !reason.trim()) ||
              (action === 'pr' && !url.trim()) ||
              (action === 'complete' &&
                (!summary.trim() ||
                  (!task.pullRequest &&
                    (!noChange || !noChangeReason.trim() || !evidence.trim()))))
            }
            onClick={() => {
              const command: ImplementationReport['command'] =
                action === 'block'
                  ? { kind: 'block_task', taskId: task.taskId, reason }
                  : action === 'pr'
                    ? {
                        kind: 'report_pr',
                        taskId: task.taskId,
                        pullRequest: { url, state },
                      }
                    : {
                        kind: 'complete_task',
                        taskId: task.taskId,
                        summary,
                        ...(noChange && !task.pullRequest
                          ? { noChange: { reason: noChangeReason, evidence } }
                          : {}),
                      };
              void report(command);
            }}
          >
            Save progress report
          </Button>
        </div>
      </details>
    </div>
  );
}

function IndependentReview({
  definition,
  report,
  busy,
}: {
  definition: ImplementationDefinition;
  report: Reporter;
  busy: boolean;
}) {
  const [summary, setSummary] = useState(''),
    [results, setResults] = useState<
      Record<string, { outcome: string; evidence: string }>
    >({});
  const fields = definition.tasks.flatMap((task) =>
    task.acceptanceCriteria.map((criterion, index) => ({
      key: task.id + ':' + index,
      task,
      index,
      criterion,
    })),
  );
  return (
    <details className="implementation-review">
      <summary>Independent whole-graph review</summary>
      <p className="small muted">
        An independent authenticated person or agent must review every
        criterion. The server rejects reviews by the claimant or task
        contributors.
      </p>
      <Field label="Whole-graph review summary">
        <Textarea
          value={summary}
          aria-label="Whole-graph review summary"
          maxLength={5000}
          onChange={(event) => setSummary(event.target.value)}
        />
      </Field>
      {fields.map(({ key, task, index, criterion }) => (
        <fieldset key={key}>
          <legend>
            {task.title} · criterion {index + 1}
          </legend>
          <p>{criterion}</p>
          <Field label={`Review outcome ${task.id} ${index + 1}`}>
            <Select
              value={results[key]?.outcome ?? ''}
              aria-label={`Review outcome ${task.id} ${index + 1}`}
              onChange={(event) =>
                setResults({
                  ...results,
                  [key]: {
                    ...results[key],
                    outcome: event.target.value,
                    evidence: results[key]?.evidence ?? '',
                  },
                })
              }
            >
              <option value="">Not reviewed</option>
              <option value="pass">Pass</option>
              <option value="fail">Fail</option>
            </Select>
          </Field>
          <Field label={`Review evidence ${task.id} ${index + 1}`}>
            <Textarea
              maxLength={5000}
              value={results[key]?.evidence ?? ''}
              aria-label={`Review evidence ${task.id} ${index + 1}`}
              onChange={(event) =>
                setResults({
                  ...results,
                  [key]: {
                    ...results[key],
                    outcome: results[key]?.outcome ?? '',
                    evidence: event.target.value,
                  },
                })
              }
            />
          </Field>
        </fieldset>
      ))}
      <Button
        size="sm"
        disabled={
          busy ||
          !summary.trim() ||
          fields.some(
            ({ key }) =>
              !results[key]?.outcome || !results[key]?.evidence.trim(),
          )
        }
        onClick={() =>
          void report({
            kind: 'report_verification',
            verification: {
              summary,
              tasks: definition.tasks.map((task) => ({
                taskId: task.id,
                criteria: task.acceptanceCriteria.map((_, index) => ({
                  index,
                  passed: results[task.id + ':' + index].outcome === 'pass',
                  evidence: results[task.id + ':' + index].evidence,
                })),
              })),
            },
          })
        }
      >
        Submit independent review
      </Button>
    </details>
  );
}

export function ImplementationPanel({
  artifact,
  project,
  readOnly = false,
  onChanged,
  onError,
}: Props) {
  const [open, setOpen] = useState(false),
    [snapshot, setSnapshot] = useState<ImplementationSnapshot | null>(null),
    [history, setHistory] = useState<ImplementationEvent[]>([]),
    [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [editing, setEditing] = useState(false),
    [definition, setDefinition] = useState<ImplementationDefinition>({
      tasks: [],
      edges: [],
    }),
    [basis, setBasis] = useState<ImplementationPointer | null>(null),
    [sourceRevision, setSourceRevision] = useState(artifact.version),
    [branch, setBranch] = useState(''),
    [commit, setCommit] = useState(''),
    [revisionReason, setRevisionReason] = useState(''),
    [draftJobs, setDraftJobs] = useState<DraftJob[]>([]);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const currentId = useRef(artifact.id);
  const draftRequestId = useRef<string | null>(null);
  const pendingReport = useRef<{
    runId: string;
    command: string;
    key: string;
  } | null>(null);
  currentId.current = artifact.id;
  const base = `/artifacts/${artifact.id}/implementation`;
  const fail = useCallback(
    (cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      onError?.(message);
    },
    [onError],
  );
  const load = useCallback(async () => {
    const id = artifact.id;
    const state = await api<ImplementationSnapshot>(base);
    if (currentId.current !== id) return;
    setSnapshot(state);
    if (open) {
      const events = await api<ImplementationEvent[]>(base + '/history');
      if (currentId.current === id) setHistory(events);
      const drafts = await api<{ jobs: DraftJob[] }>(base + '/draft');
      const ready = await api<Readiness>(base + '/readiness');
      if (currentId.current === id) {
        setDraftJobs(drafts.jobs);
        setReadiness(ready);
        if (
          drafts.jobs[0] &&
          !['queued', 'running', 'retrying'].includes(drafts.jobs[0].status)
        )
          draftRequestId.current = null;
      }
    }
  }, [base, artifact.id, open]);
  useEffect(() => {
    setSnapshot(null);
    setEditing(false);
    setError('');
    setDraftJobs([]);
    setReadiness(null);
    draftRequestId.current = null;
    pendingReport.current = null;
    void load().catch(fail);
  }, [artifact.id]);
  useEffect(() => {
    if (open) void load().catch(fail);
  }, [open, load, fail, artifact.version]);
  useEffect(() => {
    if (!open) return;
    const refresh = () => void load().catch(fail);
    window.addEventListener('implementation-changed', refresh);
    const timer = setInterval(refresh, 4000);
    return () => {
      clearInterval(timer);
      window.removeEventListener('implementation-changed', refresh);
    };
  }, [open, load, fail]);
  const action = async (name: string, work: () => Promise<unknown>) => {
    setBusy(name);
    setError('');
    try {
      await work();
      await load();
      await onChanged?.();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy('');
    }
  };
  const graph = snapshot?.graph,
    run = snapshot?.activeRun ?? snapshot?.runs[0],
    locked = !!snapshot?.editingLock,
    disabled = readOnly || !!busy,
    draftPending = draftJobs.some((job) =>
      ['queued', 'running', 'retrying'].includes(job.status),
    );
  const startEditing = () => {
    setDefinition(
      graph
        ? structuredClone(graph.definition)
        : {
            tasks: [
              {
                id: 'task-1',
                title: '',
                description: '',
                acceptanceCriteria: [''],
              },
            ],
            edges: [],
          },
    );
    setBasis(graph ? implementationPointer(graph) : null);
    setSourceRevision(snapshot?.planRevision ?? artifact.version);
    setEditing(true);
  };
  const report: Reporter = (command) => {
    const fingerprint = JSON.stringify(command);
    if (
      !pendingReport.current ||
      pendingReport.current.runId !== run!.id ||
      pendingReport.current.command !== fingerprint
    )
      pendingReport.current = {
        runId: run!.id,
        command: fingerprint,
        key: crypto.randomUUID(),
      };
    const request = pendingReport.current;
    return action('Recording progress…', async () => {
      await api(base + '/report', 'POST', {
        runId: request.runId,
        idempotencyKey: request.key,
        command,
      });
      pendingReport.current = null;
    });
  };
  const completed =
    run?.tasks.filter((task) => task.status === 'complete').length ?? 0;
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
        aria-label="Build plan"
      >
        <ListChecks />
        {run &&
        run.planRevision !== (snapshot?.planRevision ?? artifact.version) &&
        ['implemented', 'delivered'].includes(run.status)
          ? 'Changes to build'
          : snapshot?.activeRun
            ? `Building ${completed} of ${run?.tasks.length}`
            : run?.status === 'delivered'
              ? 'Built'
              : run?.status === 'implemented'
                ? 'Verified implementation'
                : 'Build plan'}
      </Button>
      <Modal
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
        title="Build plan"
        description="Turn this document into a reviewed dependency graph, then track implementation and evidence."
      >
        <section
          className="implementation-panel"
          aria-label="Implementation plan"
        >
          <div className="implementation-topline">
            <span>
              {project.title} · source revision{' '}
              {snapshot?.planRevision ?? artifact.version}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={!!busy}
              onClick={() => void action('Refreshing…', load)}
            >
              <RefreshCw />
              Refresh build
            </Button>
          </div>
          {error && (
            <div className="implementation-error" role="alert">
              {error}
              {editing && (
                <p>
                  Your task edits are retained. Refresh and compare the current
                  graph before retrying a conflict.
                </p>
              )}
            </div>
          )}
          {busy && <Spinner label={busy} />}
          {!snapshot && !error && (
            <Spinner label="Loading implementation graph…" />
          )}
          {snapshot && (
            <>
              {readiness && !readiness.ready && (
                <section
                  className="implementation-error"
                  aria-label="Build prerequisites"
                >
                  <strong>
                    Resolve these items before approval or execution
                  </strong>
                  <ul>
                    {readiness.blockers.map((blocker) => (
                      <li key={blocker.id + (blocker.question ?? '')}>
                        {blocker.message}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {locked && (
                <p className="implementation-lock" role="status">
                  <GitBranch />
                  Source editing is locked by{' '}
                  {snapshot.editingLock!.claimedBy.name} while run{' '}
                  {snapshot.editingLock!.runId.slice(0, 8)} is active.
                </p>
              )}
              {graph && (
                <div className="implementation-version">
                  <h3>Graph version {graph.graphVersion}</h3>
                  <Badge tone={tone(graph.status)}>{label(graph.status)}</Badge>
                  <span className="small muted">
                    Draft {graph.draftRevision} · plan {graph.planRevision}
                  </span>
                  {graph.planRevision !== snapshot.planRevision && (
                    <Badge tone="amber">Source changed · revise graph</Badge>
                  )}
                </div>
              )}
              {!graph && !editing && (
                <div className="implementation-empty">
                  <ListChecks size={30} />
                  <h3>Plan the work before it starts</h3>
                  <p>
                    Define small tasks, acceptance criteria and prerequisites. A
                    person approves the exact graph and source version before
                    execution.
                  </p>
                </div>
              )}
              {!readOnly && !locked && !editing && (
                <div className="implementation-actions">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={disabled}
                    onClick={startEditing}
                  >
                    <Plus />
                    {graph ? 'Revise tasks' : 'Create task graph'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      disabled || draftPending || readiness?.ready === false
                    }
                    onClick={() =>
                      void action('Requesting task draft…', async () => {
                        draftRequestId.current ??= crypto.randomUUID();
                        await api(base + '/draft', 'POST', {
                          requestId: draftRequestId.current,
                        });
                      })
                    }
                  >
                    {draftPending
                      ? 'Planner is drafting tasks…'
                      : 'Draft tasks with Planner'}
                  </Button>
                </div>
              )}
              {draftPending && (
                <p role="status" className="small muted">
                  The Planner request is durable. Refresh to inspect the
                  published graph; approval remains a separate action.
                </p>
              )}
              {draftJobs[0] && (
                <p className="small muted" role="status">
                  Planner draft: {label(draftJobs[0].status)}
                  {draftJobs[0].error ? ' · ' + draftJobs[0].error : ''}
                </p>
              )}
              {editing && (
                <>
                  <DefinitionEditor
                    value={definition}
                    onChange={setDefinition}
                    disabled={disabled}
                  />
                  <div className="implementation-actions">
                    <Button
                      size="sm"
                      disabled={disabled}
                      onClick={() =>
                        void action('Saving graph draft…', async () => {
                          const parsed =
                            implementationDefinitionSchema.safeParse(
                              definition,
                            );
                          if (!parsed.success)
                            throw new Error(
                              parsed.error.issues
                                .map((issue) => issue.message)
                                .join('; '),
                            );
                          await api(base + '/graph', 'PUT', {
                            expected: basis,
                            planRevision: sourceRevision,
                            definition: parsed.data,
                          });
                          setEditing(false);
                        })
                      }
                    >
                      Save graph draft
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!!busy}
                      onClick={() => setEditing(false)}
                    >
                      Discard task edits
                    </Button>
                  </div>
                </>
              )}
              {graph && !editing && (
                <>
                  <GraphDiagram
                    definition={graph.definition}
                    run={run?.graphVersion === graph.graphVersion ? run : null}
                  />
                  <div className="implementation-tasks">
                    {graph.definition.tasks.map((task, index) => {
                      const progress =
                        run?.graphVersion === graph.graphVersion
                          ? run.tasks.find((item) => item.taskId === task.id)
                          : undefined;
                      return (
                        <article
                          key={task.id}
                          className="implementation-task"
                          aria-label={`Task ${task.title}`}
                        >
                          <div className="implementation-task-heading">
                            <h4>
                              {index + 1}. {task.title}
                            </h4>
                            <Badge tone={tone(progress?.status ?? 'planned')}>
                              {label(progress?.status ?? 'planned')}
                            </Badge>
                          </div>
                          <p>{task.description}</p>
                          <ol>
                            {task.acceptanceCriteria.map((criterion, i) => (
                              <li key={i}>{criterion}</li>
                            ))}
                          </ol>
                          {progress?.blocker && (
                            <p className="implementation-blocker">
                              Blocked: {progress.blocker}
                            </p>
                          )}
                          {progress?.summary && <p>{progress.summary}</p>}
                          {progress?.noChange && (
                            <div className="implementation-evidence">
                              <strong>No change needed</strong>
                              <p>{progress.noChange.reason}</p>
                              <p>{progress.noChange.evidence}</p>
                            </div>
                          )}
                          {progress?.pullRequest && (
                            <a
                              className="implementation-pr"
                              href={progress.pullRequest.url}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <GitPullRequest />
                              {progress.pullRequest.title ??
                                'Pull request'} ·{' '}
                              {label(progress.pullRequest.state)}
                            </a>
                          )}
                          {progress &&
                            !readOnly &&
                            run &&
                            ((run.status === 'running' &&
                              (progress.status !== 'complete' ||
                                !!progress.pullRequest)) ||
                              (['implemented', 'delivered'].includes(
                                run.status,
                              ) &&
                                !!progress.pullRequest)) && (
                              <TaskReporter
                                task={progress}
                                ready={dependencyReady(
                                  graph.definition,
                                  run.tasks,
                                  task.id,
                                )}
                                report={report}
                                busy={!!busy}
                              />
                            )}
                        </article>
                      );
                    })}
                  </div>
                  {!readOnly && !locked && graph.status === 'draft' && (
                    <div className="implementation-approval">
                      <p>
                        Approval covers graph {graph.graphVersion}, draft{' '}
                        {graph.draftRevision}, and source revision{' '}
                        {graph.planRevision}. Review the tasks and criteria
                        above.
                      </p>
                      <Button
                        size="sm"
                        disabled={
                          disabled ||
                          readiness?.ready === false ||
                          graph.planRevision !== snapshot.planRevision
                        }
                        onClick={() =>
                          void action('Approving exact graph…', () =>
                            api(
                              base + '/approve',
                              'POST',
                              implementationPointer(graph),
                            ),
                          )
                        }
                      >
                        <Check />
                        Approve graph {graph.graphVersion} · draft{' '}
                        {graph.draftRevision}
                      </Button>
                    </div>
                  )}
                  {!readOnly &&
                    !locked &&
                    graph.status === 'approved' &&
                    !snapshot.runs.some(
                      (item) =>
                        item.graphVersion === graph.graphVersion &&
                        ['implemented', 'delivered'].includes(item.status),
                    ) && (
                      <section className="implementation-launch">
                        <h4>Implement the approved graph</h4>
                        <p className="small muted">
                          The connected machine uses your registered checkout.
                          Repository push access and the exact graph are checked
                          again when work starts.
                        </p>
                        <Button
                          size="sm"
                          disabled={
                            disabled ||
                            !project.repository ||
                            readiness?.ready === false
                          }
                          onClick={() =>
                            void action('Queuing implementation…', () =>
                              api(base + '/queue', 'POST', {
                                expected: implementationPointer(graph),
                              }),
                            )
                          }
                        >
                          Build on my connected machine
                        </Button>
                        {!project.repository && (
                          <p className="small muted">
                            Set the project repository before starting
                            implementation.
                          </p>
                        )}
                        <details>
                          <summary>Claim an external checkout</summary>
                          <div className="implementation-report-fields">
                            <Field label="Checkout branch">
                              <Input
                                value={branch}
                                onChange={(event) =>
                                  setBranch(event.target.value)
                                }
                              />
                            </Field>
                            <Field label="Checkout commit">
                              <Input
                                value={commit}
                                placeholder="Full commit SHA"
                                onChange={(event) =>
                                  setCommit(event.target.value)
                                }
                              />
                            </Field>
                            <p className="small muted">
                              These values record the caller's checkout
                              declaration. They do not inspect a remote
                              checkout.
                            </p>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={
                                disabled ||
                                readiness?.ready === false ||
                                !branch ||
                                !commit ||
                                !project.repository
                              }
                              onClick={() =>
                                void action('Claiming approved graph…', () =>
                                  api(base + '/claim', 'POST', {
                                    expected: implementationPointer(graph),
                                    repository: project.repository,
                                    branch,
                                    commit,
                                  }),
                                )
                              }
                            >
                              Claim exact graph
                            </Button>
                          </div>
                        </details>
                      </section>
                    )}
                  {run?.graphVersion === graph.graphVersion && (
                    <section className="implementation-run">
                      <h4>
                        Implementation run{' '}
                        <Badge tone={tone(run.status)}>
                          {label(run.status)}
                        </Badge>
                      </h4>
                      <p className="small muted">
                        {run.claimedBy.name} · {run.checkout.branch} ·{' '}
                        {run.checkout.commit.slice(0, 12)}
                      </p>
                      {run.verification && (
                        <div className="implementation-evidence">
                          <strong>
                            {run.verification.passed
                              ? 'Independent review passed'
                              : 'Independent review returned work'}
                          </strong>
                          <p>{run.verification.summary}</p>
                          <p className="small muted">
                            {run.verification.reviewedBy.name} ·{' '}
                            {date(run.verification.reviewedAt)}
                          </p>
                        </div>
                      )}
                      {run.revisionReason && (
                        <p>Revision requested: {run.revisionReason}</p>
                      )}
                      {run.status === 'running' && !readOnly && (
                        <>
                          {run.tasks.every(
                            (task) => task.status === 'complete',
                          ) && (
                            <IndependentReview
                              definition={graph.definition}
                              report={report}
                              busy={!!busy}
                            />
                          )}
                          <details>
                            <summary>
                              Request a plan revision and release the lock
                            </summary>
                            <div className="implementation-report-fields">
                              <Field label="Revision request reason">
                                <Textarea
                                  value={revisionReason}
                                  aria-label="Revision request reason"
                                  maxLength={5000}
                                  onChange={(event) =>
                                    setRevisionReason(event.target.value)
                                  }
                                />
                              </Field>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={disabled || !revisionReason.trim()}
                                onClick={() =>
                                  void report({
                                    kind: 'request_revision',
                                    reason: revisionReason,
                                  })
                                }
                              >
                                Request revision
                              </Button>
                            </div>
                          </details>
                        </>
                      )}
                    </section>
                  )}
                </>
              )}
              <details className="implementation-history">
                <summary>
                  Build history · {history.length} recent events
                </summary>
                {history.length === 0 ? (
                  <p className="small muted">
                    No implementation transitions recorded.
                  </p>
                ) : (
                  <ol>
                    {history.map((event) => (
                      <li key={event.revision}>
                        <div>
                          <strong>{label(event.kind)}</strong>
                          <span>
                            {event.actor.name} · {date(event.at)}
                          </span>
                        </div>
                        {typeof event.detail.reason === 'string' && (
                          <p>{event.detail.reason}</p>
                        )}
                        {typeof event.detail.summary === 'string' && (
                          <p>{event.detail.summary}</p>
                        )}
                        {typeof event.detail.taskId === 'string' && (
                          <p>Task: {event.detail.taskId}</p>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
              </details>
            </>
          )}
        </section>
      </Modal>
    </>
  );
}
export default ImplementationPanel;
