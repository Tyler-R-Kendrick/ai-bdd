import { RemoteActivity } from './remote/RemoteActivity.tsx';
import { IntegrationPanel } from './integrations/IntegrationPanel.tsx';
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  CheckCheck,
  ChevronRight,
  ExternalLink,
  FileClock,
  FlaskConical,
  GitPullRequest,
  History,
  Link2,
  MessageSquare,
  MessageSquarePlus,
  Play,
  Plus,
  RefreshCw,
  Send,
  Sparkles,
  Square,
  Undo2,
  X,
} from 'lucide-react';
import type { Bundle } from '../App.tsx';
import type {
  Decision,
  Message,
  Project,
  Run,
  Thread,
  User,
} from '../../shared/domain.ts';
import type {
  ArtifactRef,
  DocPlan,
  Feature,
  Scenario,
  ScenarioResult,
  StepResult,
} from '@ai-bdd/sdk';
import { docText } from '../../shared/domain.ts';
import { api, date, download } from '../lib.ts';
import {
  Badge,
  Button,
  Field,
  IconButton,
  Input,
  Modal,
  Select,
  Spinner,
  Textarea,
} from './ui.tsx';
import { MessageMarkdown } from './panels/MessageMarkdown.tsx';
import {
  useThreadMessages,
  type HistoryGap,
} from './panels/useThreadMessages.ts';
import { ConversationCards } from './integrations/ConversationCards.tsx';
import './panels/DetailPanel.css';

type Props = {
  bundle: Bundle;
  project: Project;
  user: User;
  capabilities: { agent?: boolean; runner?: boolean };
  panel: string;
  onPanel: (panel: string) => void;
  onRefresh: () => Promise<void>;
  onError: (message: string) => void;
  anchor: { id: string; quote: string } | null;
  onClearAnchor: () => void;
  onOpenArtifact: (id: string) => void;
};
type CommonProps = Pick<
  Props,
  'bundle' | 'project' | 'onRefresh' | 'onError'
>;
type Tone = 'neutral' | 'green' | 'amber' | 'red' | 'purple';
const statusTone = (status: string): Tone =>
  ['passed', 'accepted', 'merged', 'holds'].includes(status)
    ? 'green'
    : [
          'failed',
          'error',
          'interrupted',
          'rejected',
          'closed',
          'fails',
        ].includes(status)
      ? 'red'
      : [
            'running',
            'queued',
            'proposed',
            'unreviewed',
            'stale',
            'inconclusive',
            'blocked',
          ].includes(status)
        ? 'amber'
        : 'neutral';
const tabs = [
  { id: 'chat', label: 'Chat', Icon: MessageSquare },
  { id: 'decisions', label: 'Decisions', Icon: CheckCheck },
  { id: 'tests', label: 'Tests', Icon: FlaskConical },
  { id: 'history', label: 'History', Icon: History },
  { id: 'integrations', label: 'Connections', Icon: Link2 },
];

