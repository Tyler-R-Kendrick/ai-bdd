import { useEffect, useState } from 'react';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { ArrowUpRight, Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import {
  Badge,
  Button,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  Textarea,
} from '../../components/ui.tsx';
import { api, date } from '../../lib.ts';
import {
  documentBlockSchemas,
  isDocumentBlockKind,
  type DocumentBlockKind,
  type QuestionnaireData,
} from '../../../shared/document-blocks.ts';
import type { Artifact, Run } from '../../../shared/domain.ts';
import { useDocumentWorkspace } from './Workspace.tsx';
import { inlineTestStatus } from '../test-status.ts';
const zeroId = '00000000-0000-4000-8000-000000000000';
const titles: Record<DocumentBlockKind, string> = {
  calloutBlock: 'Callout',
  columnsBlock: 'Columns',
  questionnaireBlock: 'Questionnaire',
  artifactReferenceBlock: 'Artifact reference',
  evidenceBlock: 'Evidence',
};
export function DocumentBlockView({
  node,
  updateAttributes,
  deleteNode,
}: NodeViewProps) {
  const context = useDocumentWorkspace(),
    kind = node.type.name as DocumentBlockKind,
    [editing, setEditing] = useState(false),
    [draft, setDraft] = useState<any>(null),
    [opening, setOpening] = useState(''),
    [error, setError] = useState('');
  if (!isDocumentBlockKind(kind)) return null;
  const checked = documentBlockSchemas[kind].safeParse(node.attrs.data);
  if (!checked.success)
    return (
      <NodeViewWrapper
        className="document-component document-component-invalid"
        contentEditable={false}
      >
        <strong>This component could not be read</strong>
        <p>Its data does not match the document schema.</p>
      </NodeViewWrapper>
    );
  const data = checked.data as any;
  const edit = () => {
    setDraft(structuredClone(data));
    setOpening(JSON.stringify(data));
    setError('');
    setEditing(true);
    if (kind === 'artifactReferenceBlock' || kind === 'evidenceBlock')
      void context.refreshArtifacts();
  };
  const save = () => {
    try {
      const parsed = documentBlockSchemas[kind].parse(draft);
      if (
        JSON.stringify(documentBlockSchemas[kind].parse(node.attrs.data)) !==
        opening
      )
        throw new Error(
          'A teammate changed this component. Your draft is retained. Copy it, close this dialog, and reopen the latest version before saving.',
        );
      updateAttributes({ data: parsed });
      setEditing(false);
    } catch (caught) {
      setError((caught as Error).message);
    }
  };
  return (
    <NodeViewWrapper
      className={`document-component document-component-${kind}${kind === 'calloutBlock' ? ' document-callout-' + data.tone : ''}`}
      contentEditable={false}
      data-component-kind={kind}
    >
      <div className="document-component-heading">
        <strong>{data.title}</strong>
        {!context.readOnly && (
          <div className="document-component-tools">
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Edit ${titles[kind].toLowerCase()}`}
              onClick={edit}
            >
              <Pencil size={13} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Delete ${titles[kind].toLowerCase()}`}
              onClick={deleteNode}
            >
              <Trash2 size={13} />
            </Button>
          </div>
        )}
      </div>
      {kind === 'calloutBlock' && (
        <p className="document-component-prose">{data.body}</p>
      )}
      {kind === 'columnsBlock' && (
        <div className="document-columns">
          {data.columns.map((column: any, index: number) => (
            <section key={index}>
              <h4>{column.title}</h4>
              <p className="document-component-prose">{column.body}</p>
            </section>
          ))}
        </div>
      )}
      {kind === 'questionnaireBlock' && (
        <Questionnaire anchor={String(node.attrs.id ?? '')} data={data} />
      )}
      {kind === 'artifactReferenceBlock' && <ArtifactReference data={data} />}
      {kind === 'evidenceBlock' && <Evidence data={data} />}
      <Modal
        open={editing}
        onOpenChange={setEditing}
        title={`Edit ${titles[kind].toLowerCase()}`}
        description={
          kind === 'questionnaireBlock'
            ? 'Questions retain stable identities. Changing a question preserves old answers and requires a new answer before accepting a decision.'
            : 'Changes are shared with the document’s collaborators.'
        }
      >
        {draft && (
          <div className="document-dialog-fields">
            <Field label="Title">
              <Input
                aria-label="Component title"
                value={draft.title}
                maxLength={180}
                onChange={(event) =>
                  setDraft({ ...draft, title: event.target.value })
                }
              />
            </Field>
            {kind === 'calloutBlock' && (
              <>
                <Field label="Type">
                  <Select
                    aria-label="Callout type"
                    value={draft.tone}
                    onChange={(event) =>
                      setDraft({ ...draft, tone: event.target.value })
                    }
                  >
                    {['note', 'tip', 'warning', 'important'].map((tone) => (
                      <option key={tone}>{tone}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="Note">
                  <Textarea
                    aria-label="Callout text"
                    value={draft.body}
                    maxLength={20000}
                    onChange={(event) =>
                      setDraft({ ...draft, body: event.target.value })
                    }
                  />
                </Field>
              </>
            )}
            {kind === 'columnsBlock' && (
              <>
                <div className="document-author-columns">
                  {draft.columns.map((column: any, index: number) => (
                    <section key={index}>
                      <Field label={`Column ${index + 1} heading`}>
                        <Input
                          value={column.title}
                          maxLength={180}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              columns: draft.columns.map((c: any, i: number) =>
                                i === index
                                  ? { ...c, title: event.target.value }
                                  : c,
                              ),
                            })
                          }
                        />
                      </Field>
                      <Field label={`Column ${index + 1} content`}>
                        <Textarea
                          value={column.body}
                          maxLength={20000}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              columns: draft.columns.map((c: any, i: number) =>
                                i === index
                                  ? { ...c, body: event.target.value }
                                  : c,
                              ),
                            })
                          }
                        />
                      </Field>
                      {draft.columns.length > 2 && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setDraft({
                              ...draft,
                              columns: draft.columns.filter(
                                (_: any, i: number) => i !== index,
                              ),
                            })
                          }
                        >
                          Remove column
                        </Button>
                      )}
                    </section>
                  ))}
                </div>
                {draft.columns.length < 4 && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        columns: [
                          ...draft.columns,
                          {
                            title: `Approach ${draft.columns.length + 1}`,
                            body: '',
                          },
                        ],
                      })
                    }
                  >
                    <Plus size={14} />
                    Add column
                  </Button>
                )}
              </>
            )}
            {kind === 'questionnaireBlock' && (
              <>
                <Field label="Context">
                  <Textarea
                    aria-label="Questionnaire context"
                    value={draft.description}
                    maxLength={20000}
                    onChange={(event) =>
                      setDraft({ ...draft, description: event.target.value })
                    }
                  />
                </Field>
                {draft.questions.map((question: any, index: number) => (
                  <section
                    className="document-question-author"
                    key={question.id}
                  >
                    <Field label={`Question ${index + 1}`}>
                      <Input
                        value={question.question}
                        maxLength={180}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            questions: draft.questions.map(
                              (q: any, i: number) =>
                                i === index
                                  ? { ...q, question: event.target.value }
                                  : q,
                            ),
                          })
                        }
                      />
                    </Field>
                    {question.options.map(
                      (option: any, optionIndex: number) => (
                        <div className="document-option-author" key={option.id}>
                          <Input
                            aria-label={`Question ${index + 1}, option ${optionIndex + 1}`}
                            value={option.label}
                            maxLength={180}
                            onChange={(event) =>
                              setDraft({
                                ...draft,
                                questions: draft.questions.map(
                                  (q: any, i: number) =>
                                    i === index
                                      ? {
                                          ...q,
                                          options: q.options.map(
                                            (o: any, j: number) =>
                                              j === optionIndex
                                                ? {
                                                    ...o,
                                                    label: event.target.value,
                                                  }
                                                : o,
                                          ),
                                        }
                                      : q,
                                ),
                              })
                            }
                          />
                          {question.options.length > 2 && (
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label={`Remove option ${optionIndex + 1}`}
                              onClick={() =>
                                setDraft({
                                  ...draft,
                                  questions: draft.questions.map(
                                    (q: any, i: number) =>
                                      i === index
                                        ? {
                                            ...q,
                                            options: q.options.filter(
                                              (_: any, j: number) =>
                                                j !== optionIndex,
                                            ),
                                          }
                                        : q,
                                  ),
                                })
                              }
                            >
                              <X size={14} />
                            </Button>
                          )}
                        </div>
                      ),
                    )}
                    <div className="document-suggestion-actions">
                      {question.options.length < 8 && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setDraft({
                              ...draft,
                              questions: draft.questions.map(
                                (q: any, i: number) =>
                                  i === index
                                    ? {
                                        ...q,
                                        options: [
                                          ...q.options,
                                          {
                                            id: crypto.randomUUID(),
                                            label: 'Another approach',
                                          },
                                        ],
                                      }
                                    : q,
                              ),
                            })
                          }
                        >
                          Add option
                        </Button>
                      )}
                      {draft.questions.length > 1 && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setDraft({
                              ...draft,
                              questions: draft.questions.filter(
                                (_: any, i: number) => i !== index,
                              ),
                            })
                          }
                        >
                          Remove question
                        </Button>
                      )}
                    </div>
                  </section>
                ))}
                {draft.questions.length < 20 && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        questions: [
                          ...draft.questions,
                          {
                            id: crypto.randomUUID(),
                            question: 'What should we decide?',
                            options: [
                              { id: 'a', label: 'Approach A' },
                              { id: 'b', label: 'Approach B' },
                            ],
                            allowText: true,
                          },
                        ],
                      })
                    }
                  >
                    <Plus size={14} />
                    Add question
                  </Button>
                )}
              </>
            )}
            {(kind === 'artifactReferenceBlock' ||
              kind === 'evidenceBlock') && (
              <Field label="Description">
                <Textarea
                  aria-label="Component description"
                  value={draft.description}
                  maxLength={20000}
                  onChange={(event) =>
                    setDraft({ ...draft, description: event.target.value })
                  }
                />
              </Field>
            )}
            {kind === 'artifactReferenceBlock' && (
              <Field label="Related artifact">
                <Select
                  aria-label="Related artifact"
                  value={draft.artifactId}
                  onChange={(event) =>
                    setDraft({ ...draft, artifactId: event.target.value })
                  }
                >
                  <option value={zeroId}>Not linked</option>
                  {context.artifacts.map((artifact) => (
                    <option key={artifact.id} value={artifact.id}>
                      {artifact.title}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {kind === 'evidenceBlock' && (
              <EvidencePicker draft={draft} setDraft={setDraft} />
            )}
            {error && (
              <p role="alert" className="document-error">
                {error}
              </p>
            )}
            <div className="document-dialog-actions">
              <Button variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button onClick={save}>Save component</Button>
            </div>
          </div>
        )}
      </Modal>
    </NodeViewWrapper>
  );
}
function ArtifactReference({ data }: { data: any }) {
  const { artifact, artifacts } = useDocumentWorkspace(),
    target = artifacts.find((item) => item.id === data.artifactId);
  return (
    <div>
      <p className="document-component-prose">{data.description}</p>
      {data.artifactId === zeroId ? (
        <Badge>Not linked</Badge>
      ) : target ? (
        <a
          className="document-source-link"
          href={`?project=${artifact.projectId}&artifact=${target.id}`}
        >
          <ArrowUpRight size={14} />
          {target.title}
        </a>
      ) : (
        <p className="document-empty">
          The linked artifact is archived or no longer available. Its stable
          reference is retained.
        </p>
      )}
    </div>
  );
}
function Questionnaire({
  anchor,
  data,
}: {
  anchor: string;
  data: QuestionnaireData;
}) {
  const {
      artifact,
      review,
      user,
      readOnly,
      onError,
      refresh,
      onDecisions,
      earlier,
    } = useDocumentWorkspace(),
    [choices, setChoices] = useState<Record<string, string>>({}),
    [answers, setAnswers] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState('');
  const submit = async (questionId: string) => {
    setBusy(questionId);
    try {
      const current = await api<{ artifact: Artifact }>(
        `/artifacts/${artifact.id}`,
      );
      await api(
        `/artifacts/${artifact.id}/document/questionnaires/${encodeURIComponent(anchor)}/answers`,
        'POST',
        {
          version: current.artifact.version,
          questionId,
          optionId: choices[questionId],
          answer: answers[questionId] ?? '',
        },
      );
      await refresh();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy('');
    }
  };
  const accept = async (id: string) => {
    setBusy(id);
    try {
      const current = await api<{ artifact: Artifact }>(
        `/artifacts/${artifact.id}`,
      );
      await api(
        `/artifacts/${artifact.id}/document/answers/${id}/accept-decision`,
        'POST',
        { version: current.artifact.version },
      );
      await refresh();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy('');
    }
  };
  return (
    <div className="document-questionnaire">
      <p className="document-component-prose">{data.description}</p>
      {data.questions.map((question) => {
        const responses = (review?.answers ?? []).filter(
            (answer) =>
              answer.anchor === anchor && answer.questionId === question.id,
          ),
          superseded = new Set(
            responses.map((answer) => answer.supersedesId).filter(Boolean),
          ),
          latest = responses.filter((answer) => !superseded.has(answer.id)),
          mine = latest.find((answer) => answer.authorId === user.id);
        return (
          <section className="document-question" key={question.id}>
            <h4>{question.question}</h4>
            {!readOnly && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit(question.id);
                }}
              >
                <fieldset disabled={!!busy || !anchor}>
                  <legend className="sr-only">{question.question}</legend>
                  {question.options.map((option) => (
                    <label className="document-answer-option" key={option.id}>
                      <input
                        type="radio"
                        name={`question-${anchor}-${question.id}`}
                        value={option.id}
                        checked={
                          (choices[question.id] ?? mine?.optionId ?? '') ===
                          option.id
                        }
                        onChange={() =>
                          setChoices({ ...choices, [question.id]: option.id })
                        }
                      />
                      <span>{option.label}</span>
                    </label>
                  ))}
                  {question.allowText && (
                    <Textarea
                      aria-label={`Reason for ${question.question}`}
                      placeholder="Add the reasoning behind your choice"
                      maxLength={4000}
                      value={answers[question.id] ?? ''}
                      onChange={(event) =>
                        setAnswers({
                          ...answers,
                          [question.id]: event.target.value,
                        })
                      }
                    />
                  )}
                  <Button
                    type="submit"
                    variant="outline"
                    size="sm"
                    disabled={!choices[question.id]}
                  >
                    {busy === question.id
                      ? 'Saving…'
                      : mine
                        ? 'Update your answer'
                        : 'Save your answer'}
                  </Button>
                </fieldset>
              </form>
            )}
            <div className="document-answers">
              {latest.map((answer) => (
                <article key={answer.id}>
                  <div>
                    <strong>{answer.author}</strong>
                    <span>{answer.option}</span>
                  </div>
                  {answer.answer && <p>{answer.answer}</p>}
                  <small>{date(answer.createdAt)}</small>
                  {answer.decisionId ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={onDecisions}
                      disabled={!onDecisions}
                    >
                      <Check size={13} />
                      Accepted ADR
                    </Button>
                  ) : (
                    !readOnly && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!!busy}
                        onClick={() => void accept(answer.id)}
                      >
                        Accept as decision
                      </Button>
                    )
                  )}
                </article>
              ))}
              {latest.length === 0 && (
                <p className="document-empty">No answers recorded yet.</p>
              )}
            </div>
          </section>
        );
      })}
      {review?.pagination.answers.hasMore && (
        <Button size="sm" variant="ghost" onClick={() => void earlier()}>
          Load earlier answers
        </Button>
      )}
      <p className="document-component-note">
        Answers retain their author and history. Accepting an answer creates a
        separate ADR; later prose edits cannot rewrite it.
      </p>
    </div>
  );
}
function EvidencePicker({
  draft,
  setDraft,
}: {
  draft: any;
  setDraft: (value: any) => void;
}) {
  const { artifact, artifacts, onError } = useDocumentWorkspace(),
    [sourceId, setSourceId] = useState(artifact.id),
    [runs, setRuns] = useState<Run[]>([]);
  useEffect(() => {
    let active = true;
    void api<{ runs: Run[] }>(`/artifacts/${sourceId}`)
      .then((bundle) => {
        if (active) setRuns(bundle.runs);
      })
      .catch((error) => onError(error.message));
    return () => {
      active = false;
    };
  }, [sourceId]);
  const run = runs.find((item) => item.id === draft.runId),
    scenarios: any[] = run?.result?.scenarios ?? [];
  return (
    <>
      <Field label="Evidence source artifact">
        <Select
          aria-label="Evidence source artifact"
          value={sourceId}
          onChange={(event) => {
            setSourceId(event.target.value);
            setDraft({ ...draft, runId: '', scenarioId: '' });
          }}
        >
          {artifacts.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Executed run">
        <Select
          aria-label="Executed evidence run"
          value={draft.runId}
          onChange={(event) =>
            setDraft({ ...draft, runId: event.target.value, scenarioId: '' })
          }
        >
          <option value="">Not linked</option>
          {draft.runId && !run && (
            <option value={draft.runId}>
              Existing run · choose its source artifact to change
            </option>
          )}
          {runs.map((item) => (
            <option key={item.id} value={item.id}>
              v{item.artifactVersion} · {item.status} · {date(item.createdAt)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Executed scenario">
        <Select
          aria-label="Executed evidence scenario"
          value={draft.scenarioId}
          disabled={!run}
          onChange={(event) =>
            setDraft({ ...draft, scenarioId: event.target.value })
          }
        >
          <option value="">Not linked</option>
          {draft.scenarioId &&
            !scenarios.some((item) => item.scenarioId === draft.scenarioId) && (
              <option value={draft.scenarioId}>Existing linked scenario</option>
            )}
          {scenarios.map((item) => (
            <option key={item.scenarioId} value={item.scenarioId}>
              {item.title} · {item.status}
            </option>
          ))}
        </Select>
      </Field>
    </>
  );
}
function Evidence({ data }: { data: any }) {
  const { artifact, artifacts, onError, onTests } = useDocumentWorkspace(),
    [source, setSource] = useState<{
      artifact: Pick<Artifact, 'id' | 'title' | 'version'>;
      run: Run;
    } | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    if (!data.runId) {
      setSource(null);
      setError('');
      return;
    }
    let stopped = false,
      timeout: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const result = await api<typeof source>(
          `/artifacts/${artifact.id}/document/evidence/${data.runId}`,
        );
        if (!stopped) {
          setSource(result);
          setError('');
          if (result && ['queued', 'running'].includes(result.run.status))
            timeout = setTimeout(load, 5000);
        }
      } catch (caught) {
        if (!stopped) setError((caught as Error).message);
      }
    };
    void load();
    return () => {
      stopped = true;
      if (timeout) clearTimeout(timeout);
    };
  }, [artifact.id, data.runId]);
  if (!data.runId)
    return (
      <>
        <p className="document-component-prose">{data.description}</p>
        <Badge>Not linked</Badge>
        <p className="document-component-note">
          Choose an actual run and scenario to show its evidence here.
        </p>
      </>
    );
  if (error)
    return <p className="document-error">Evidence is unavailable: {error}</p>;
  if (!source) return <Spinner label="Loading evidence…" />;
  const latest =
      artifacts.find((item) => item.id === source.artifact.id) ??
      source.artifact,
    status = inlineTestStatus(source.run, latest.version, data.scenarioId),
    passed = status.passed && source.run.status === 'passed',
    screenshots =
      (status.scenario as any)?.steps
        ?.flatMap((step: any) => step.evidence ?? [])
        .filter((ref: any) => ref.kind === 'screenshot')
        .slice(0, 2) ?? [];
  return (
    <>
      <p className="document-component-prose">{data.description}</p>
      <div className="document-evidence-meta">
        <Badge
          tone={
            passed
              ? 'green'
              : status.stale
                ? 'amber'
                : source.run.status === 'failed'
                  ? 'red'
                  : 'neutral'
          }
        >
          {passed
            ? 'Source scenario passed'
            : status.stale
              ? 'Evidence out of date'
              : source.run.status === 'error'
                ? 'Run error'
                : status.status}
        </Badge>
        <span>
          {source.artifact.title} · executed v{source.run.artifactVersion}
          {latest.version !== source.run.artifactVersion
            ? ` · current v${latest.version}`
            : ''}
        </span>
      </div>
      {screenshots.map((ref: any) => (
        <figure className="document-evidence-figure" key={ref.id ?? ref.path}>
          <img
            alt={`Captured evidence for ${status.scenario?.title ?? 'executed scenario'}`}
            src={`/api/artifacts/${source.artifact.id}/runs/${source.run.id}/evidence/${encodeURIComponent(ref.id ?? ref.path)}`}
            loading="lazy"
            onError={() =>
              onError(
                'A linked evidence file could not be loaded. Open the source run to inspect its integrity status.',
              )
            }
          />
          <figcaption>{ref.path}</figcaption>
        </figure>
      ))}
      {source.artifact.id === artifact.id ? (
        <Button variant="ghost" size="sm" onClick={onTests}>
          Inspect run and evidence
        </Button>
      ) : (
        <a
          className="document-source-link"
          href={`?project=${artifact.projectId}&artifact=${source.artifact.id}`}
        >
          <ArrowUpRight size={14} />
          Open source artifact
        </a>
      )}
      <p className="document-component-note">
        This card reports the source scenario at its executed artifact version.
        A linked child artifact does not verify this parent document.
      </p>
    </>
  );
}
export function ResearchView({ node }: NodeViewProps) {
  const { jobs, artifact, readOnly, onError } = useDocumentWorkspace(),
    job = jobs.find((item) => item.id === node.attrs.requestId),
    [busy, setBusy] = useState(false),
    active = job && ['queued', 'running'].includes(job.status),
    child = job?.status === 'completed' ? job.childArtifactId : null;
  const cancel = async () => {
    if (!job) return;
    setBusy(true);
    try {
      await api(
        `/artifacts/${artifact.id}/integrations/jobs/${job.id}/cancel`,
        'POST',
      );
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <NodeViewWrapper
      className="document-component document-research"
      contentEditable={false}
    >
      <div className="document-component-heading">
        <strong>{String(node.attrs.brief)}</strong>
        <Badge
          tone={
            job?.status === 'completed'
              ? 'green'
              : job?.status === 'failed'
                ? 'red'
                : 'neutral'
          }
        >
          {job
            ? job.status
            : node.attrs.requestId
              ? 'Loading request status…'
              : 'Imported research reference'}
        </Badge>
      </div>
      {active && (
        <Spinner
          label={
            job.status === 'queued'
              ? 'Research queued…'
              : 'Research in progress…'
          }
        />
      )}{' '}
      {job?.error && <p className="document-error">{job.error}</p>}
      {child && (
        <a
          className="document-source-link"
          href={`?project=${artifact.projectId}&artifact=${child}`}
        >
          <ArrowUpRight size={14} />
          Open published research document
        </a>
      )}
      {active && !readOnly && (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void cancel()}
        >
          {busy ? 'Cancelling…' : 'Cancel research'}
        </Button>
      )}
      {!job && !node.attrs.requestId && (
        <p className="document-component-note">
          Imported references do not establish that a research job ran.
        </p>
      )}
    </NodeViewWrapper>
  );
}
