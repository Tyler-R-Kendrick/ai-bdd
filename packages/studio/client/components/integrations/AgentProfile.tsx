import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type {
  AgentProfile as Profile,
  AgentProfileView,
} from '../../../shared/agent-profile.ts';
import { api } from '../../lib.ts';
import { Badge, Button, Field, Select, Spinner } from '../ui.tsx';
import './agent-profile.css';
export function AgentProfile({
  artifactId,
  readOnly,
  onChanged,
}: {
  artifactId: string;
  readOnly: boolean;
  onChanged?: () => void | Promise<void>;
}) {
  const [view, setView] = useState<AgentProfileView | null>(null),
    [draft, setDraft] = useState<Profile | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false),
    request = useRef(0),
    label = useId();
  const load = useCallback(async () => {
    const sequence = ++request.current;
    const value = await api<AgentProfileView>(
      `/artifacts/${artifactId}/agent/profile`,
    );
    if (sequence !== request.current) return;
    setView(value);
    setDraft(value.profile);
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
  const save = async () => {
    if (!draft || readOnly || busy) return;
    setBusy(true);
    setSaved(false);
    setError('');
    try {
      const value = await api<AgentProfileView>(
        `/artifacts/${artifactId}/agent/profile`,
        'PUT',
        draft,
      );
      setView(value);
      setDraft(value.profile);
      setSaved(true);
      await onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const dirty =
      !!draft &&
      !!view &&
      JSON.stringify(draft) !== JSON.stringify(view.profile),
    harness = view?.harnesses.find((h) => h.id === draft?.harness),
    provider = harness?.providers.find((p) => p.id === draft?.provider),
    available = !!harness?.configured;
  return (
    <section
      className="integration-section agent-profile"
      aria-labelledby={label}
    >
      <div className="integration-row">
        <h4 id={label}>Agent runtime</h4>
        {draft && (
          <Badge tone={available ? 'green' : 'neutral'}>
            {available ? 'Available' : 'Offline'}
          </Badge>
        )}
      </div>
      <p>Choose the harness, provider, and model for this artifact.</p>
      {!view || !draft ? (
        <>
          {error ? (
            <p role="alert" className="integration-error">
              {error}
            </p>
          ) : (
            <Spinner label="Loading agent runtime…" />
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => void load().catch((e) => setError(e.message))}
          >
            Refresh runtime capabilities
          </Button>
        </>
      ) : (
        <>
          <Field label="Agent harness">
            <Select
              aria-label="Agent harness"
              disabled={readOnly || busy}
              value={draft.harness}
              onChange={(e) => {
                const next = view.harnesses.find(
                  (h) => h.id === e.target.value,
                )!;
                const first = next.providers[0];
                setDraft({
                  harness: next.id,
                  provider: first?.id ?? '',
                  model: first?.models[0] ?? '',
                });
                setSaved(false);
              }}
            >
              {!harness && (
                <option value={draft.harness}>
                  {draft.harness} · unavailable
                </option>
              )}
              {view.harnesses.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.label}
                  {h.id === view.defaultHarness ? ' (default)' : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Model provider">
            <Select
              aria-label="Model provider"
              disabled={readOnly || busy || !harness?.providers.length}
              value={draft.provider}
              onChange={(e) => {
                const next = harness?.providers.find(
                  (p) => p.id === e.target.value,
                );
                setDraft({
                  ...draft,
                  provider: e.target.value,
                  model: next?.models[0] ?? '',
                });
                setSaved(false);
              }}
            >
              {!provider && (
                <option value={draft.provider}>
                  {draft.provider || 'No provider configured'} · unavailable
                </option>
              )}
              {harness?.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Model">
            <Select
              aria-label="Agent model"
              disabled={readOnly || busy || !provider?.models.length}
              value={draft.model}
              onChange={(e) => {
                setDraft({ ...draft, model: e.target.value });
                setSaved(false);
              }}
            >
              {!provider?.models.includes(draft.model) && (
                <option value={draft.model}>
                  {draft.model || 'No model configured'} · unavailable
                </option>
              )}
              {provider?.models.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </Select>
          </Field>
          {!harness && (
            <p className="agent-profile-offline">
              This saved harness is unavailable. Choose and save another harness
              before invoking the agent.
            </p>
          )}
          {harness?.reason && (
            <p
              className={
                available ? 'integration-note' : 'agent-profile-offline'
              }
            >
              {harness.reason}
            </p>
          )}
          <p className="integration-note">
            {view.requiresExplicitFallback
              ? 'Another harness is used only after you explicitly select and save it.'
              : 'The selected harness handles this artifact’s requests.'}
          </p>
          {!readOnly && (
            <div className="agent-profile-actions">
              <Button
                size="sm"
                disabled={busy || !dirty || !draft.provider || !draft.model}
                onClick={() => void save()}
              >
                {busy ? 'Saving runtime…' : 'Save agent runtime'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setSaved(false);
                  void load().catch((e) => setError(e.message));
                }}
              >
                Refresh capabilities
              </Button>
            </div>
          )}
          {saved && !dirty && <p role="status">Agent runtime saved.</p>}
          {dirty && <p role="status">Runtime changes have not been saved.</p>}
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