function useTask(onError: Props['onError']) {
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const task = useCallback(
    async (work: () => Promise<void>) => {
      if (!mounted.current) return;
      setBusy(true);
      try {
        await work();
      } catch (error) {
        if (mounted.current)
          onError(
            error instanceof Error
              ? error.message
              : 'The request could not be completed',
          );
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [onError],
  );
  return { busy, task, mounted };
}

export function DetailPanel(props: Props) {
  const prefix = useId();
  const selected = tabs.some((t) => t.id === props.panel)
    ? props.panel
    : 'chat';
  const panelName = tabs.find((t) => t.id === selected)!.label;
  const messageCount = props.bundle.threads.every(
    (thread) => typeof thread.messageCount === 'number',
  )
    ? props.bundle.threads.reduce(
        (total, thread) => total + thread.messageCount,
        0,
      )
    : props.bundle.messages.length;
  function tabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft')
      next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    props.onPanel(tabs[next]!.id);
    document.getElementById(`${prefix}-${tabs[next]!.id}`)?.focus();
  }
  return (
    <>
      <div className="detail-header">
        <span>Artifact context</span>
        <Badge>
          {props.project.role === 'viewer' ? 'View only' : 'Shared'}
        </Badge>
      </div>
      <div
        className="detail-tabs"
        role="tablist"
        aria-label="Artifact context"
      >
        {tabs.map(({ id, label, Icon }, index) => (
          <button
            key={id}
            id={`${prefix}-${id}`}
            role="tab"
            aria-label={label}
            aria-selected={selected === id}
            aria-controls={`${prefix}-panel`}
            tabIndex={selected === id ? 0 : -1}
            className={`detail-tab ${selected === id ? 'active' : ''}`}
            onClick={() => props.onPanel(id)}
            onKeyDown={(event) => tabKey(event, index)}
          >
            <Icon size={15} />
            <span>{label}</span>
            {id === 'chat' && messageCount > 0 && (
              <small
                aria-hidden="true"
                title={`${messageCount} messages in this artifact`}
              >
                {new Intl.NumberFormat(undefined, {
                  notation: 'compact',
                  maximumFractionDigits: 1,
                }).format(messageCount)}
              </small>
            )}
          </button>
        ))}
      </div>
      <div
        id={`${prefix}-panel`}
        className="detail-body"
        role="tabpanel"
        aria-label={panelName}
        aria-labelledby={`${prefix}-${selected}`}
      >
        {selected === 'chat' && (
          <ChatPanel key={props.bundle.artifact.id} {...props} />
        )}
        {selected === 'decisions' && (
          <DecisionsPanel key={props.bundle.artifact.id} {...props} />
        )}
        {selected === 'tests' && (
          <TestsPanel key={props.bundle.artifact.id} {...props} />
        )}
        {selected === 'integrations' && (
          <IntegrationPanel
            key={props.bundle.artifact.id}
            artifact={props.bundle.artifact}
            project={props.project}
            onOpenArtifact={props.onOpenArtifact}
            onRefresh={props.onRefresh}
          />
        )}
        {selected === 'history' && (
          <HistoryPanel key={props.bundle.artifact.id} {...props} />
        )}
      </div>
    </>
  );
}

function ChatPanel({
  bundle,
  project,
  user,
  capabilities,
  onRefresh,
  onError,
  anchor,
  onClearAnchor,
  onOpenArtifact,
}: Props) {
  const [body, setBody] = useState('');
  const [intent, setIntent] = useState<
    'message' | 'chat' | 'edit' | 'research'
  >('message');
  const [showResolved, setShowResolved] = useState(false);
  const [activeThread, setActiveThread] = useState<string | null>(null);
  const [paginationCommit, setPaginationCommit] = useState(0);
  const { busy, task, mounted } = useTask(onError);
  const main = (bundle.threads as Thread[]).find((thread) => !thread.anchor);
  const comments = (bundle.threads as Thread[]).filter(
    (thread) => !!thread.anchor,
  );
  const selectedThread = (bundle.threads as Thread[]).find(
    (thread) => thread.id === activeThread,
  );
  const threadId = selectedThread?.id ?? main?.id;
  const history = useThreadMessages(
    bundle.artifact.id,
    threadId,
    bundle.messages,
    onError,
  );
  const selectedMessages = history.messages;
  const readOnly = project.role === 'viewer';
  const end = useRef<HTMLDivElement>(null);
  const conversation = useRef<HTMLDivElement>(null),
    nearBottom = useRef(true);
  const pendingScroll = useRef<{ height: number; top: number } | null>(null);
  useEffect(() => {
    if (anchor) setActiveThread(null);
  }, [anchor]);
  useEffect(() => {
    nearBottom.current = true;
    pendingScroll.current = null;
  }, [threadId]);
  useLayoutEffect(() => {
    if (!pendingScroll.current || !conversation.current) return;
    const previous = pendingScroll.current;
    pendingScroll.current = null;
    conversation.current.scrollTop =
      previous.top + conversation.current.scrollHeight - previous.height;
  }, [selectedMessages.length, paginationCommit]);
  useEffect(() => {
    if (nearBottom.current)
      end.current?.scrollIntoView({
        block: 'nearest',
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)')
          .matches
          ? 'auto'
          : 'smooth',
      });
  }, [threadId, selectedMessages.at(-1)?.id, bundle.agentActive]);
  function loadEarlier(gap?: HistoryGap) {
    if (conversation.current)
      pendingScroll.current = {
        height: conversation.current.scrollHeight,
        top: conversation.current.scrollTop,
      };
    void history.loadEarlier(gap).finally(() => {
      if (mounted.current) setPaginationCommit((value) => value + 1);
    });
  }

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const text = body.trim();
    if (!text || busy || readOnly) return;
    if (intent !== 'message' && !capabilities.agent) {
      onError('The workspace owner has not configured an AI model');
      return;
    }
    await task(async () => {
      let threadId = selectedThread?.id ?? main?.id;
      if (anchor) {
        const created = await api<{ id: string }>(
          `/artifacts/${bundle.artifact.id}/threads`,
          'POST',
          { anchor: anchor.id, quote: anchor.quote, body: text },
        );
        threadId = created.id;
        if (mounted.current) {
          setActiveThread(created.id);
          onClearAnchor();
        }
      } else if (threadId)
        await api(`/artifacts/${bundle.artifact.id}/messages`, 'POST', {
          threadId,
          body: text,
        });
      else
        throw new Error(
          'The artifact discussion is unavailable. Refresh this artifact and try again.',
        );
      if (!mounted.current) return;
      setBody('');
      await onRefresh();
      if (intent !== 'message') {
        await api(`/artifacts/${bundle.artifact.id}/agent`, 'POST', {
          threadId,
          intent,
          ...(intent === 'research' ? { brief: text } : {}),
        });
        if (mounted.current) await onRefresh();
      }
    });
  }
  function goToAnchor(thread: Thread) {
    const escaped =
      typeof CSS !== 'undefined' && CSS.escape
        ? CSS.escape(thread.anchor ?? '')
        : (thread.anchor ?? '').replace(/["\\]/g, '\\$&');
    const target = document.querySelector(`[data-id="${escaped}"]`);
    if (target)
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    else
      onError(
        'The original paragraph is no longer in the document. Its discussion and quote are preserved.',
      );
  }
  return (
    <div className="chat-panel">
      <div className="panel-section chat-context">
        <div className="panel-heading">
          <h2>
            {selectedThread ? 'Comment thread' : 'Artifact conversation'}
          </h2>
          {selectedThread && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setActiveThread(null)}
            >
              All chat
            </Button>
          )}
        </div>
        <p className="small muted">
          {selectedThread
            ? 'This discussion stays linked to its original paragraph.'
            : 'Your team, decisions, and agent share this artifact’s context.'}
        </p>
      </div>
      {threadId && (
        <RemoteActivity
          artifactId={bundle.artifact.id}
          artifactVersion={bundle.artifact.version}
          threadId={threadId}
          readOnly={readOnly}
          active={
            bundle.agentActive ||
            bundle.agentProfile?.profile.harness === 'remote-planner'
          }
          onError={onError}
        />
      )}
      {threadId && (
        <ConversationCards
          artifactId={bundle.artifact.id}
          artifactVersion={bundle.artifact.version}
          threadId={threadId}
          readOnly={readOnly}
          onChanged={() => void onRefresh()}
          onError={(error) => onError((error as Error).message)}
        />
      )}
      {selectedThread && (
        <div className="comment-quote">
          <button onClick={() => goToAnchor(selectedThread)}>
            <Link2 size={13} />
            {selectedThread.quote || 'Jump to linked paragraph'}
          </button>
          <Badge tone={selectedThread.resolved ? 'green' : 'neutral'}>
            {selectedThread.resolved ? 'Resolved' : 'Open'}
          </Badge>
          {!readOnly && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() =>
                task(async () => {
                  await api(
                    `/artifacts/${bundle.artifact.id}/threads/${selectedThread.id}`,
                    'PATCH',
                    { resolved: !selectedThread.resolved },
                  );
                  await onRefresh();
                })
              }
            >
              {selectedThread.resolved ? (
                <Undo2 size={13} />
              ) : (
                <Check size={13} />
              )}{' '}
              {selectedThread.resolved ? 'Reopen' : 'Resolve'}
            </Button>
          )}
        </div>
      )}
      <div
        className="conversation"
        ref={conversation}
        onScroll={() => {
          const element = conversation.current;
          if (element)
            nearBottom.current =
              element.scrollHeight -
                element.scrollTop -
                element.clientHeight <
              80;
        }}
        aria-live="polite"
        aria-label="Discussion messages"
      >
        {!history.loaded && <Spinner label="Loading conversation…" />}
        {history.error && (
          <div className="history-load-error" role="alert">
            <p>{history.error}</p>
            {!selectedMessages.length && (
              <Button variant="outline" size="sm" onClick={history.retry}>
                Retry conversation
              </Button>
            )}
          </div>
        )}
        {history.hasMore && (
          <div className="load-earlier">
            <Button
              variant="outline"
              size="sm"
              disabled={history.loadingEarlier}
              onClick={() => loadEarlier()}
            >
              {history.loadingEarlier ? (
                <Spinner label="Loading earlier…" />
              ) : (
                'Load earlier messages'
              )}
            </Button>
          </div>
        )}
        {history.loaded && !history.error && !selectedMessages.length && (
          <div className="panel-empty">
            <MessageSquare size={24} />
            <h3>Keep the thinking here.</h3>
            <p>
              Discuss this artifact, ask for a change, or select a paragraph
              and leave a comment.
            </p>
          </div>
        )}
        {selectedMessages.map((message) => (
          <Fragment key={message.id}>
            {history.gaps
              .filter((gap) => gap.before === message.id)
              .map((gap) => (
                <div
                  className="history-gap"
                  key={`${gap.afterSequence}-${gap.before}`}
                >
                  <p>
                    More messages were posted while this conversation was
                    open.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={history.loadingEarlier}
                    onClick={() => loadEarlier(gap)}
                  >
                    Load missing messages
                  </Button>
                </div>
              ))}
            <div className={`chat-message message-${message.role}`}>
              <div className="message-heading">
                <span
                  className={`message-avatar ${message.role === 'assistant' ? 'agent-avatar' : ''}`}
                  style={
                    message.authorId === user.id && message.role === 'user'
                      ? { background: user.color }
                      : undefined
                  }
                >
                  {message.role === 'assistant' ? (
                    <Sparkles size={13} />
                  ) : (
                    message.author.slice(0, 1)
                  )}
                </span>
                <strong>{message.author}</strong>
                <time
                  title={date(message.createdAt)}
                  dateTime={message.createdAt}
                >
                  {new Intl.DateTimeFormat(undefined, {
                    hour: 'numeric',
                    minute: '2-digit',
                  }).format(new Date(message.createdAt))}
                </time>
              </div>
              <div className="message-body">
                <MessageMarkdown text={message.body} onError={onError} />
              </div>
              {message.proposal?.content && (
                <div className="proposal-card">
                  <div>
                    <FileClock size={14} />
                    <strong>Proposed revision</strong>
                    <Badge>Based on v{message.proposal.version}</Badge>
                  </div>
                  <p className="small muted">
                    {message.proposal.version === bundle.artifact.version
                      ? 'Review the proposed content before applying it.'
                      : 'This artifact changed after the proposal was created. Ask for a fresh proposal.'}
                  </p>
                  <ProposalReview
                    message={message}
                    {...{ bundle, project, onRefresh, onError }}
                  />
                </div>
              )}
              {message.proposal?.researchArtifactId && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    onOpenArtifact(message.proposal!.researchArtifactId)
                  }
                >
                  Open research note <ArrowRight size={13} />
                </Button>
              )}
            </div>
          </Fragment>
        ))}
        {bundle.agentActive && (
          <div className="chat-message message-system">
            <Spinner label="Agent is working…" />
            {!readOnly && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  task(async () => {
                    await api(
                      `/artifacts/${bundle.artifact.id}/agent/cancel`,
                      'POST',
                    );
                    await onRefresh();
                  })
                }
              >
                <Square size={12} />
                Cancel task
              </Button>
            )}
          </div>
        )}
        <div ref={end} />
      </div>
      {!selectedThread && comments.length > 0 && (
        <section className="panel-section comment-list">
          <div className="panel-heading">
            <h3>Document comments</h3>
            <label className="small muted">
              <input
                type="checkbox"
                checked={showResolved}
                onChange={(event) => setShowResolved(event.target.checked)}
              />{' '}
              Include resolved
            </label>
          </div>
          {comments
            .filter((thread) => showResolved || !thread.resolved)
            .map((thread) => (
              <button
                className="comment-thread"
                key={thread.id}
                onClick={() => {
                  onClearAnchor();
                  setActiveThread(thread.id);
                }}
              >
                <MessageSquare size={14} />
                <span>
                  <strong>{thread.quote || 'Linked paragraph'}</strong>
                  <small>
                    {typeof (thread as Thread & { messageCount?: number })
                      .messageCount === 'number'
                      ? `${(thread as Thread & { messageCount: number }).messageCount} ${(thread as Thread & { messageCount: number }).messageCount === 1 ? 'message' : 'messages'}`
                      : 'Open discussion'}
                    {thread.resolved ? ' · resolved' : ''}
                  </small>
                </span>
                <ChevronRight size={13} />
              </button>
            ))}
        </section>
      )}
      {!readOnly ? (
        <form className="chat-composer" onSubmit={send}>
          {anchor && (
            <div className="composer-anchor">
              <MessageSquarePlus size={14} />
              <span>
                {anchor.quote || 'Comment on the selected paragraph'}
              </span>
              <IconButton
                label="Cancel anchored comment"
                onClick={onClearAnchor}
                type="button"
              >
                <X size={13} />
              </IconButton>
            </div>
          )}
          <Textarea
            aria-label={
              anchor
                ? 'Comment text'
                : selectedThread
                  ? 'Reply to comment'
                  : 'Message this artifact'
            }
            placeholder={
              anchor
                ? 'Leave a comment on this paragraph…'
                : selectedThread
                  ? 'Add to this discussion…'
                  : 'Discuss, ask, or explore…'
            }
            value={body}
            onChange={(event) => setBody(event.target.value)}
            maxLength={20000}
            disabled={busy}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                void send();
              }
            }}
          />
          <div className="composer-actions">
            <Select
              aria-label="Message action"
              value={intent}
              onChange={(event) =>
                setIntent(event.target.value as typeof intent)
              }
              disabled={busy}
            >
              <option value="message">Team message</option>
              <option value="chat" disabled={!capabilities.agent}>
                Ask agent
              </option>
              <option value="edit" disabled={!capabilities.agent}>
                Propose an edit
              </option>
              <option value="research" disabled={!capabilities.agent}>
                Research note
              </option>
            </Select>
            <Button
              size="icon"
              type="submit"
              aria-label={anchor ? 'Post comment' : 'Send message'}
              disabled={busy || !body.trim()}
            >
              {busy ? <Spinner label="" /> : <Send size={15} />}
            </Button>
          </div>
          <p className="composer-note small muted">
            {!capabilities.agent
              ? 'Team chat is available. AI is not configured.'
              : intent === 'research'
                ? 'Research retrieves sources from the exact brief and publishes a cited child document.'
                : intent === 'edit'
                  ? 'Agent edits are proposals you review before applying.'
                  : '⌘ / Ctrl Enter to send · saved with this artifact'}
          </p>
        </form>
      ) : (
        <p className="panel-hint small muted">
          You have view-only access to this project.
        </p>
      )}
    </div>
  );
}

