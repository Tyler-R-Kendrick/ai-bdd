import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type {
  DecisionProfile as Profile,
  DecisionProfileView,
} from '../../../shared/decision-profile.ts';
import { api } from '../../lib.ts';
import { Badge, Button, Field, Input, Select, Spinner } from '../ui.tsx';
import './decision-profile.css';
/** Finite classification has its own persisted provider/model, independent of the generative agent harness. */
export function DecisionProfile({
  artifactId,
  readOnly,
  onChanged,
}: {
  artifactId: string;
  readOnly: boolean;
  onChanged?: () => void | Promise<void>;
}) {
  const [view, setView] = useState<DecisionProfileView | null>(null),
    [draft, setDraft] = useState<Profile | null>(null),
    [confidence, setConfidence] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false),
    request = useRef(0),
    label = useId();
  const apply = (value: DecisionProfileView) => {
    setView(value);
    setDraft(value.profile);
    setConfidence(String(value.profile.minimumConfidence));
  };
  const load = useCallback(async () => {
    const sequence = ++request.current,
      value = await api<DecisionProfileView>(
        `/artifacts/${artifactId}/decision/profile`,
      );
    if (sequence !== request.current) return;
    apply(value);
    setError('');
  }, [artifactId]);
  useEffect(() => {
    setView(null);
    setDraft(null);
    setError('');
    setSaved(false);
    void load().catch((e) => setError((e as Error).message));
    return () => {
      request.current++;
    };
  }, [load]);
  const minimum = Number(confidence),
    validConfidence =
      confidence.trim() !== '' &&
      Number.isFinite(minimum) &&
      minimum >= 0.5 &&
      minimum <= 1;
  const candidate = draft ? { ...draft, minimumConfidence: minimum } : null,
    dirty =
      !!candidate &&
      !!view &&
      JSON.stringify(candidate) !== JSON.stringify(view.profile),
    provider = view?.providers.find((p) => p.id === draft?.provider);
  const save = async () => {
    if (!candidate || !validConfidence || readOnly || busy) return;
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const value = await api<DecisionProfileView>(
        `/artifacts/${artifactId}/decision/profile`,
        'PUT',
        candidate,
      );
      apply(value);
      setSaved(true);
      await onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="integration-section decision-profile"
      aria-labelledby={label}
    >
      <div className="integration-row">
        <h4 id={label}>Decision models</h4>
        {draft && (
          <Badge tone={provider?.configured ? 'green' : 'neutral'}>
            {provider?.configured ? 'Available' : 'Offline'}
          </Badge>
        )}
      </div>
      <p>
        Use these models for yes/no, choice, and rating questions. Chat and
        prose generation use the artifact’s agent runtime.
      </p>
      {!view || !draft ? (
        <>
          {error ? (
            <p role="alert" className="integration-error">
              {error}
            </p>
          ) : (
            <Spinner label="Loading decision models…" />
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => void load().catch((e) => setError(e.message))}
          >
            Refresh decision models
          </Button>
        </>
      ) : (
        <>
          <Field label="Decision provider">
            <Select
              aria-label="Decision provider"
              value={draft.provider}
              disabled={readOnly || busy}
              onChange={(e) => {
                const next = view.providers.find(
                  (p) => p.id === e.target.value,
                )!;
                setDraft({
                  ...draft,
                  provider: next.id,
                  model: next.models[0] ?? '',
                });
                setSaved(false);
              }}
            >
              {!provider && (
                <option value={draft.provider}>
                  {draft.provider} · unavailable
                </option>
              )}
              {view.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Decision model">
            <Select
              aria-label="Decision model"
              value={draft.model}
              disabled={readOnly || busy || !provider?.models.length}
              onChange={(e) => {
                setDraft({ ...draft, model: e.target.value });
                setSaved(false);
              }}
            >
              {!provider?.models.includes(draft.model) && (
                <option value={draft.model}>
                  {draft.model || 'No models registered'} · unavailable
                </option>
              )}
              {provider?.models.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Minimum decision confidence">
            <Input
              aria-label="Minimum decision confidence"
              type="number"
              min="0.5"
              max="1"
              step="0.01"
              value={confidence}
              disabled={readOnly || busy}
              onChange={(e) => {
                setConfidence(e.target.value);
                setSaved(false);
              }}
            />
          </Field>
          {!validConfidence && (
            <p role="alert" className="integration-error">
              Choose a confidence threshold from 0.5 to 1.
            </p>
          )}
          {provider && (
            <p>
              <Badge tone="purple">
                {provider.mode === 'native-decision'
                  ? 'Native decision API'
                  : 'Structured generation'}
              </Badge>
            </p>
          )}
          {provider?.reason && (
            <p
              className={
                provider.configured
                  ? 'integration-note'
                  : 'decision-profile-offline'
              }
            >
              {provider.reason}
            </p>
          )}
          {!provider?.models.length && (
            <p className="decision-profile-offline">
              No models are registered for this provider.
            </p>
          )}
          <p className="integration-note">
            Provider-reported probabilities and confidence retain their meaning.
            Uncertain or refused decisions remain explicit. Another provider is
            used only after you select and save it.
          </p>
          {!readOnly && (
            <div className="decision-profile-actions">
              <Button
                size="sm"
                disabled={
                  busy ||
                  !dirty ||
                  !validConfidence ||
                  !draft.model ||
                  !provider?.models.includes(draft.model)
                }
                onClick={() => void save()}
              >
                {busy ? 'Saving decision model…' : 'Save decision model'}
              </Button>
              {dirty ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    apply(view);
                    setSaved(false);
                    setError('');
                  }}
                >
                  Reset decision changes
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setSaved(false);
                    void load().catch((e) => setError(e.message));
                  }}
                >
                  Refresh decision capabilities
                </Button>
              )}
            </div>
          )}
          {dirty && (
            <p role="status">Decision model changes have not been saved.</p>
          )}
          {saved && !dirty && <p role="status">Decision model saved.</p>}
          {error && (
            <p role="alert" className="integration-error">
              {error}
            </p>
          )}
        </>
      )}
    </section>
  );
}
