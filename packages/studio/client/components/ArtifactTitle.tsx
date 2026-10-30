import { useState } from 'react';
import type { Artifact } from '../../shared/domain.ts';
import { api } from '../lib.ts';
import { Button, Field, Input, Modal } from './ui.tsx';

export function ArtifactTitle({
  artifact,
  readOnly,
  refresh,
  report,
}: {
  artifact: Artifact;
  readOnly: boolean;
  refresh: () => Promise<unknown>;
  report: (message: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false);
  const [title, setTitle] = useState(artifact.title),
    [automatic, setAutomatic] = useState(false),
    [seedGoal, setSeedGoal] = useState(false),
    [available, setAvailable] = useState(false);
  async function edit() {
    setBusy(true);
    try {
      // Claim before editing starts, so an in-flight model can never overwrite it.
      const policy = await api<{ available: boolean }>(
        `/artifacts/${artifact.id}/title-policy`,
        'PATCH',
        { mode: 'human' },
      );
      setAvailable(policy.available);
      setAutomatic(false);
      setSeedGoal(false);
      setTitle(artifact.title);
      setOpen(true);
    } catch (error) {
      report((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api(`/artifacts/${artifact.id}/title`, 'PATCH', {
        title: title.trim(),
      });
      if (automatic)
        await api(`/artifacts/${artifact.id}/title-policy`, 'PATCH', {
          mode: 'automatic',
          seedGoal,
        });
      await refresh();
      setOpen(false);
    } catch (error) {
      report((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        className="artifact-title"
        disabled={readOnly || busy}
        title={readOnly ? undefined : 'Rename artifact'}
        onClick={() => void edit()}
      >
        {artifact.title}
      </button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Artifact title"
        description="Choose a title for this artifact. Titles you choose stay yours unless you enable automatic updates."
      >
        <form onSubmit={save} className="form-stack">
          <Field label="Title">
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={180}
              required
              autoFocus
            />
          </Field>
          <label className="small">
            <input
              type="checkbox"
              checked={automatic}
              disabled={!available || busy}
              onChange={(event) => {
                setAutomatic(event.target.checked);
                if (!event.target.checked) setSeedGoal(false);
              }}
            />{' '}
            Maintain the title from this discussion
          </label>
          {['design', 'document'].includes(artifact.kind) && (
            <label className="small">
              <input
                type="checkbox"
                checked={seedGoal}
                disabled={!automatic || !available || busy}
                onChange={(event) => setSeedGoal(event.target.checked)}
              />{' '}
              Add a goal from this discussion only while the document body is
              empty
            </label>
          )}
          {!available && (
            <p className="muted small">
              Connect a model to enable automatic titles.
            </p>
          )}
          <div className="dialog-actions">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !title.trim()}>
              {busy ? 'Saving…' : 'Save title'}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