function ProposalReview({
  message,
  bundle,
  project,
  onRefresh,
  onError,
}: CommonProps & { message: Message }) {
  const [open, setOpen] = useState(false);
  const { busy, task } = useTask(onError);
  const proposal = message.proposal!;
  const stale = proposal.version !== bundle.artifact.version;
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Review proposal
      </Button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Review proposed revision"
        description="Applying this proposal creates an attributed revision and updates connected editors."
      >
        <div className="revision-compare">
          <div>
            <h3>Current content · v{bundle.artifact.version}</h3>
            <pre>{readableContent(bundle.artifact.content)}</pre>
          </div>
          <div>
            <h3>Proposed content</h3>
            <pre>{readableContent(proposal.content)}</pre>
          </div>
        </div>
        {stale && (
          <p className="error-text" role="status">
            The artifact changed since this proposal. Request a new proposal
            before applying.
          </p>
        )}
        <div className="dialog-footer">
          <Button variant="outline" onClick={() => setOpen(false)}>
            Close review
          </Button>
          <Button
            disabled={busy || stale || project.role === 'viewer'}
            onClick={() =>
              task(async () => {
                const route = ['design', 'document'].includes(
                  bundle.artifact.kind,
                )
                  ? 'apply-document'
                  : 'apply';
                await api(
                  `/artifacts/${bundle.artifact.id}/proposals/${message.id}/${route}`,
                  'POST',
                );
                setOpen(false);
                await onRefresh();
              })
            }
          >
            {busy ? 'Applying…' : 'Apply proposed revision'}
          </Button>
        </div>
      </Modal>
    </>
  );
}

