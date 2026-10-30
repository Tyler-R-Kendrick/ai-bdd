import { useCallback, useEffect, useId, useState } from 'react';
import type {
  ConversationCard,
  ConversationView,
} from '../../../shared/conversation.ts';
import { api } from '../../lib.ts';
import { Badge, Button, Textarea } from '../ui.tsx';
import './conversation.css';

/** The operator capability is queried from the server. Disabled installations render no suggestion controls. */
export function ConversationCards({
  artifactId,
  artifactVersion,
  threadId,
  readOnly,
  onChanged,
  onError,
}: {
  artifactId: string;
  artifactVersion: number;
  threadId: string;
  readOnly: boolean;
  onChanged?: () => void;
  onError?: (error: unknown) => void;
}) {
  const [view, setView] = useState<ConversationView | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const base = `/artifacts/${artifactId}/conversation`;
  const load = useCallback(async () => {
    const next = await api<ConversationView>(
      `${base}?threadId=${encodeURIComponent(threadId)}`,
    );
    setView(next);
  }, [base, threadId]);
  useEffect(() => {
    let active = true;
    setView(null);
    setError('');
    const refresh = async () => {
      try {
        const next = await api<ConversationView>(
          `${base}?threadId=${encodeURIComponent(threadId)}`,
        );
        if (active) setView(next);
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [base, threadId, artifactVersion]);
  const act = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await operation();
      await load();
      onChanged?.();
    } catch (e) {
      setError((e as Error).message);
      onError?.(e);
    } finally {
      setBusy(false);
    }
  };
  if (!view?.enabled)
    return error ? (
      <p role="alert" className="conversation-error">
        {error}
      </p>
    ) : null;
  const pending = view.jobs.find(
      (j) => j.status === 'queued' || j.status === 'running',
    ),
    failed = view.jobs[0]?.status === 'failed' ? view.jobs[0] : null;
  return (
    <section
      className="conversation-offers"
      aria-label="Conversation suggestions"
    >
      <div className="conversation-offers-heading">
        <strong>Conversation suggestions</strong>
        <Badge tone="purple">AI proposals</Badge>
      </div>
      <p>
        Review questions and research briefs suggested from this discussion.
      </p>
      {!view.modelConfigured && (
        <p>Configure a model to analyze this discussion.</p>
      )}
      {pending && <p role="status">Analysis {pending.status}…</p>}
      {failed && (
        <p role="alert" className="conversation-error">
          Analysis failed: {failed.error}
        </p>
      )}
      {error && (
        <p role="alert" className="conversation-error">
          {error}
        </p>
      )}
      {!readOnly && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !!pending || !view.modelConfigured}
          onClick={() =>
            void act(() =>
              api(`${base}/analyze`, 'POST', { threadId, retry: true }),
            )
          }
        >
          Analyze discussion
        </Button>
      )}
      {view.cards
        .filter((c) => c.status !== 'dismissed')
        .map((card) => (
          <Offer
            key={card.id}
            card={card}
            artifactVersion={artifactVersion}
            readOnly={readOnly}
            busy={busy}
            act={act}
            base={base}
          />
        ))}
      {!view.cards.length && !pending && <p>No suggestions yet.</p>}
    </section>
  );
}
function Offer({
  card,
  artifactVersion,
  readOnly,
  busy,
  act,
  base,
}: {
  card: ConversationCard;
  artifactVersion: number;
  readOnly: boolean;
  busy: boolean;
  act: (operation: () => Promise<unknown>) => Promise<void>;
  base: string;
}) {
  const [brief, setBrief] = useState(card.brief),
    label = useId();
  useEffect(() => {
    setBrief(card.brief);
  }, [card.id, card.version, card.brief]);
  const resolved = card.status === 'published' || card.status === 'started',
    blocked =
      readOnly ||
      busy ||
      resolved ||
      (card.stale && card.status !== 'starting');
  const body = { cardVersion: card.version, artifactVersion };
  return (
    <article className="conversation-offer">
      <div className="conversation-offers-heading">
        <strong>{card.title}</strong>
        <Badge>{card.status}</Badge>
      </div>
      <p>{card.rationale}</p>
      <details>
        <summary>Discussion source · version {card.artifactVersion}</summary>
        <blockquote>{card.sourceQuote}</blockquote>
        <p>
          Proposed by {card.createdBy}. {card.evidenceMessageIds.length} cited
          message{card.evidenceMessageIds.length === 1 ? '' : 's'}.
        </p>
      </details>
      {card.stale && !resolved && (
        <p className="conversation-stale">
          The document or discussion changed. Analyze it again before
          publishing.
        </p>
      )}
      {card.error && (
        <p role="alert" className="conversation-error">
          {card.error}
        </p>
      )}
      {card.kind === 'decision' ? (
        <>
          <p>
            <strong>{card.question}</strong>
          </p>
          <ul>
            {card.options.map((option) => (
              <li key={option}>{option}</li>
            ))}
          </ul>
          <p>
            Publishing creates a questionnaire in a document, or a proposed ADR
            for another artifact. Acceptance is a separate review.
          </p>
          <Button
            size="sm"
            disabled={blocked}
            onClick={() =>
              void act(() =>
                api(`${base}/cards/${card.id}/publish`, 'POST', body),
              )
            }
          >
            {resolved ? 'Published' : 'Publish for review'}
          </Button>
        </>
      ) : (
        <>
          <label htmlFor={label}>Exact research brief</label>
          <Textarea
            id={label}
            maxLength={4000}
            value={brief}
            disabled={blocked || card.status === 'starting'}
            onChange={(e) => setBrief(e.target.value)}
          />
          <p>This exact brief is saved when you explicitly start research.</p>
          <Button
            size="sm"
            disabled={blocked || !brief.trim()}
            onClick={() =>
              void act(() =>
                api(`${base}/cards/${card.id}/start-research`, 'POST', {
                  ...body,
                  brief,
                }),
              )
            }
          >
            {card.status === 'started'
              ? 'Research started'
              : card.status === 'starting'
                ? 'Retry approved research'
                : 'Start research'}
          </Button>
          {card.jobId && (
            <p>
              Request <code>{card.jobId}</code>. Execution and evidence appear
              in the artifact’s integration jobs.
            </p>
          )}
        </>
      )}
      {!readOnly && card.status === 'proposed' && (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void act(() =>
              api(`${base}/cards/${card.id}/dismiss`, 'POST', body),
            )
          }
        >
          Dismiss
        </Button>
      )}
      {card.updatedBy && (
        <p className="conversation-attribution">Reviewed by {card.updatedBy}</p>
      )}
    </article>
  );
}
