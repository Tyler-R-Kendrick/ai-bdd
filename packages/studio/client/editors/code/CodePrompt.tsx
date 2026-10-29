import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { api } from '../../lib.ts';
import { Button, Input, Spinner } from '../../components/ui.tsx';
export function CodePrompt({
  artifactId,
  readOnly,
  dirty,
  onError,
}: {
  artifactId: string;
  readOnly: boolean;
  dirty: boolean;
  onError: (message: string) => void;
}) {
  const [available, setAvailable] = useState(false),
    [prompt, setPrompt] = useState(''),
    [running, setRunning] = useState(false),
    [notice, setNotice] = useState('');
  useEffect(() => {
    let live = true;
    api('/capabilities')
      .then((value) => {
        if (live) setAvailable(!!value.agent);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  async function propose(event: React.FormEvent) {
    event.preventDefault();
    if (!prompt.trim() || !available || dirty || readOnly) return;
    setRunning(true);
    setNotice('');
    try {
      const bundle = await api(`/artifacts/${artifactId}`),
        thread = bundle.threads.find((value: any) => !value.anchor);
      if (!thread) throw new Error('This artifact has no main conversation');
      await api(`/artifacts/${artifactId}/messages`, 'POST', {
        threadId: thread.id,
        body: `Code change request: ${prompt.trim()}\nReturn a reviewed proposal containing the complete files and entry object. Keep imports within artifact files and installed browser packages. Use contracts.json for integration boundaries; never invent passing tests or run package installation scripts. Preserve unrelated files.`,
      });
      await api(`/artifacts/${artifactId}/agent`, 'POST', {
        threadId: thread.id,
        intent: 'edit',
      });
      setPrompt('');
      setNotice(
        'Open Chat to review the agent response and any proposed code changes.',
      );
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setRunning(false);
    }
  }
  return (
    <>
      <form className="code-prompt" onSubmit={propose}>
        <Sparkles size={15} />
        <Input
          aria-label="Describe code change"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          disabled={readOnly || !available || dirty || running}
          maxLength={3000}
          placeholder={
            dirty
              ? 'Save your changes before requesting a proposal'
              : available
                ? 'Describe a change to this artifact…'
                : 'Configure a model to propose code changes'
          }
        />
        <Button
          size="sm"
          disabled={
            readOnly || !available || dirty || running || !prompt.trim()
          }
        >
          {running ? <Spinner label="Preparing proposal…" /> : 'Propose change'}
        </Button>
      </form>
      {notice && (
        <div className="code-project-notice" role="status">
          {notice}
        </div>
      )}
    </>
  );
}