function DecisionsPanel(props: Props) {
  return (
    <>
      <section className="panel-section">
        <div className="panel-heading">
          <h2>Architecture decisions</h2>
          <Badge>{props.bundle.decisions.length} ADR</Badge>
        </div>
        <p className="small muted">
          The reasoning belongs to the artifact. Changes retain their author
          and previous values in history.
        </p>
      </section>
      {(props.bundle.decisions as Decision[]).map((decision) => (
        <DecisionEditor key={decision.id} decision={decision} {...props} />
      ))}
      <LinksSection {...props} />
    </>
  );
}

function DecisionEditor({
  decision,
  bundle,
  project,
  onRefresh,
  onError,
}: CommonProps & { decision: Decision }) {
  const [draft, setDraft] = useState<Decision | null>(null);
  const { busy, task } = useTask(onError);
  const readOnly = project.role === 'viewer';
  const stale = draft && draft.version !== decision.version;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    await task(async () => {
      await api(
        `/artifacts/${bundle.artifact.id}/decisions/${decision.id}`,
        'PUT',
        {
          title: draft.title,
          context: draft.context,
          decision: draft.decision,
          consequences: draft.consequences,
          status: draft.status,
          version: draft.version,
        },
      );
      setDraft(null);
      await onRefresh();
    });
  }
  return (
    <section className="panel-section adr-card">
      <div className="panel-heading">
        <h3>{decision.title}</h3>
        <Badge tone={statusTone(decision.status)}>{decision.status}</Badge>
      </div>
      <p className="small muted">
        {decision.author} · v{decision.version} · {date(decision.updatedAt)}
      </p>
      {draft ? (
        <form className="decision-fields" onSubmit={submit}>
          {stale && (
            <p className="panel-warning" role="status">
              Another teammate updated this ADR. Your draft is preserved.
              Cancel and reopen to edit the latest revision.
            </p>
          )}
          <Field label="ADR title">
            <Input
              value={draft.title}
              onChange={(event) =>
                setDraft({ ...draft, title: event.target.value })
              }
              required
              maxLength={180}
            />
          </Field>
          <Field label="Status">
            <Select
              value={draft.status}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  status: event.target.value as Decision['status'],
                })
              }
            >
              <option value="proposed">Proposed</option>
              <option value="accepted">Accepted</option>
              <option value="superseded">Superseded</option>
            </Select>
          </Field>
          {(['context', 'decision', 'consequences'] as const).map((field) => (
            <Field
              key={field}
              label={
                field === 'context'
                  ? 'Context'
                  : field === 'decision'
                    ? 'Decision'
                    : 'Consequences & alternatives'
              }
            >
              <Textarea
                value={draft[field]}
                onChange={(event) =>
                  setDraft({ ...draft, [field]: event.target.value })
                }
                maxLength={20000}
              />
            </Field>
          ))}
          <div className="form-actions">
            <Button size="sm" disabled={busy || !!stale}>
              {busy ? 'Saving…' : 'Save ADR'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setDraft(null)}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <>
          <dl className="decision-reading">
            <dt>Context</dt>
            <dd>{decision.context || 'No context recorded.'}</dd>
            <dt>Decision</dt>
            <dd>{decision.decision || 'No decision recorded.'}</dd>
            <dt>Consequences & alternatives</dt>
            <dd>{decision.consequences || 'No consequences recorded.'}</dd>
          </dl>
          {!readOnly && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setDraft(structuredClone(decision))}
            >
              Edit ADR
            </Button>
          )}
        </>
      )}
    </section>
  );
}

