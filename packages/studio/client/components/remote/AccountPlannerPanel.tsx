import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib.ts';
import {
  plannerViewSchema,
  type PlannerView,
} from '../../../shared/account-planners.ts';
import './account-planner.css';

export type AccountPlannerPanelProps = {
  artifactId: string;
  artifactVersion: number;
  readOnly: boolean;
  onError?: (message: string) => void;
  onChanged?: () => void;
};
const descriptions = {
  queued: 'Queued for your device. It will start when the device is free.',
  claimed:
    'Assigned to your device. Conversation activity shows when a turn runs.',
  idle: 'The session stopped after inactivity. Launch again when you need it.',
  stopped: 'The session stopped. You can launch a new session.',
  failed:
    'The session could not continue. Review the connector before launching again.',
  revoked:
    'This assignment was revoked. Review device access before launching again.',
  stale:
    'The source or configuration changed. Launch again from this revision.',
} as const;

export function AccountPlannerPanel(props: AccountPlannerPanelProps) {
  const { artifactId, artifactVersion, readOnly } = props;
  const scope = artifactId + ':' + artifactVersion;
  const current = useRef(scope);
  current.current = scope;
  const callbacks = useRef(props);
  callbacks.current = props;
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const [loaded, setLoaded] = useState<{
    scope: string;
    view: PlannerView;
  } | null>(null);
  const [selection, setSelection] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      const response = await fetch(
        '/api/artifacts/' + artifactId + '/planners',
        { credentials: 'same-origin', signal: controller.signal },
      );
      const value = await response.json();
      if (!response.ok)
        throw new Error(value.error ?? 'Planner devices are unavailable');
      const view = plannerViewSchema.parse(value);
      if (view.assignment && view.assignment.artifactId !== artifactId)
        throw new Error(
          'The Planner response belongs to another artifact. Refresh before continuing.',
        );
      if (
        !mounted.current ||
        controller.signal.aborted ||
        current.current !== scope
      )
        return;
      setLoaded({ scope, view });
      setSelection((previous) =>
        view.devices.some((device) => device.id === previous)
          ? previous
          : (view.assignment?.deviceId ??
            view.devices.find((device) => device.status === 'available')?.id ??
            view.devices[0]?.id ??
            ''),
      );
    } catch (error) {
      if (
        !mounted.current ||
        controller.signal.aborted ||
        current.current !== scope
      )
        return;
      setError((error as Error).message);
    }
  }, [artifactId, scope]);
  useEffect(() => {
    mounted.current = true;
    setLoaded(null);
    setError('');
    setBusy(false);
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      request.current?.abort();
    };
  }, [refresh]);
  const view = loaded?.scope === scope ? loaded.view : null;
  const assignment = view?.assignment;
  const active =
    assignment?.status === 'queued' || assignment?.status === 'claimed';
  const device = view?.devices.find((device) => device.id === selection);
  const canLaunch =
    !!view?.enabled &&
    !readOnly &&
    !view.blockedByOtherWriter &&
    !!device &&
    ['available', 'busy'].includes(device.status) &&
    !active &&
    !busy;
  const perform = async (stop: boolean) => {
    if (!view || readOnly || busy || (!stop && !canLaunch) || (stop && !active))
      return;
    const captured = scope;
    setBusy(true);
    setError('');
    try {
      if (stop && assignment)
        await api(
          `/artifacts/${artifactId}/planners/${assignment.id}/stop`,
          'POST',
          { epoch: assignment.epoch },
        );
      else
        await api(`/artifacts/${artifactId}/planners`, 'POST', {
          deviceId: selection,
          artifactVersion,
        });
      if (!mounted.current || current.current !== captured) return;
      await refresh();
      if (!mounted.current || current.current !== captured) return;
      callbacks.current.onChanged?.();
    } catch (error) {
      if (!mounted.current || current.current !== captured) return;
      const message = (error as Error).message;
      setError(message);
      callbacks.current.onError?.(message);
    } finally {
      if (mounted.current && current.current === captured) setBusy(false);
    }
  };
  return (
    <section
      className="account-planner-panel"
      aria-label="Planner on your device"
    >
      <header>
        <div>
          <h3>Planner on your device</h3>
          <p>Use your own installed ACP agent for this artifact.</p>
        </div>
        <span className="account-planner-model">Agent controls the model</span>
      </header>
      {error && (
        <p role="alert" className="account-planner-error">
          {error}
        </p>
      )}
      {!view && !error && <p role="status">Loading your devices…</p>}
      {view && (
        <>
          {readOnly ? (
            <p>
              You have read-only access. An editor can launch their own device.
            </p>
          ) : !view.enabled ? (
            <p>Remote device launch is unavailable for this artifact.</p>
          ) : view.blockedByOtherWriter ? (
            <p>
              Another writer currently owns this Planner. Device launch is
              unavailable.
            </p>
          ) : (
            <>
              {assignment && (
                <p
                  role="status"
                  className="account-planner-state"
                  data-state={assignment.status}
                >
                  {view.devices.find(
                    (device) => device.id === assignment.deviceId,
                  )?.label && (
                    <strong>
                      {
                        view.devices.find(
                          (device) => device.id === assignment.deviceId,
                        )!.label
                      }
                      <br />
                    </strong>
                  )}
                  {descriptions[assignment.status]}
                </p>
              )}
              {!active && (
                <label>
                  Your connected device
                  <select
                    value={selection}
                    disabled={busy || !view.devices.length}
                    onChange={(event) => setSelection(event.target.value)}
                  >
                    {!view.devices.length && (
                      <option value="">No eligible device connected</option>
                    )}
                    {view.devices.map((device) => (
                      <option key={device.id} value={device.id}>
                        {device.label} · {device.status}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {!active && device?.reason && (
                <p className="account-planner-reason">{device.reason}</p>
              )}
              <div className="account-planner-actions">
                {active ? (
                  <button disabled={busy} onClick={() => void perform(true)}>
                    {busy ? 'Stopping…' : 'Stop device session'}
                  </button>
                ) : (
                  <button
                    disabled={!canLaunch}
                    onClick={() => void perform(false)}
                  >
                    {busy
                      ? 'Requesting…'
                      : assignment
                        ? device?.status === 'busy'
                          ? 'Queue again'
                          : 'Launch again'
                        : device?.status === 'busy'
                          ? 'Queue on device'
                          : 'Launch on device'}
                  </button>
                )}
              </div>
              {!view.devices.length && !active && (
                <p>
                  Connect a device from My connected machines and register this
                  repository.
                </p>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
