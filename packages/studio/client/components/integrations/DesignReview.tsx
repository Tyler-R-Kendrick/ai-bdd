import { useCallback, useEffect, useRef, useState } from 'react';
import { ScanSearch } from 'lucide-react';
import type { Artifact } from '../../../shared/domain.ts';
import type { DecisionAnswer } from '../../../shared/decision-profile.ts';
import type {
  DesignReviewView,
  ReviewQuestion,
} from '../../../shared/decision-review.ts';
import { api, date } from '../../lib.ts';
import { Badge, Button, Modal, Spinner } from '../ui.tsx';
import { DecisionProfile } from './DecisionProfile.tsx';
import './design-review.css';

function answerLabel(
  answer: DecisionAnswer | undefined,
  question: ReviewQuestion,
) {
  if (!answer) return 'Unavailable';
  if (answer.status !== 'answered')
    return answer.status === 'abstained'
      ? 'Uncertain — abstained'
      : answer.status;
  if (question.kind === 'score' && typeof answer.value === 'number')
    return `${answer.value.toFixed(2)} / ${question.levels.length - 1}`;
  if (typeof answer.value === 'boolean') return answer.value ? 'Yes' : 'No';
  return String(answer.value);
}
export function DesignReview({
  artifact,
  readOnly,
  onDiscuss,
}: {
  artifact: Artifact;
  readOnly: boolean;
  onDiscuss: (passage: { id: string; quote: string }) => void;
}) {
  const [open, setOpen] = useState(false),
    [view, setView] = useState<DesignReviewView | null>(null),
    [selected, setSelected] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const intent = useRef<string | null>(null),
    epoch = useRef(0),
    initialized = useRef(false);
  const load = useCallback(async () => {
    const generation = ++epoch.current,
      data = await api<DesignReviewView>(
        `/artifacts/${artifact.id}/decision-review`,
      );
    if (generation !== epoch.current) return;
    setView(data);
    if (!initialized.current) {
      let bytes = 0;
      setSelected(
        data.passages
          .filter((p) => {
            const count = new TextEncoder().encode(p.quote).length;
            if (count > 6000 || bytes + count > 20000) return false;
            bytes += count;
            return true;
          })
          .slice(0, 8)
          .map((p) => p.id),
      );
      initialized.current = true;
    }
  }, [artifact.id]);
  useEffect(() => {
    if (!open) return;
    void load().catch((e) => setError(e.message));
    const timer = setInterval(
      () => void load().catch((e) => setError(e.message)),
      2500,
    );
    return () => {
      clearInterval(timer);
      epoch.current++;
    };
  }, [open, load]);
  const run = async () => {
    if (busy || readOnly || !selected.length) return;
    intent.current ??= crypto.randomUUID();
    setBusy(true);
    setError('');
    try {
      await api(`/artifacts/${artifact.id}/decision-review`, 'POST', {
        requestId: intent.current,
        blockIds: selected,
      });
      intent.current = null;
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const active = view?.jobs.find((j) =>
    ['queued', 'running'].includes(j.status),
  );
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label="Review design"
      >
        <ScanSearch size={15} />
        <span className="design-review-header-label">Review design</span>
      </Button>
      <Modal open={open} onOpenChange={setOpen} title="Design review">
        <div className="design-review">
          <p>
            Assess selected passages for unresolved choices, missing evidence
            and observable acceptance. Results are advice; document
            prerequisites and human approvals remain authoritative.
          </p>
          <DecisionProfile
            artifactId={artifact.id}
            readOnly={readOnly}
            onChanged={load}
          />
          {error && (
            <p role="alert" className="integration-error">
              {error}
            </p>
          )}
          {!view ? (
            <Spinner label="Loading review context…" />
          ) : (
            <>
              <fieldset
                disabled={busy || readOnly || !!active}
                className="design-review-passages"
              >
                <legend>
                  Passages to assess ({selected.length}/16 selected;{' '}
                  {view.totalPassages} in document)
                </legend>
                {view.passages.map((p) => (
                  <label key={p.id}>
                    <input
                      type="checkbox"
                      checked={selected.includes(p.id)}
                      onChange={(e) => {
                        intent.current = null;
                        setSelected((ids) =>
                          e.target.checked
                            ? [...ids, p.id]
                            : ids.filter((id) => id !== p.id),
                        );
                      }}
                      disabled={
                        !selected.includes(p.id) && selected.length >= 16
                      }
                    />
                    <span>{p.quote}</span>
                  </label>
                ))}
                {!view.passages.length && (
                  <p>
                    Write and save a paragraph before reviewing the design.
                  </p>
                )}
                {view.totalPassages > view.passages.length && (
                  <p>
                    Showing the first {view.passages.length} anchored
                    passages. Split a larger document to assess later
                    sections.
                  </p>
                )}
              </fieldset>
              {view.unavailableReason && (
                <p className="small muted">{view.unavailableReason}</p>
              )}
              <div className="design-review-actions">
                <Button
                  onClick={() => void run()}
                  disabled={
                    busy ||
                    readOnly ||
                    !!active ||
                    !view.available ||
                    !selected.length
                  }
                >
                  {busy ? 'Requesting…' : 'Assess selected passages'}
                </Button>
                <span className="small muted">
                  Only selected text and up to 16 accepted ADR excerpts are
                  sent to the chosen decision provider.
                </span>
              </div>
              {active && (
                <div className="design-review-actions">
                  <Badge>{active.status}</Badge>
                  <Button
                    variant="outline"
                    disabled={readOnly || busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await api(
                          `/artifacts/${artifact.id}/decision-review/${active.id}`,
                          'DELETE',
                        );
                        await load();
                      } catch (e) {
                        setError((e as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Cancel review
                  </Button>
                </div>
              )}
              {view.jobs.map((job) => (
                <section
                  className="design-review-result"
                  key={job.id}
                  aria-label="Design assessment"
                >
                  <div className="design-review-actions">
                    <strong>{date(job.createdAt)}</strong>
                    <Badge>
                      {job.status === 'completed'
                        ? 'Assessment complete'
                        : job.status}
                    </Badge>
                    {job.stale && <Badge tone="amber">Source changed</Badge>}
                  </div>
                  {job.error && <p role="alert">{job.error}</p>}
                  {job.result && (
                    <>
                      <p className="small muted">
                        Source v{job.result.artifactVersion} ·{' '}
                        {job.result.coverage.selected}/
                        {job.result.coverage.available} passages ·{' '}
                        {job.result.coverage.acceptedDecisions}/
                        {job.result.coverage.totalAcceptedDecisions} accepted
                        ADRs.{' '}
                        {job.stale
                          ? 'Run again before using this advice.'
                          : 'No approval or document change was made.'}
                      </p>
                      {job.result.questions.map((q) => {
                        const answer = job.result!.evaluation.answers.find(
                            (a) => a.questionId === q.id,
                          ),
                          passage = job.result!.passages.find(
                            (p) => p.id === q.blockId,
                          );
                        return (
                          <div className="design-review-finding" key={q.id}>
                            <div>
                              <strong>{q.label}</strong>
                              <Badge>{answerLabel(answer, q)}</Badge>
                            </div>
                            {passage && (
                              <blockquote>{passage.quote}</blockquote>
                            )}
                            {q.kind === 'score' && (
                              <p className="small muted">
                                Rubric:{' '}
                                {q.levels
                                  .map((l, i) => `${i} ${l.label}`)
                                  .join(' · ')}
                                . A fractional value is a provider-weighted
                                ordinal score.
                              </p>
                            )}
                            {answer && (
                              <p className="small muted">
                                {answer.probability !== null
                                  ? `Native probability of “yes”: ${(answer.probability * 100).toFixed(1)}%. `
                                  : ''}
                                {answer.confidence !== null
                                  ? `Native confidence: ${(answer.confidence * 100).toFixed(1)}%. `
                                  : ''}
                                {answer.probability === null &&
                                answer.confidence === null
                                  ? 'Native certainty unavailable. '
                                  : ''}
                                {answer.status === 'abstained' &&
                                answer.candidate !== null
                                  ? `Unaccepted candidate: ${String(answer.candidate)}. `
                                  : ''}
                                {answer.error
                                  ? `Outcome: ${answer.error}.`
                                  : ''}
                              </p>
                            )}
                            {passage && (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={readOnly || job.stale}
                                onClick={() => {
                                  onDiscuss({
                                    id: passage.id,
                                    quote: passage.quote.slice(0, 4000),
                                  });
                                  setOpen(false);
                                }}
                              >
                                Discuss this passage
                              </Button>
                            )}
                          </div>
                        );
                      })}
                      <details>
                        <summary>Assessment provenance</summary>
                        <dl>
                          <dt>Provider / model</dt>
                          <dd>
                            {job.result.evaluation.provenance.provider} /{' '}
                            {job.result.evaluation.provenance.model}
                          </dd>
                          <dt>Requested model</dt>
                          <dd>
                            {job.result.evaluation.provenance.requestedModel}
                          </dd>
                          <dt>Mode / policy</dt>
                          <dd>
                            {job.result.evaluation.provenance.mode} /{' '}
                            {job.result.policyVersion}
                          </dd>
                          <dt>Threshold</dt>
                          <dd>
                            {
                              job.result.evaluation.provenance
                                .minimumConfidence
                            }
                          </dd>
                          <dt>Source digest</dt>
                          <dd>{job.result.sourceHash}</dd>
                          <dt>Evaluation</dt>
                          <dd>{job.result.evaluation.id}</dd>
                          <dt>Cache</dt>
                          <dd>
                            {job.result.evaluation.provenance.cachedFrom ??
                              'No prior result reused'}
                          </dd>
                        </dl>
                      </details>
                    </>
                  )}
                </section>
              ))}
            </>
          )}
        </div>
      </Modal>
    </>
  );
}