function TestsPanel({
  bundle,
  project,
  capabilities,
  onRefresh,
  onError,
}: Props) {
  const [plans, setPlans] = useState<DocPlan[]>([]);
  const [planStatus, setPlanStatus] = useState('');
  const [documentHash, setDocumentHash] = useState('');
  const [selectedRun, setSelectedRun] = useState<string>('');
  const { busy, task, mounted } = useTask(onError);
  const isDocument = ['design', 'document'].includes(bundle.artifact.kind);
  const readOnly = project.role === 'viewer';
  const runs = bundle.runs as Run[];
  const run = runs.find((item) => item.id === selectedRun) ?? runs[0];
  const stale = !!run && run.artifactVersion !== bundle.artifact.version;
  const loadPlans = useCallback(async () => {
    const result = await api<DocPlan[]>(
      `/artifacts/${bundle.artifact.id}/plans`,
    );
    if (mounted.current) setPlans(result);
  }, [bundle.artifact.id, mounted]);
  useEffect(() => {
    if (isDocument) void task(loadPlans);
  }, [bundle.artifact.id, isDocument, loadPlans, task]);
  useEffect(() => {
    let cancelled = false;
    setDocumentHash('');
    if (!isDocument || !globalThis.crypto?.subtle) return;
    const raw = docText(bundle.artifact.content.doc),
      normalized = (
        raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
      ).replace(/\r\n?/g, '\n');
    void crypto.subtle
      .digest('SHA-256', new TextEncoder().encode(normalized))
      .then((digest) => {
        if (!cancelled)
          setDocumentHash(
            [...new Uint8Array(digest)]
              .map((value) => value.toString(16).padStart(2, '0'))
              .join(''),
          );
      })
      .catch(() => {
        /* The server still enforces frozen-plan integrity when Web Crypto is unavailable. */
      });
    return () => {
      cancelled = true;
    };
  }, [
    bundle.artifact.id,
    bundle.artifact.version,
    bundle.artifact.content,
    isDocument,
  ]);
  const features = plans.flatMap((plan) => plan.features);
  const scenarioCount = features.reduce(
    (count, feature) => count + feature.scenarios.length,
    0,
  );
  const stalePlans =
    !!documentHash && plans.some((plan) => plan.docSha256 !== documentHash);
  async function compile() {
    await task(async () => {
      setPlanStatus('');
      const result = await api<{
        result: {
          exitCode: number;
          docs: { diagnostics?: { message: string }[] }[];
        };
        plans: DocPlan[];
      }>(`/artifacts/${bundle.artifact.id}/compile`, 'POST');
      if (!mounted.current) return;
      setPlans(result.plans);
      const diagnostics = result.result.docs
        .flatMap((doc) => doc.diagnostics ?? [])
        .map((diagnostic) => diagnostic.message);
      setPlanStatus(
        result.result.exitCode === 0
          ? 'Compiled from the current document. Review the extracted scenarios before running.'
          : `Compilation requires attention.${diagnostics.length ? ' ' + diagnostics.join(' ') : ''}`,
      );
      await onRefresh();
    });
  }
  return (
    <>
      <section className="panel-section">
        <div className="panel-heading">
          <h2>Acceptance tests</h2>
          <FlaskConical size={17} />
        </div>
        <p className="small muted">
          Executable intent, grounded in the document. Characterize once;
          replay deterministic actions with captured evidence.
        </p>
        {!isDocument ? (
          <div className="panel-hint">
            <p>Acceptance tests run from document artifacts.</p>
            <p className="small muted">
              Open the project’s design document to compile requirements and
              inspect test evidence.
            </p>
          </div>
        ) : !capabilities.runner ? (
          <div className="panel-hint">
            <h3>Runner not configured</h3>
            <p className="small muted">
              An operator must configure a trusted ai-bdd runner with a
              driver, model access, and a preview target. New tests cannot run
              until the runner is configured.
            </p>
          </div>
        ) : (
          <>
            <div className="form-actions">
              <Button
                size="sm"
                variant="outline"
                disabled={busy || bundle.runnerActive || readOnly}
                onClick={compile}
              >
                <RefreshCw size={14} />
                {busy ? 'Working…' : 'Compile scenarios'}
              </Button>
              <Button
                size="sm"
                disabled={
                  busy ||
                  bundle.runnerActive ||
                  readOnly ||
                  scenarioCount === 0 ||
                  stalePlans
                }
                onClick={() =>
                  task(async () => {
                    await api(
                      `/artifacts/${bundle.artifact.id}/runs`,
                      'POST',
                    );
                    await onRefresh();
                  })
                }
              >
                <Play size={14} />
                Run tests
              </Button>
            </div>
            {readOnly && (
              <p className="small muted">
                Editors can compile, review, and run scenarios.
              </p>
            )}
            {bundle.runnerActive && (
              <div className="run-progress">
                <Spinner label="Tests are running…" />
                {!readOnly && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      task(async () => {
                        await api(
                          `/artifacts/${bundle.artifact.id}/runs/cancel`,
                          'POST',
                        );
                        await onRefresh();
                      })
                    }
                  >
                    <Square size={12} />
                    Cancel
                  </Button>
                )}
              </div>
            )}
          </>
        )}
        {planStatus && (
          <p className="panel-hint small" role="status">
            {planStatus}
          </p>
        )}
        {stalePlans && (
          <p className="panel-warning small" role="status">
            The document changed since these scenarios were compiled. An
            editor must compile the current requirements before running them.
          </p>
        )}
      </section>
      {features.length > 0 && (
        <section className="panel-section">
          <div className="panel-heading">
            <h3>Grounded scenarios</h3>
            <Badge>{scenarioCount}</Badge>
          </div>
          {features.map((feature) => (
            <PlanFeature
              key={feature.id}
              feature={feature}
              artifactId={bundle.artifact.id}
              readOnly={readOnly}
              disabled={busy || bundle.runnerActive}
              onReview={(target, action) =>
                task(async () => {
                  await api(
                    `/artifacts/${bundle.artifact.id}/review`,
                    'POST',
                    {
                      target,
                      action,
                    },
                  );
                  await loadPlans();
                  await onRefresh();
                })
              }
            />
          ))}
        </section>
      )}
      {isDocument &&
        capabilities.runner &&
        !readOnly &&
        !features.length &&
        !busy && (
          <section className="panel-section panel-empty">
            <FlaskConical size={22} />
            <h3>Turn intent into scenarios.</h3>
            <p>
              Write verifiable requirements in the document, then compile and
              review the extracted Given / When / Then steps.
            </p>
          </section>
        )}
      <section className="panel-section">
        <div className="panel-heading">
          <h3>Run history</h3>
          <Badge>{runs.length}</Badge>
        </div>
        {!runs.length ? (
          <p className="small muted">
            No execution results yet. Test status stays unverified until a run
            completes.
          </p>
        ) : (
          <>
            <Field label="Execution">
              <Select
                value={run?.id ?? ''}
                onChange={(event) => setSelectedRun(event.target.value)}
              >
                {runs.map((item) => (
                  <option key={item.id} value={item.id}>
                    {date(item.createdAt)} · v{item.artifactVersion} ·{' '}
                    {item.status}
                  </option>
                ))}
              </Select>
            </Field>
            {run && (
              <div className="run-card">
                <div className="run-heading">
                  <Badge tone={stale ? 'amber' : statusTone(run.status)}>
                    {stale ? 'Evidence out of date' : run.status}
                  </Badge>
                  <span className="small muted">
                    Document v{run.artifactVersion}
                  </span>
                </div>
                {stale && (
                  <p className="panel-warning small">
                    The document changed after this run. These results do not
                    verify the current revision.
                  </p>
                )}
                <p className="small muted">
                  Started {date(run.createdAt)}
                  {run.finishedAt
                    ? ` · Finished ${date(run.finishedAt)}`
                    : ''}
                </p>
                {run.error && <p className="error-text">{run.error}</p>}
                {run.result && (
                  <>
                    <div className="run-totals">
                      {Object.entries(run.result.totals ?? {})
                        .filter(([, count]) => Number(count) > 0)
                        .map(([status, count]) => (
                          <Badge key={status} tone={statusTone(status)}>
                            {String(count)} {status}
                          </Badge>
                        ))}
                    </div>
                    <p className="small muted">
                      {run.result.usage?.modelCalls ?? 0} model calls ·{' '}
                      {run.result.options?.recordingsMode ?? 'unknown'}{' '}
                      recordings
                    </p>
                    {run.result.integrity && (
                      <p
                        className={
                          run.result.integrity.ok
                            ? 'small muted'
                            : 'error-text'
                        }
                      >
                        {run.result.integrity.ok
                          ? 'Evidence hashes verified.'
                          : `Evidence integrity failed: ${(run.result.integrity.problems ?? []).join('; ')}`}
                      </p>
                    )}
                    {((run.result.scenarios as ScenarioResult[]) ?? []).map(
                      (scenario) => (
                        <ScenarioEvidence
                          key={scenario.scenarioId}
                          scenario={scenario}
                          run={run}
                          artifactId={bundle.artifact.id}
                          onError={onError}
                        />
                      ),
                    )}
                    {!run.result.scenarios?.length && (
                      <p className="panel-warning small">
                        This report contains no scenarios. It does not
                        establish acceptance coverage.
                      </p>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        download(
                          `run-${run.id}.json`,
                          JSON.stringify(run.result, null, 2),
                        )
                      }
                    >
                      <ArrowDownToLine size={13} />
                      Download report
                    </Button>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </section>
      <LinksSection {...{ bundle, project, onRefresh, onError }} />
    </>
  );
}

function PlanFeature({
  feature,
  readOnly,
  disabled,
  onReview,
}: {
  feature: Feature;
  artifactId: string;
  readOnly: boolean;
  disabled: boolean;
  onReview: (
    target: string,
    action: 'accept' | 'reject' | 'pin' | 'unpin',
  ) => Promise<void>;
}) {
  return (
    <details className="plan-feature" open>
      <summary>
        <span>{feature.title}</span>
        <Badge tone={statusTone(feature.review)}>{feature.review}</Badge>
      </summary>
      {feature.story && (
        <p className="small muted">
          As {feature.story.asA}, I want {feature.story.iWant}
          {feature.story.soThat ? `, so that ${feature.story.soThat}` : ''}.
        </p>
      )}
      {feature.scenarios.map((scenario) => (
        <PlanScenario
          key={scenario.id}
          scenario={scenario}
          readOnly={readOnly}
          disabled={disabled}
          onReview={onReview}
        />
      ))}
      {!readOnly && (
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() =>
            onReview(feature.id, feature.pinned ? 'unpin' : 'pin')
          }
        >
          {feature.pinned ? 'Unpin feature' : 'Pin feature'}
        </Button>
      )}
    </details>
  );
}

function PlanScenario({
  scenario,
  readOnly,
  disabled,
  onReview,
}: {
  scenario: Scenario;
  readOnly: boolean;
  disabled: boolean;
  onReview: (
    target: string,
    action: 'accept' | 'reject' | 'pin' | 'unpin',
  ) => Promise<void>;
}) {
  return (
    <div className="plan-scenario">
      <div className="panel-heading">
        <h4>{scenario.title}</h4>
        <Badge tone={statusTone(scenario.review)}>{scenario.review}</Badge>
      </div>
      {scenario.steps.map((step) => (
        <div className="plan-step" key={step.key}>
          <span>{step.kind}</span>
          <p>{step.text}</p>
          {step.sources
            .filter((source) => source.quote)
            .map((source, index) => (
              <blockquote
                className="source-quote"
                key={`${source.chunkId}-${index}`}
              >
                <span>Document source</span>
                {source.quote}
              </blockquote>
            ))}
          {step.grounding === 'inferred' && (
            <small className="muted">
              Inferred step — review against the cited requirement.
            </small>
          )}
        </div>
      ))}
      {!readOnly && (
        <div className="form-actions">
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || scenario.review === 'accepted'}
            onClick={() => onReview(scenario.id, 'accept')}
          >
            <Check size={12} />
            Accept
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled || scenario.review === 'rejected'}
            onClick={() => onReview(scenario.id, 'reject')}
          >
            Reject
          </Button>
        </div>
      )}
    </div>
  );
}

function ScenarioEvidence({
  scenario,
  run,
  artifactId,
  onError,
}: {
  scenario: ScenarioResult;
  run: Run;
  artifactId: string;
  onError: Props['onError'];
}) {
  return (
    <details className="scenario-result">
      <summary>
        <span>{scenario.title}</span>
        <Badge tone={statusTone(scenario.status)}>{scenario.status}</Badge>
      </summary>
      <p className="small muted">
        {scenario.mode} · {scenario.driver} ·{' '}
        {(scenario.durationMs / 1000).toFixed(1)}s
      </p>
      {scenario.error && (
        <p className="error-text">
          {scenario.error.code}: {scenario.error.message}
        </p>
      )}
      {scenario.steps.map((step) => (
        <StepEvidence
          key={step.stepKey}
          step={step}
          artifactId={artifactId}
          runId={run.id}
          onError={onError}
        />
      ))}
    </details>
  );
}

function StepEvidence({
  step,
  artifactId,
  runId,
  onError,
}: {
  step: StepResult;
  artifactId: string;
  runId: string;
  onError: Props['onError'];
}) {
  return (
    <div className="step-result">
      <div className="panel-heading">
        <span className="small">
          <strong>{step.kind}</strong> {step.text}
        </span>
        <Badge tone={statusTone(step.status)}>{step.status}</Badge>
      </div>
      <p className="small muted">
        {step.path} · {step.determinism}
        {step.fuzzyReasons.length ? ` · ${step.fuzzyReasons.join(', ')}` : ''}
      </p>
      {step.error && (
        <p className="error-text">
          {step.error.code}: {step.error.message}
        </p>
      )}
      {step.judge && (
        <details>
          <summary className="small">
            Judge: {step.judge.verdict} · score {step.judge.score.toFixed(2)}
          </summary>
          {step.judge.samples.map((sample, index) => (
            <p key={index} className="small muted">
              {sample.explanation}
            </p>
          ))}
        </details>
      )}
      <div className="evidence-list">
        {step.evidence.map((ref, index) => (
          <EvidenceButton
            key={`${ref.sha256}-${index}`}
            evidence={ref}
            artifactId={artifactId}
            runId={runId}
            onError={onError}
          />
        ))}
      </div>
    </div>
  );
}

function EvidenceButton({
  evidence,
  artifactId,
  runId,
  onError,
}: {
  evidence: ArtifactRef;
  artifactId: string;
  runId: string;
  onError: Props['onError'];
}) {
  const [open, setOpen] = useState(false),
    [imageUrl, setImageUrl] = useState(''),
    [text, setText] = useState('');
  const urlRef = useRef('');
  const { busy, task, mounted } = useTask(onError);
  const path = `/api/artifacts/${artifactId}/runs/${runId}/evidence/${encodeURIComponent(evidence.path)}`;
  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );
  async function inspect() {
    await task(async () => {
      const response = await fetch(path, { credentials: 'same-origin' });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error ?? 'Evidence could not be loaded');
      }
      const blob = await response.blob();
      if (blob.size > 15 * 1024 * 1024)
        throw new Error(
          'This evidence file is too large to inspect inline. Download it instead.',
        );
      if (!mounted.current) return;
      if (evidence.kind === 'screenshot') {
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = URL.createObjectURL(
          new Blob([blob], { type: 'image/png' }),
        );
        setImageUrl(urlRef.current);
      } else setText((await blob.text()).slice(0, 300000));
      setOpen(true);
    });
  }
  return (
    <>
      <Button size="sm" variant="outline" disabled={busy} onClick={inspect}>
        {busy ? <Spinner label="" /> : <FileClock size={12} />}{' '}
        {evidence.kind}
      </Button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title={
          evidence.kind === 'screenshot'
            ? 'Visual evidence'
            : 'Execution evidence'
        }
        description={`SHA-256 ${evidence.sha256}`}
      >
        <div className="evidence-preview">
          {imageUrl ? (
            <img
              src={imageUrl}
              alt="Screenshot captured during this test step"
            />
          ) : (
            <pre>{text}</pre>
          )}
        </div>
        <div className="dialog-footer">
          <a className="evidence-download" href={path} download>
            <ArrowDownToLine size={13} />
            Download original · {Math.ceil(evidence.bytes / 1024)} KB
          </a>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Close evidence
          </Button>
        </div>
      </Modal>
    </>
  );
}

