import { useCallback, useEffect, useState } from 'react';
import { api, date } from '../lib.ts';
import './account-machines.css';
import { accountMachineTrust } from '../../shared/account-machines.ts';
type Device = {
  id: string;
  label: string;
  status: 'active' | 'revoking' | 'revoked';
  expires: number;
  lastSeen: number;
  createdAt: string;
};
/** Account devices are personal; project authorization and automatic execution consent remain separate. */
export function AccountMachinesPanel() {
  const [machines, setMachines] = useState<Device[]>([]),
    [label, setLabel] = useState('My workstation'),
    [accepted, setAccepted] = useState(false),
    [pairing, setPairing] = useState<{
      code: string;
      expiresAt: string;
    } | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    setMachines(
      (await api<{ machines: Device[] }>('/account-machines')).machines,
    );
  }, []);
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
    const timer = setInterval(() => void refresh().catch(() => {}), 5000);
    return () => clearInterval(timer);
  }, [refresh]);
  const pair = async () => {
    setBusy(true);
    setError('');
    try {
      setPairing(
        await api('/account-machines/pairing', 'POST', {
          label,
          acceptedTrust: true,
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (id: string) => {
    setBusy(true);
    setError('');
    try {
      await api('/account-machines/' + id, 'DELETE');
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="account-machines" aria-label="My connected machines">
      <header>
        <h2>My connected machines</h2>
        <p>
          Connect once and register the local repositories this device may use.
        </p>
      </header>
      <p>{accountMachineTrust}</p>
      {error && <p role="alert">{error}</p>}
      <label>
        Device name
        <input
          value={label}
          maxLength={100}
          onChange={(e) => setLabel(e.target.value)}
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={accepted}
          onChange={(e) => setAccepted(e.target.checked)}
        />
        I understand and authorize this device to serve my explicitly registered
        checkouts.
      </label>
      <button
        disabled={busy || !accepted || !label.trim()}
        onClick={() => void pair()}
      >
        Create private pairing code
      </button>
      {pairing && (
        <div role="status">
          <p>
            Pairing expires {date(pairing.expiresAt)}. Keep this one-time code
            private.
          </p>
          <code style={{ display: 'block', overflowWrap: 'anywhere' }}>
            {pairing.code}
          </code>
          <p>
            Download the connector, then run it with your installed ACP agent
            and one or more explicit checkouts:
          </p>
          <a href="/connector.js" download="studio-connector.mjs">
            Download Studio connector
          </a>
          <pre
            style={{ overflow: 'auto' }}
          >{`STUDIO_API_URL=${location.origin} \\\nSTUDIO_MACHINE_SCOPE=account \\\nSTUDIO_MACHINE_PAIR_CODE=${pairing.code} \\\nSTUDIO_MACHINE_AGENT_COMMAND=/absolute/path/to/your/acp-agent \\\nSTUDIO_MACHINE_AGENT_ARGS='["your-agent-acp-argument"]' \\\nnode studio-connector.mjs --checkout /absolute/path/to/repository`}</pre>
          <p>
            Add another{' '}
            <code>--checkout /absolute/path/to/another-repository</code> for
            each repository. Select the actual ACP launch arguments documented
            by your installed agent. Later runs reuse the private credential
            file; remove the pairing-code variable.
          </p>
          <p>
            The connector uses its ordinary local OS permissions. Permission
            requests are denied unless you explicitly configure allowed tool
            kinds. Worktrees organize edits; use your chosen OS sandbox for
            isolation.
          </p>
        </div>
      )}
      <ul>
        {machines.map((machine) => (
          <li key={machine.id}>
            <strong>{machine.label}</strong> ·{' '}
            {machine.status === 'revoked'
              ? 'Revoked'
              : machine.status === 'revoking'
                ? 'Revoking'
                : machine.lastSeen > Date.now() - 90000
                  ? 'Connected'
                  : 'Offline'}
            {machine.status === 'active' && (
              <>
                <small>
                  {' '}
                  · Credential expires{' '}
                  {date(new Date(machine.expires).toISOString())}
                </small>
                <button disabled={busy} onClick={() => void revoke(machine.id)}>
                  Revoke {machine.label}
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      {!machines.length && (
        <p>
          You have no account machines yet. Existing project-scoped connections
          remain available in their projects.
        </p>
      )}
    </section>
  );
}
