import { useCallback, useEffect, useRef, useState, useId } from 'react';
import {
  displayRemoteStages,
  type RemoteActivity as Activity,
  type RemoteQuestion,
  type RemoteQuestionAnswer,
} from '../../../shared/remote-agent.ts';
import { api, ApiError } from '../../lib.ts';
import { Badge, Button, Input, Textarea } from '../ui.tsx';
import { MessageMarkdown } from '../panels/MessageMarkdown.tsx';
import './remote-activity.css';

type Props = {
  artifactId: string;
  artifactVersion: number;
  threadId: string;
  readOnly: boolean;
  active?: boolean;
  onError: (message: string) => void;
};
const tone = (status: string) =>
  ['completed', 'finished', 'answered', 'accepted'].includes(status)
    ? ('green' as const)
    : ['failed', 'stale', 'blocked'].includes(status)
      ? ('red' as const)
      : [
            'waiting',
            'awaiting_input',
            'paused',
            'pending',
            'running',
            'queued',
          ].includes(status)
        ? ('amber' as const)
        : ('neutral' as const);
const json = (value: unknown) => JSON.stringify(value, null, 2) ?? '';
const displayRunStatus = (card: { status: string; ended?: number }) =>
  card.status === 'finished' && card.ended === undefined
    ? 'running'
    : card.status;