function LinksSection({ bundle, project, onRefresh, onError }: CommonProps) {
  const [adding, setAdding] = useState(false);
  const { busy, task } = useTask(onError);
  const readOnly = project.role === 'viewer';
  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    await task(async () => {
      await api(`/artifacts/${bundle.artifact.id}/links`, 'POST', data);
      setAdding(false);
      await onRefresh();
    });
  }
  return (
    <section className="panel-section linked-work">
      <div className="panel-heading">
        <h3>Linked work</h3>
        {!readOnly && (
          <IconButton
            label={adding ? 'Cancel adding link' : 'Add linked work'}
            onClick={() => setAdding(!adding)}
          >
            {adding ? <X size={14} /> : <Plus size={14} />}
          </IconButton>
        )}
      </div>
      {bundle.links.length === 0 && !adding && (
        <p className="small muted">
          Connect pull requests, issues, tests, and supporting references.
        </p>
      )}
      {bundle.links.map((link) => (
        <div className="link-row" key={link.id}>
          <a href={link.url} target="_blank" rel="noreferrer">
            {link.kind === 'pull-request' ? (
              <GitPullRequest size={14} />
            ) : (
              <Link2 size={14} />
            )}
            <span>
              {link.label}
              <small>{link.kind.replace('-', ' ')}</small>
            </span>
            <ExternalLink size={12} />
          </a>
          <Badge tone={statusTone(link.state)}>{link.state}</Badge>
          {!readOnly &&
            /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(
              link.url,
            ) && (
              <IconButton
                label={`Refresh ${link.label} state`}
                disabled={busy}
                onClick={() =>
                  task(async () => {
                    await api(
                      `/artifacts/${bundle.artifact.id}/links/${link.id}/refresh`,
                      'POST',
                    );
                    await onRefresh();
                  })
                }
              >
                <RefreshCw size={12} />
              </IconButton>
            )}
          {!readOnly && (
            <IconButton
              label={`Remove ${link.label}`}
              disabled={busy}
              onClick={() =>
                task(async () => {
                  await api(
                    `/artifacts/${bundle.artifact.id}/links/${link.id}`,
                    'DELETE',
                  );
                  await onRefresh();
                })
              }
            >
              <X size={12} />
            </IconButton>
          )}
        </div>
      ))}
      {adding && (
        <form onSubmit={add}>
          <Field label="Link label">
            <Input
              name="label"
              required
              maxLength={180}
              placeholder="e.g. Implement onboarding"
            />
          </Field>
          <Field label="HTTPS URL">
            <Input
              name="url"
              required
              type="url"
              pattern="https://.*"
              maxLength={2000}
              placeholder="https://github.com/team/repo/pull/42"
            />
          </Field>
          <Field label="Type">
            <Select name="kind">
              <option value="pull-request">Pull request</option>
              <option value="issue">Issue</option>
              <option value="test">Test</option>
              <option value="reference">Reference</option>
            </Select>
          </Field>
          <Button size="sm" disabled={busy}>
            Add link
          </Button>
        </form>
      )}
    </section>
  );
}

