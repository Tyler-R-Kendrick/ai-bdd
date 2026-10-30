import { useCallback, useEffect, useState } from 'react';
import { GitBranch, LoaderCircle, Unplug } from 'lucide-react';
import { Button } from './ui.tsx';
import { api } from '../lib.ts';
import type { RepositoryIdentityStatus } from '../../shared/identity.ts';
export default function RepositoryIdentity({
  onChanged,
  onError,
}: {
  onChanged?: () => void;
  onError?: (message: string) => void;
}) {
  const [status, setStatus] = useState<RepositoryIdentityStatus | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      setStatus(await api<RepositoryIdentityStatus>('/identity/repository'));
      setError('');
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const fail = (cause: unknown) => {
    const message = (cause as Error).message;
    setError(message);
    onError?.(message);
  };
  async function connect() {
    setBusy(true);
    setError('');
    try {
      const result = await api<{ authorizationUrl: string }>(
        '/identity/github/start',
        'POST',
        { returnTo: location.pathname + location.search },
      );
      location.assign(result.authorizationUrl);
    } catch (cause) {
      fail(cause);
      setBusy(false);
    }
  }
  async function disconnect() {
    setBusy(true);
    setError('');
    try {
      await api('/identity/github', 'DELETE');
      await load();
      onChanged?.();
      window.dispatchEvent(new CustomEvent('repository-identity-changed'));
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="repository-identity"
      aria-label="GitHub repository identity"
    >
      <div className="flex items-center gap-2">
        <GitBranch size={17} />
        <h3 className="font-medium">GitHub account</h3>
      </div>
      {!status && !error ? (
        <p role="status" className="flex items-center gap-2 text-sm">
          <LoaderCircle size={14} className="spin" />
          Checking your connection…
        </p>
      ) : (
        status && (
          <>
            <p className="small muted">
              {status.connected
                ? `Connected as ${status.login}.`
                : status.login
                  ? `Your connection as ${status.login} needs to be renewed.`
                  : 'Connect your own account to open repository-backed projects.'}
            </p>
            <p className="small muted">
              Project membership and your GitHub pull or push permissions both
              apply. Another team member’s credentials do not grant you
              repository access.
            </p>
            {status.connected && status.expiresAt && (
              <p className="small muted">
                Access expires {new Date(status.expiresAt).toLocaleString()}
                {status.refreshAvailable
                  ? ' and can refresh automatically.'
                  : '.'}
              </p>
            )}
            {!status.configured && (
              <p className="small muted">
                The workspace owner has not configured GitHub account
                connections.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !status.configured}
                onClick={connect}
              >
                {busy ? (
                  <LoaderCircle className="spin" size={14} />
                ) : (
                  <GitBranch size={14} />
                )}
                {status.connected ? 'Reconnect GitHub' : 'Connect GitHub'}
              </Button>
              {status.login && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={disconnect}
                >
                  <Unplug size={14} />
                  Disconnect
                </Button>
              )}
            </div>
          </>
        )
      )}
      {error && (
        <div role="alert">
          <p className="small">{error}</p>
          <Button size="sm" variant="ghost" disabled={busy} onClick={load}>
            Retry connection check
          </Button>
        </div>
      )}
    </section>
  );
}