export function RemoteActivity({
  artifactId,
  artifactVersion,
  threadId,
  readOnly,
  active,
  onError,
}: Props) {
  const [requests, setRequests] = useState<Activity[]>([]),
    [error, setError] = useState(''),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    setRequests([]);
    setError('');
  }, [artifactId, threadId]);
  useEffect(() => {
    let stopped = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      let delay = 10000;
      try {
        const result = await api<{ requests: Activity[] }>(
          `/artifacts/${artifactId}/planner/activity?threadId=${encodeURIComponent(threadId)}`,
        );
        if (stopped) return;
        setRequests(result.requests);
        setError('');
        if (
          active ||
          result.requests.some(
            (request) =>
              request.canAnswer ||
              request.canControl ||
              ['running', 'queued'].includes(request.jobStatus),
          )
        )
          delay = 2000;
      } catch (e) {
        if (stopped) return;
        if (e instanceof ApiError && e.status === 404) {
          setRequests([]);
          return;
        }
        if (e instanceof ApiError && [401, 403].includes(e.status))
          setRequests([]);
        setError((e as Error).message);
      }
      if (!stopped) timer = setTimeout(() => void load(), delay);
    };
    void load();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [artifactId, artifactVersion, threadId, active, refresh]);
  const reload = useCallback(() => setRefresh((value) => value + 1), []);
  if (!requests.length && !error) return null;
  return (
    <section className="remote-activity" aria-label="Remote agent activity">
      <header>
        <h3>Agent activity</h3>
        <Button size="sm" variant="ghost" onClick={reload}>
          Refresh activity
        </Button>
      </header>
      {error && <p role="alert">{error}</p>}
      {requests.map((request, index) => (
        <ActivityCard
          key={request.id}
          request={request}
          artifactId={artifactId}
          artifactVersion={artifactVersion}
          readOnly={readOnly}
          first={index === 0}
          reload={reload}
          onError={onError}
        />
      ))}
    </section>
  );
}
function ActivityCard({
  request,
  artifactId,
  artifactVersion,
  readOnly,
  first,
  reload,
  onError,
}: {
  request: Activity;
  artifactId: string;
  artifactVersion: number;
  readOnly: boolean;
  first: boolean;
  reload: () => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [full, setFull] = useState<Activity | null>(null),
    [questionLimit, setQuestionLimit] = useState(8);
  // Full expansion is replaced by later server reports rather than masking new progress.
  useEffect(() => setFull(null), [request.cursor]);
  const view = full ?? request,
    stale =
      request.artifactVersion !== artifactVersion ||
      request.status === 'stale';
  const pending = request.controls.some(
    (control) => control.status === 'pending',
  );
  const controls = !readOnly && request.canControl;
  const questions = [
    ...view.questions.filter((q) => q.status === 'open'),
    ...view.questions.filter((q) => q.status !== 'open'),
  ];
  const action = async (
    kind: 'pause' | 'resume' | 'stop',
    runId?: string,
  ) => {
    if (busy || !controls) return;
    setBusy(true);
    setError('');
    try {
      await api(
        `/artifacts/${artifactId}/planner/requests/${request.id}/control`,
        'POST',
        {
          idempotencyKey: crypto.randomUUID(),
          action: kind,
          ...(runId ? { runId } : {}),
        },
      );
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const expand = async () => {
    setBusy(true);
    setError('');
    try {
      setFull(
        await api<Activity>(
          `/artifacts/${artifactId}/planner/requests/${request.id}`,
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details
      className="remote-turn"
      open={first || request.canAnswer || request.canControl}
    >
      <summary>
        <strong>Agent turn</strong>
        <Badge tone={tone(stale ? 'stale' : request.status)}>
          {stale ? 'Source changed' : request.status}
        </Badge>
        <span>Source v{request.artifactVersion}</span>
      </summary>
      {error && <p role="alert">{error}</p>}
      {stale && (
        <p className="remote-note">
          This turn belongs to an earlier source. Start a new turn to answer
          questions about the current document.
        </p>
      )}
      {view.stream.blocks.map((block) =>
        block.kind === 'text' ? (
          <div key={block.id} className="remote-stream-text">
            <MessageMarkdown text={block.text} onError={onError} />
            {!block.ended && <span role="status">Writing…</span>}
          </div>
        ) : (
          <details key={block.id} className="remote-stream-details">
            <summary>
              {block.kind === 'reasoning'
                ? 'Agent reasoning'
                : `Tool input · ${block.name ?? 'tool'}`}
              {!block.ended ? ' · streaming' : ''}
            </summary>
            {block.kind === 'reasoning' ? (
              <MessageMarkdown text={block.text} onError={onError} />
            ) : (
              <pre>{block.text}</pre>
            )}
          </details>
        ),
      )}
      {!!view.stream.calls.length && (
        <div className="remote-tool-calls" aria-label="Agent tool activity">
          {view.stream.calls.map((call) => (
            <details key={call.id}>
              <summary>
                <span>{call.name}</span>
                <Badge tone={tone(call.status)}>{call.status}</Badge>
              </summary>
              <p className="remote-note">
                {call.source === 'server'
                  ? 'Repository tool executed by Studio.'
                  : 'Tool execution reported by the connected agent.'}
              </p>
              <pre>{json(call.input)}</pre>
              {call.result !== undefined && <pre>{json(call.result)}</pre>}
              {call.preliminary && <p>Result in progress</p>}
            </details>
          ))}
        </div>
      )}
      {view.stream.error && <p role="alert">{view.stream.error}</p>}
      {!!view.runs.cards.length && (
        <div className="remote-runs" aria-label="Agent-reported runs">
          <p className="remote-note">
            Progress reported by the connected agent.
          </p>
          {view.runs.cards.map((card) => (
            <section
              key={card.id}
              className="remote-run"
              aria-label={card.name || 'Agent run'}
            >
              <header>
                <strong>{card.name || 'Agent run'}</strong>
                <Badge tone={tone(displayRunStatus(card))}>
                  {displayRunStatus(card)}
                </Badge>
              </header>
              <ol>
                {displayRemoteStages(card).map((stage) => (
                  <li key={stage.id}>
                    <span>{stage.name || 'Stage'}</span>
                    <Badge tone={tone(stage.status)}>
                      {stage.status.replaceAll('_', ' ')}
                    </Badge>
                    {stage.parentIds?.length ? (
                      <small>
                        Depends on {stage.parentIds.length} earlier stage
                        {stage.parentIds.length === 1 ? '' : 's'}
                      </small>
                    ) : null}
                  </li>
                ))}
              </ol>
              {!!card.earlierStages && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void expand()}
                >
                  Show earlier stages ({card.earlierStages})
                </Button>
              )}
              {controls &&
                ['running', 'waiting', 'paused'].includes(
                  displayRunStatus(card),
                ) && (
                  <div className="remote-actions">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        busy || pending || (stale && card.status === 'paused')
                      }
                      onClick={() =>
                        void action(
                          card.status === 'paused' ? 'resume' : 'pause',
                          card.id,
                        )
                      }
                    >
                      {card.status === 'paused' ? 'Resume run' : 'Pause run'}
                    </Button>
                  </div>
                )}
            </section>
          ))}
        </div>
      )}
      {questions.slice(0, questionLimit).map((question) => (
        <QuestionCard
          key={question.id}
          question={question}
          artifactId={artifactId}
          requestId={request.id}
          enabled={!readOnly && !stale && request.canAnswer}
          reload={reload}
          onError={onError}
        />
      ))}
      {questions.length > questionLimit && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setQuestionLimit((n) => n + 8)}
        >
          Show more questions ({questions.length - questionLimit})
        </Button>
      )}
      {!!request.controls.length && (
        <ul
          className="remote-control-receipts"
          aria-label="Agent control acknowledgements"
        >
          {request.controls.map((control) => (
            <li key={control.id}>
              <span>
                {control.action === 'pause' ? 'Pause' : 'Resume'}{' '}
                {control.status === 'pending' ? 'requested' : control.status}
              </span>
              {control.message && <span>{control.message}</span>}
            </li>
          ))}
        </ul>
      )}
      {controls && (
        <div className="remote-actions">
          <Button
            size="sm"
            variant="outline"
            disabled={
              busy || pending || (stale && request.runs.paused.length > 0)
            }
            onClick={() =>
              void action(request.runs.paused.length ? 'resume' : 'pause')
            }
          >
            {request.runs.paused.length ? 'Resume turn' : 'Pause turn'}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={() => void action('stop')}
          >
            Stop turn
          </Button>
        </div>
      )}
      {pending && (
        <p role="status" className="remote-note">
          Waiting for the connected agent to acknowledge the control.
        </p>
      )}
    </details>
  );
}
function QuestionCard({
  question,
  artifactId,
  requestId,
  enabled,
  reload,
  onError,
}: {
  question: RemoteQuestion;
  artifactId: string;
  requestId: string;
  enabled: boolean;
  reload: () => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [pendingRevision, setPendingRevision] = useState<number | null>(null);
  const awaitingRefresh =
    pendingRevision !== null && question.revision < pendingRevision;
  const replay = useRef<{ body: string; key: string } | null>(null);
  const send = async (body: {
    action: 'answer' | 'cancel';
    expectedRevision: number;
    value?: unknown;
    customValue?: string;
    answers?: RemoteQuestionAnswer[];
  }) => {
    if (busy || !enabled || awaitingRefresh || question.status !== 'open')
      return undefined;
    const serialized = json(body);
    if (replay.current?.body !== serialized)
      replay.current = { body: serialized, key: crypto.randomUUID() };
    setBusy(true);
    setError('');
    try {
      const result = await api<{
        value: { revision: number; status: string };
      }>(
        `/artifacts/${artifactId}/planner/requests/${requestId}/questions/${encodeURIComponent(question.id)}`,
        'POST',
        { ...body, idempotencyKey: replay.current.key },
      );
      setPendingRevision(result.value.revision);
      reload();
      return result.value;
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  const input = question.input,
    writable = enabled && !awaitingRefresh && question.status === 'open';
  return (
    <section
      className="remote-question"
      aria-label={
        input.method === 'questionnaire'
          ? 'Questions from your agent'
          : input.title
      }
    >
      <header>
        <strong>
          {input.method === 'questionnaire'
            ? 'Questions from your agent'
            : input.title}
        </strong>
        <Badge tone={tone(question.status)}>{question.status}</Badge>
      </header>
      {input.method === 'confirm' && (
        <MessageMarkdown text={input.message} onError={onError} />
      )}
      {input.method === 'questionnaire' ? (
        input.params.questions.map((prompt, index) => (
          <QuestionItem
            key={index}
            question={question}
            index={index}
            writable={writable}
            busy={busy}
            send={send}
          />
        ))
      ) : (
        <SingleInput
          question={question}
          writable={writable}
          busy={busy}
          send={send}
        />
      )}
      {error && <p role="alert">{error}</p>}
      {awaitingRefresh && (
        <p role="status">Response saved · refreshing question</p>
      )}
      {writable && (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void send({
              action: 'cancel',
              expectedRevision: question.revision,
            })
          }
        >
          Cancel question
        </Button>
      )}
      {!enabled && question.status === 'open' && (
        <p className="remote-note">
          Read only · a current project writer can respond.
        </p>
      )}
    </section>
  );
}
type Sender = (body: {
  action: 'answer' | 'cancel';
  expectedRevision: number;
  value?: unknown;
  customValue?: string;
  answers?: RemoteQuestionAnswer[];
}) => Promise<{ revision: number; status: string } | undefined>;
function QuestionItem({
  question,
  index,
  writable,
  busy,
  send,
}: {
  question: RemoteQuestion;
  index: number;
  writable: boolean;
  busy: boolean;
  send: Sender;
}) {
  if (question.input.method !== 'questionnaire') return null;
  return (
    <QuestionItemForm
      question={{ ...question, input: question.input }}
      index={index}
      writable={writable}
      busy={busy}
      send={send}
    />
  );
}
function QuestionItemForm({
  question,
  index,
  writable,
  busy,
  send,
}: {
  question: RemoteQuestion & {
    input: Extract<RemoteQuestion['input'], { method: 'questionnaire' }>;
  };
  index: number;
  writable: boolean;
  busy: boolean;
  send: Sender;
}) {
  const groupName = useId();
  const prompt = question.input.params.questions[index],
    saved = question.answers.find((answer) => answer.questionIndex === index);
  const initial = () => ({
    kind: saved?.kind === 'chat' ? 'custom' : (saved?.kind ?? 'option'),
    answer: saved?.answer ?? '',
    selected: saved?.selected ?? [],
  });
  const [draft, setDraft] = useState(initial),
    [dirty, setDirty] = useState(false),
    [revision, setRevision] = useState(question.revision);
  useEffect(() => {
    if (!dirty) {
      setDraft(initial());
      setRevision(question.revision);
    }
  }, [question.revision]);
  const conflict = dirty && revision !== question.revision;
  const valid =
    draft.kind === 'custom'
      ? !!draft.answer.trim()
      : prompt.multiSelect
        ? !!draft.selected.length
        : prompt.options.some((option) => option.label === draft.answer);
  const submit = async () => {
    if (!valid || conflict) return;
    const answer: RemoteQuestionAnswer =
      draft.kind === 'custom'
        ? { questionIndex: index, kind: 'custom', answer: draft.answer }
        : prompt.multiSelect
          ? {
              questionIndex: index,
              kind: 'multi',
              answer: null,
              selected: draft.selected,
            }
          : { questionIndex: index, kind: 'option', answer: draft.answer };
    const result = await send({
      action: 'answer',
      expectedRevision: revision,
      answers: [answer],
    });
    if (result) {
      setDirty(false);
      setRevision(result.revision);
    }
  };
  return (
    <fieldset disabled={busy} className="remote-question-item">
      <legend>{prompt.header || `Question ${index + 1}`}</legend>
      <p>{prompt.question}</p>
      {prompt.options.map((option, optionIndex) => (
        <div className="remote-option" key={option.label}>
          <label>
            <input
              type={prompt.multiSelect ? 'checkbox' : 'radio'}
              name={`answer-${groupName}-${index}`}
              disabled={!writable}
              checked={
                draft.kind !== 'custom' &&
                (prompt.multiSelect
                  ? draft.selected.includes(option.label)
                  : draft.answer === option.label)
              }
              onChange={(event) => {
                setDirty(true);
                setDraft((old) =>
                  prompt.multiSelect
                    ? {
                        ...old,
                        kind: 'multi',
                        answer: '',
                        selected: event.target.checked
                          ? [...old.selected, option.label]
                          : old.selected.filter(
                              (value) => value !== option.label,
                            ),
                      }
                    : { kind: 'option', answer: option.label, selected: [] },
                );
              }}
            />
            <span>
              {option.label}
              <small>{option.description}</small>
            </span>
          </label>
          {option.preview && (
            <details>
              <summary>Preview option {optionIndex + 1}</summary>
              <pre>{option.preview}</pre>
            </details>
          )}
        </div>
      ))}
      <label className="remote-custom-answer">
        Written answer
        <Textarea
          aria-label={`Written answer for ${prompt.question}`}
          readOnly={!writable}
          value={draft.kind === 'custom' ? draft.answer : ''}
          maxLength={20000}
          onChange={(event) => {
            setDirty(true);
            setDraft({
              kind: 'custom',
              answer: event.target.value,
              selected: [],
            });
          }}
        />
      </label>
      {saved && (
        <p className="remote-note">
          Saved answer:{' '}
          {saved.kind === 'multi' ? saved.selected?.join(', ') : saved.answer}
        </p>
      )}
      {conflict && (
        <p role="status">
          Another response was saved. Your draft is retained. Review the saved
          answer before continuing.
          <Button
            size="sm"
            variant="outline"
            disabled={!writable}
            onClick={() => setRevision(question.revision)}
          >
            Keep my draft after review
          </Button>
        </p>
      )}
      {writable && (
        <Button
          size="sm"
          disabled={busy || !valid || conflict || !dirty}
          onClick={() => void submit()}
        >
          Save answer {index + 1}
        </Button>
      )}
    </fieldset>
  );
}
function SingleInput({
  question,
  writable,
  busy,
  send,
}: {
  question: RemoteQuestion;
  writable: boolean;
  busy: boolean;
  send: Sender;
}) {
  const initial = () =>
    typeof question.value === 'string'
      ? question.value
      : question.input.method === 'editor'
        ? (question.input.initial ?? '')
        : '';
  const [value, setValue] = useState(initial),
    [dirty, setDirty] = useState(false),
    [revision, setRevision] = useState(question.revision),
    [custom, setCustom] = useState(
      question.input.method === 'select' &&
        question.customAnswer !== undefined,
    ),
    [customValue, setCustomValue] = useState(question.customAnswer ?? '');
  useEffect(() => {
    if (!dirty) {
      setValue(initial());
      setCustom(
        question.input.method === 'select' &&
          question.customAnswer !== undefined,
      );
      setCustomValue(question.customAnswer ?? '');
      setRevision(question.revision);
    }
  }, [question.revision]);
  const conflict = dirty && revision !== question.revision;
  if (question.input.method === 'questionnaire') return null;
  const submit = async (answer: unknown, written?: string) => {
    const result = await send({
      action: 'answer',
      expectedRevision: revision,
      value: answer,
      ...(written !== undefined ? { customValue: written } : {}),
    });
    if (result) {
      setDirty(false);
      setRevision(result.revision);
    }
  };
  const valid =
    question.input.method === 'select' && custom
      ? !!customValue.trim()
      : !!value.trim();
  return (
    <div className="remote-single-input">
      {question.input.method === 'confirm' ? (
        question.status === 'open' ? (
          <div className="remote-actions">
            <Button
              size="sm"
              disabled={!writable || busy}
              onClick={() => void submit(true)}
            >
              Confirm
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!writable || busy}
              onClick={() => void submit(false)}
            >
              Decline
            </Button>
          </div>
        ) : (
          <p>
            Saved response:{' '}
            {question.value === true
              ? 'Confirmed'
              : question.value === false
                ? 'Declined'
                : 'No response'}
          </p>
        )
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (valid && !conflict)
              void submit(
                question.input.method === 'select' && custom ? null : value,
                question.input.method === 'select' && custom
                  ? customValue
                  : undefined,
              );
          }}
        >
          {question.input.method === 'select' ? (
            <>
              <label>
                Response
                <select
                  aria-label={question.input.title}
                  disabled={!writable || busy || custom}
                  value={value}
                  onChange={(event) => {
                    setValue(event.target.value);
                    setDirty(true);
                  }}
                >
                  <option value="">Choose a response</option>
                  {question.input.choices.map((choice) => (
                    <option key={choice} value={choice}>
                      {choice}
                    </option>
                  ))}
                </select>
              </label>
              <label className="remote-option">
                <input
                  type="checkbox"
                  checked={custom}
                  disabled={!writable || busy}
                  onChange={(event) => {
                    setCustom(event.target.checked);
                    setDirty(true);
                  }}
                />
                Write a different response
              </label>
              {custom && (
                <label>
                  Written response
                  <Textarea
                    aria-label={`Written response for ${question.input.title}`}
                    readOnly={!writable || busy}
                    maxLength={20000}
                    value={customValue}
                    onChange={(event) => {
                      setCustomValue(event.target.value);
                      setDirty(true);
                    }}
                  />
                </label>
              )}
            </>
          ) : question.input.method === 'editor' ? (
            <label>
              Response
              <Textarea
                aria-label={question.input.title}
                className="remote-editor-input"
                readOnly={!writable || busy}
                maxLength={50000}
                value={value}
                onChange={(event) => {
                  setValue(event.target.value);
                  setDirty(true);
                }}
              />
            </label>
          ) : (
            <label>
              Response
              <Input
                aria-label={question.input.title}
                readOnly={!writable || busy}
                placeholder={question.input.placeholder}
                maxLength={20000}
                value={value}
                onChange={(event) => {
                  setValue(event.target.value);
                  setDirty(true);
                }}
              />
            </label>
          )}
          {conflict && (
            <p role="status">
              A saved response changed. Your draft is retained.
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!writable}
                onClick={() => setRevision(question.revision)}
              >
                Keep my draft after review
              </Button>
            </p>
          )}
          {writable && (
            <Button size="sm" disabled={busy || !valid || conflict}>
              Send response
            </Button>
          )}
        </form>
      )}
    </div>
  );
}