type Revision = {
  version: number;
  actor: string;
  createdAt: string;
  content?: Record<string, any>;
};
type Audit = {
  id: number;
  actor: string;
  action: string;
  detail: string;
  createdAt: string;
};
function readableContent(content: Record<string, any>) {
  return content.doc
    ? docText(content.doc)
    : JSON.stringify(content, null, 2);
}
function HistoryPanel({ bundle, project, onRefresh, onError }: Props) {
  const [history, setHistory] = useState<{
    revisions: Revision[];
    audit: Audit[];
  }>({ revisions: [], audit: [] });
  const [revision, setRevision] = useState<Revision | null>(null);
  const [compare, setCompare] = useState(false);
  const { busy, task, mounted } = useTask(onError);
  const load = useCallback(async () => {
    const result = await api<typeof history>(
      `/artifacts/${bundle.artifact.id}/history`,
    );
    if (mounted.current) setHistory(result);
  }, [bundle.artifact.id, mounted]);
  useEffect(() => {
    void task(load);
  }, [load, task, bundle.artifact.version]);
  async function inspect(version: number) {
    await task(async () => {
      const r = await api<Revision>(
        `/artifacts/${bundle.artifact.id}/history/${version}`,
      );
      if (mounted.current) {
        setRevision(r);
        setCompare(true);
      }
    });
  }
  return (
    <>
      <section className="panel-section">
        <div className="panel-heading">
          <h2>Version history</h2>
          <Badge>v{bundle.artifact.version}</Badge>
        </div>
        <p className="small muted">
          Content revisions and decision changes retain their author.
          Restoring content creates a new revision.
        </p>
        {busy && !history.revisions.length && (
          <Spinner label="Loading history…" />
        )}
        <div className="history-list">
          {history.revisions.map((item) => (
            <button
              className="history-row"
              key={item.version}
              disabled={busy}
              onClick={() => inspect(item.version)}
            >
              <span className="revision-number">v{item.version}</span>
              <span>
                <strong>{item.actor}</strong>
                <small>{date(item.createdAt)}</small>
              </span>
              {item.version === bundle.artifact.version ? (
                <Badge>Current</Badge>
              ) : (
                <ChevronRight size={14} />
              )}
            </button>
          ))}
        </div>
      </section>
      <section className="panel-section">
        <div className="panel-heading">
          <h3>Activity & attribution</h3>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => task(load)}
          >
            <RefreshCw size={12} />
            Refresh
          </Button>
        </div>
        <div className="activity-list">
          {history.audit.map((entry) => (
            <details className="activity-entry" key={entry.id}>
              <summary>
                <span>
                  <strong>{entry.actor}</strong>
                  <small>{entry.action.split('.').join(' · ')}</small>
                </span>
                <time dateTime={entry.createdAt}>
                  {date(entry.createdAt)}
                </time>
              </summary>
              {entry.detail && (
                <pre className="activity-detail">
                  {entry.action === 'decision.updated'
                    ? prettify(entry.detail)
                    : entry.detail}
                </pre>
              )}
            </details>
          ))}
        </div>
      </section>
      <Modal
        open={compare}
        onOpenChange={setCompare}
        title={revision ? `Revision v${revision.version}` : 'Revision'}
        description={
          revision
            ? `${revision.actor} · ${date(revision.createdAt)}`
            : undefined
        }
      >
        {revision?.content && (
          <div className="revision-compare">
            <div>
              <h3>Selected revision · v{revision.version}</h3>
              <pre>{readableContent(revision.content)}</pre>
            </div>
            <div>
              <h3>Current content · v{bundle.artifact.version}</h3>
              <pre>{readableContent(bundle.artifact.content)}</pre>
            </div>
          </div>
        )}
        <div className="dialog-footer">
          <Button variant="outline" onClick={() => setCompare(false)}>
            Close comparison
          </Button>
          <Button
            disabled={
              busy ||
              project.role === 'viewer' ||
              revision?.version === bundle.artifact.version ||
              !revision?.content
            }
            onClick={() =>
              task(async () => {
                await api(`/artifacts/${bundle.artifact.id}`, 'PATCH', {
                  version: bundle.artifact.version,
                  content: revision!.content,
                });
                setCompare(false);
                await onRefresh();
                await load();
              })
            }
          >
            {busy ? 'Restoring…' : 'Restore as new revision'}
          </Button>
        </div>
      </Modal>
    </>
  );
}
function prettify(value: string) {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
