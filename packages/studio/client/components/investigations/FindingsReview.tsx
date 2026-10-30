import { useEffect, useState } from 'react';
import { api, date } from '../../lib.ts';
import type { FindingsReviewView } from '../../../shared/findings-review.ts';

export function FindingsReview({
  investigationId,
  artifactVersion,
  canWrite,
  currentUserId,
  onApplied,
}: {
  investigationId: string;
  artifactVersion: number;
  canWrite: boolean;
  currentUserId: string;
  onApplied: () => void | Promise<void>;
}) {
  const [view, setView] = useState<FindingsReviewView | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [confirmed, setConfirmed] = useState<string | null>(null);
  const refresh = async () =>
    setView(
      await api<FindingsReviewView>(
        `/investigations/${investigationId}/findings`,
      ),
    );
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const next = await api<FindingsReviewView>(
          `/investigations/${investigationId}/findings`,
        );
        if (live) setView(next);
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 2500);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [investigationId]);
  const action = async (path: string, method: string, body?: unknown) => {
    setBusy(true);
    setError('');
    try {
      await api(path, method, body);
      setConfirmed(null);
      await refresh();
      await onApplied();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="findings-review"
      aria-label="Apply investigation findings"
    >
      <h4>Apply findings</h4>
      <p>
        Review measured findings as a proposed document edit. Human choices stay
        unanswered until someone decides.
      </p>
      {error && <p role="alert">{error}</p>}
      {view?.pending && (
        <p role="status">
          Review pending
          {view.pending.error
            ? `: ${view.pending.error}`
            : ' until edits settle.'}
        </p>
      )}
      {view && !view.owner && (
        <p role="status">
          Waiting for an existing Planner owner. Claim Planner ownership in chat
          to continue.
        </p>
      )}
      {view?.owner && <small>Planner owner: {view.owner.name}</small>}
      {canWrite && (
        <button
          disabled={busy || !view?.owner || view.owner.userId !== currentUserId}
          onClick={() =>
            void action(`/investigations/${investigationId}/findings`, 'POST', {
              requestId: crypto.randomUUID(),
            })
          }
        >
          Ask Planner to apply findings
        </button>
      )}
      {view?.reviews.map((review) => (
        <article key={review.id} aria-label="Findings proposal">
          <header>
            <strong>
              {review.status === 'accepted'
                ? 'Applied by a person'
                : review.status === 'completed'
                  ? 'Review ready'
                  : review.status}
            </strong>{' '}
            · {review.automatic ? 'Automatic review' : 'Requested review'} ·{' '}
            {date(review.createdAt)}
          </header>
          {review.stale && review.status !== 'accepted' && (
            <p role="status">This proposal is stale. Ask for a fresh review.</p>
          )}
          {review.error && <p role="status">{review.error}</p>}
          {review.eligibility && !review.proposal && (
            <p>
              Decision model: {review.eligibility.status}
              {review.eligibility.value !== null
                ? ` (${review.eligibility.value ? 'update suggested' : 'no update suggested'})`
                : ''}
              . The implementation requirement remains until a person
              incorporates the evidence.
            </p>
          )}
          {review.proposal && (
            <>
              <p>{review.proposal.summary}</p>
              {review.proposal.edits.map((edit) => (
                <div key={edit.blockId}>
                  <p>
                    <strong>Before:</strong> {edit.original}
                  </p>
                  <p>
                    <strong>Proposed:</strong> {edit.replacement}
                  </p>
                  <blockquote>Measured evidence: {edit.evidence}</blockquote>
                </div>
              ))}
              {review.proposal.questions.map((question, index) => (
                <div key={index}>
                  <strong>Human choice: {question.question}</strong>
                  <p>{question.context}</p>
                  <ul>
                    {question.options.map((option) => (
                      <li key={option}>{option}</li>
                    ))}
                  </ul>
                </div>
              ))}
              {canWrite &&
                review.status === 'completed' &&
                !review.stale &&
                (review.proposal.edits.length > 0 ||
                  review.proposal.questions.length > 0) && (
                  <>
                    <label>
                      <input
                        type="checkbox"
                        checked={confirmed === review.id}
                        onChange={(e) =>
                          setConfirmed(e.target.checked ? review.id : null)
                        }
                      />
                      I reviewed the evidence and this exact edit. Incorporate
                      these findings; leave proposed choices unanswered.
                    </label>
                    <button
                      disabled={busy || confirmed !== review.id}
                      onClick={() =>
                        void action(
                          `/investigations/${investigationId}/findings/${review.id}/accept`,
                          'POST',
                          { version: artifactVersion },
                        )
                      }
                    >
                      Apply reviewed findings
                    </button>
                  </>
                )}
            </>
          )}
          {canWrite && ['queued', 'running'].includes(review.status) && (
            <button
              disabled={busy}
              onClick={() =>
                void action(
                  `/investigations/${investigationId}/findings/${review.id}`,
                  'DELETE',
                )
              }
            >
              Stop findings review
            </button>
          )}
        </article>
      ))}
    </section>
  );
}
