import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import {
  Check,
  Copy,
  ExternalLink,
  Monitor,
  Pause,
  Play,
  Plus,
  RefreshCw,
  X,
} from 'lucide-react';
import type { Artifact, Project } from '../../../shared/domain.ts';
import type {
  AgentJob,
  AgentPolicy,
  DesignMode,
  IntegrationCapabilities,
} from '../../../shared/integrations.ts';
import { api, date, download } from '../../lib.ts';
import {
  Badge,
  Button,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  Textarea,
} from '../ui.tsx';
import './integrations.css';
import { AgentProfile } from './AgentProfile.tsx';

type Context = {
  capabilities: IntegrationCapabilities;
  policy: AgentPolicy;
  jobs: AgentJob[];
  design: any[];
  work: any[];
  machines: any[];
};
type Props = {
  artifact: Artifact;
  project: Project;
  onOpenArtifact: (id: string) => void;
  onRefresh?: () => Promise<void>;
};
const active = (status: string) =>
  ['queued', 'running', 'starting', 'collecting-brief'].includes(status);
const label = (value: string) =>
  value
    .replace(/[-_]/g, ' ')
    .replace(/^./, (character) => character.toUpperCase());
const tone = (value: string) =>
  ['completed', 'succeeded', 'accepted'].includes(value)
    ? ('green' as const)
    : ['failed', 'interrupted', 'rejected', 'brief-failed'].includes(value)
      ? ('red' as const)
      : active(value) || value === 'awaiting-review'
        ? ('amber' as const)
        : ('neutral' as const);
function external(value: unknown) {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return !url.username &&
      !url.password &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' &&
          ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}
const hiddenFields = new Set([
  'externalPluginContext',
  'pluginWorkflowId',
  'briefDraftId',
  'nonce',
  'locale',
  'skip',
  'requestId',
  '_meta',
  'agent',
  'byokProfile',
  'executionMode',
]);
function SchemaFields({
  schema,
  values,
  onChange,
}: {
  schema: any;
  values: Record<string, any>;
  onChange: (key: string, value: any) => void;
}) {
  const properties = Object.entries(schema?.properties ?? {}).filter(
    ([key]) => !hiddenFields.has(key),
  );
  if (!properties.length)
    return (
      <p className="integration-note">
        Open Design will ask for the details of this brief in its next step.
      </p>
    );
  return properties.map(([key, raw]) => {
    const field = raw as any,
      title = field.title ?? label(key.replace(/([a-z])([A-Z])/g, '$1 $2'));
    const required = schema.required?.includes(key);
    if (Array.isArray(field.enum))
      return (
        <Field key={key} label={title}>
          <Select
            required={required}
            value={values[key] ?? ''}
            onChange={(event) => onChange(key, event.target.value)}
          >
            <option value="">Choose {title.toLowerCase()}</option>
            {field.enum.map((value: any, index: number) => (
              <option key={index} value={String(value)}>
                {String(value)}
              </option>
            ))}
          </Select>
        </Field>
      );
    if (field.type === 'boolean')
      return (
        <label key={key} className="integration-check">
          <input
            type="checkbox"
            checked={!!values[key]}
            onChange={(event) => onChange(key, event.target.checked)}
          />
          {title}
        </label>
      );
    if (field.type === 'object' || field.type === 'array')
      return (
        <Field key={key} label={title}>
          <Textarea
            required={required}
            value={
              typeof values[key] === 'string'
                ? values[key]
                : values[key]
                  ? JSON.stringify(values[key], null, 2)
                  : ''
            }
            onChange={(event) => onChange(key, event.target.value)}
            placeholder={field.description ?? 'Structured brief details'}
          />
        </Field>
      );
    return (
      <Field key={key} label={title}>
        {key.toLowerCase().includes('description') ||
        key.toLowerCase().includes('prompt') ? (
          <Textarea
            required={required}
            value={values[key] ?? ''}
            maxLength={20000}
            onChange={(event) => onChange(key, event.target.value)}
          />
        ) : (
          <Input
            required={required}
            type={
              field.type === 'number' || field.type === 'integer'
                ? 'number'
                : 'text'
            }
            value={values[key] ?? ''}
            maxLength={2000}
            onChange={(event) =>
              onChange(
                key,
                field.type === 'number' || field.type === 'integer'
                  ? event.target.value === ''
                    ? ''
                    : Number(event.target.value)
                  : event.target.value,
              )
            }
          />
        )}
      </Field>
    );
  });
}

/** Artifact-scoped integration controls. Mount with key={artifact.id} when switching artifacts. */
export function IntegrationPanel({
  artifact,
  project,
  onOpenArtifact,
  onRefresh,
}: Props) {
  const [context, setContext] = useState<Context | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [machineBrief, setMachineBrief] = useState(''),
    [workKind, setWorkKind] = useState<'implementation' | 'investigation'>(
      'implementation',
    );
  const [pairing, setPairing] = useState<{
      code: string;
      expiresAt: string;
    } | null>(null),
    [machineLabel, setMachineLabel] = useState('My workstation'),
    [copied, setCopied] = useState(false);
  const [pendingTurns, setPendingTurns] = useState(0);
  const [reviewed, setReviewed] = useState<Record<string, boolean>>({});
  const [designMode, setDesignMode] = useState<DesignMode>('cloud'),
    [briefSchema, setBriefSchema] = useState<any>(null),
    [briefValues, setBriefValues] = useState<Record<string, any>>({}),
    [newBrief, setNewBrief] = useState(false);
  const [answers, setAnswers] = useState<Record<string, Record<string, any>>>(
      {},
    ),
    [projects, setProjects] = useState<Record<string, any[]>>({}),
    [profiles, setProfiles] = useState<Record<string, any[]>>({}),
    [selection, setSelection] = useState<
      Record<
        string,
        { projectId?: string; prompt?: string; byokProfile?: string }
      >
    >({}),
    [login, setLogin] = useState<Record<string, any>>({});
  const mounted = useRef(true),
    generation = useRef(0),
    currentId = useRef(artifact.id);
  currentId.current = artifact.id;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  const readOnly = project.role === 'viewer' || artifact.archived;
  const load = useCallback(async () => {
    const request = ++generation.current,
      id = artifact.id;
    const value = await api<Context>(`/artifacts/${id}/integrations`);
    if (
      mounted.current &&
      request === generation.current &&
      currentId.current === id
    )
      setContext(value);
  }, [artifact.id]);
  useEffect(() => {
    void load().catch((value) => {
      if (mounted.current) setError(value.message);
    });
  }, [load, artifact.version]);
  const task = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await work();
      if (mounted.current) {
        await load();
        await onRefresh?.();
      }
    } catch (value) {
      if (mounted.current)
        setError(
          value instanceof Error
            ? value.message
            : 'The action could not be completed. Try again.',
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const hasActive =
    pendingTurns > 0 ||
    (context &&
      (context.jobs.some((job) => active(job.status)) ||
        context.work.some((work) => active(work.status))));
  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(() => {
      void load().catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [hasActive, load]);
  const activeDesigns =
    context?.design
      .filter(
        (flow) =>
          flow.canContinue && ['queued', 'running'].includes(flow.status),
      )
      .map((flow) => flow.id)
      .join(',') ?? '';
  useEffect(() => {
    if (!activeDesigns || !context?.capabilities.openDesign.configured)
      return;
    const timer = setInterval(() => {
      void Promise.all(
        activeDesigns
          .split(',')
          .map((id) =>
            api(`/artifacts/${artifact.id}/open-design/${id}/poll`, 'POST'),
          ),
      ).then(load, (value) => {
        if (mounted.current) setError(value.message);
      });
    }, 30000);
    return () => clearInterval(timer);
  }, [
    activeDesigns,
    artifact.id,
    context?.capabilities.openDesign.configured,
    load,
  ]);
  const retryResearch = (job: AgentJob) => {
    setError('');
    setPendingTurns((value) => value + 1);
    void api(`/artifacts/${artifact.id}/agent`, 'POST', {
      threadId: job.threadId,
      intent: 'research',
      brief: job.brief,
    })
      .then(async () => {
        if (mounted.current) {
          await load();
          await onRefresh?.();
        }
      })
      .catch((value) => {
        if (mounted.current) setError(value.message);
      })
      .finally(() => {
        if (mounted.current)
          setPendingTurns((value) => Math.max(0, value - 1));
      });
  };
  const inspect = async (flowId: string, action: string) => {
    const result = await api(
      `/artifacts/${artifact.id}/open-design/${flowId}/inspect`,
      'POST',
      { action },
    );
    if (action === 'projects')
      setProjects((value) => ({ ...value, [flowId]: result.projects ?? [] }));
    else if (action === 'profiles')
      setProfiles((value) => ({ ...value, [flowId]: result.profiles ?? [] }));
    else setLogin((value) => ({ ...value, [flowId]: result }));
  };
  const beginDesign = (event: FormEvent) => {
    event.preventDefault();
    void task(async () => {
      const values = { ...briefValues };
      for (const [key, field] of Object.entries(
        briefSchema?.properties ?? {},
      ))
        if (
          ['object', 'array'].includes((field as any).type) &&
          typeof values[key] === 'string' &&
          values[key].trim()
        )
          values[key] = JSON.parse(values[key]);
      await api(`/artifacts/${artifact.id}/open-design/brief`, 'POST', {
        mode: designMode,
        locale: navigator.language
          .split('-')
          .map((part, index) => (index === 0 ? part.toLowerCase() : part))
          .join('-'),
        fields: values,
        skip: false,
      });
      setNewBrief(false);
      setBriefValues({});
    });
  };
  if (!context)
    return (
      <div className="integration-panel" aria-label="Artifact connections">
        {error ? (
          <p role="alert" className="integration-error">
            {error}
          </p>
        ) : (
          <Spinner label="Loading artifact connections…" />
        )}
      </div>
    );
  return (
    <div className="integration-panel" aria-label="Artifact connections">
      <div className="integration-heading">
        <div>
          <h3>Connections</h3>
          <p>Agent, research, and machine work stay with this artifact.</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Refresh artifact connections"
          disabled={busy}
          onClick={() => void task(load)}
        >
          <RefreshCw size={15} />
        </Button>
      </div>
      {error && (
        <p role="alert" className="integration-error">
          {error}
        </p>
      )}
      <section
        className="integration-section"
        aria-labelledby={`agent-participation-${artifact.id}`}
      >
        <AgentProfile
          key={artifact.id}
          artifactId={artifact.id}
          readOnly={readOnly}
          onChanged={onRefresh}
        />
        <div className="integration-row">
          <h4 id={`agent-participation-${artifact.id}`}>
            Agent participation
          </h4>
          <Badge tone={context.policy.paused ? 'neutral' : 'purple'}>
            {context.policy.paused ? 'Paused' : label(context.policy.mode)}
          </Badge>
        </div>
        <p className="integration-note">
          Automatic participation waits for a quiet moment in team discussion.
          Anyone with edit access can pause it.
        </p>
        <Field label="Participation mode">
          <Select
            value={context.policy.mode}
            disabled={busy || readOnly}
            onChange={(event) =>
              void task(async () => {
                await api(
                  `/artifacts/${artifact.id}/integrations/policy`,
                  'PUT',
                  { ...context.policy, mode: event.target.value },
                );
              })
            }
          >
            <option value="manual">Only when asked</option>
            <option value="automatic" disabled={!context.capabilities.model}>
              Join the conversation
            </option>
          </Select>
        </Field>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || readOnly}
          onClick={() =>
            void task(async () => {
              await api(
                `/artifacts/${artifact.id}/integrations/policy`,
                'PUT',
                { ...context.policy, paused: !context.policy.paused },
              );
            })
          }
        >
          {context.policy.paused ? <Play size={13} /> : <Pause size={13} />}
          {context.policy.paused ? 'Resume agent' : 'Pause agent'}
        </Button>
        {!context.capabilities.model && (
          <p className="integration-note">
            A workspace owner must configure an AI model before the agent can
            respond.
          </p>
        )}
      </section>
      <section
        className="integration-section"
        aria-labelledby={`research-requests-${artifact.id}`}
      >
        <h4 id={`research-requests-${artifact.id}`}>Research requests</h4>
        <p className="integration-note">
          Successful research becomes a child artifact with its own
          conversation and ADR.{' '}
          {context.capabilities.research.provider === 'wikipedia'
            ? 'The current source corpus is Wikipedia.'
            : 'The workspace uses its configured live source service.'}
        </p>
        {!context.jobs.some((job) => job.intent === 'research') && (
          <p className="integration-empty">
            Choose Research in the conversation composer to submit a brief.
          </p>
        )}
        {context.jobs
          .filter((job) => job.intent === 'research')
          .slice(0, 20)
          .map((job) => (
            <div className="integration-record" key={job.id}>
              <div className="integration-row">
                <strong>{job.brief}</strong>
                <Badge tone={tone(job.status)}>{label(job.status)}</Badge>
              </div>
              <span className="integration-meta">{date(job.createdAt)}</span>
              {job.error && <p className="integration-note">{job.error}</p>}
              {job.childArtifactId && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onOpenArtifact(job.childArtifactId!)}
                >
                  Open research note
                </Button>
              )}
              {!readOnly && active(job.status) && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void task(async () => {
                      await api(
                        `/artifacts/${artifact.id}/integrations/jobs/${job.id}/cancel`,
                        'POST',
                      );
                    })
                  }
                >
                  Cancel request
                </Button>
              )}
              {!readOnly &&
                context.capabilities.model &&
                ['failed', 'cancelled', 'interrupted'].includes(
                  job.status,
                ) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={
                      busy ||
                      pendingTurns > 0 ||
                      context.jobs.some((value) => active(value.status))
                    }
                    onClick={() => retryResearch(job)}
                  >
                    Retry this brief
                  </Button>
                )}
            </div>
          ))}
      </section>
      <section
        className="integration-section"
        aria-labelledby={`connected-machines-${artifact.id}`}
      >
        <div className="integration-row">
          <h4 id={`connected-machines-${artifact.id}`}>Connected machines</h4>
          <Monitor size={15} aria-hidden="true" />
        </div>
        <p className="integration-note">
          Approve implementation or investigation for a coding agent on your
          own machine. Returned changes wait for review.
        </p>
        {context.machines.map((machine) => (
          <div className="integration-machine" key={machine.id}>
            <div>
              <strong>{machine.label}</strong>
              <span>
                {machine.connected ? 'Connected recently' : 'Not connected'}
              </span>
            </div>
            {project.role === 'owner' && (
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Revoke ${machine.label}`}
                disabled={busy}
                onClick={() =>
                  void task(async () => {
                    await api(
                      `/projects/${project.id}/machines/${machine.id}`,
                      'DELETE',
                    );
                  })
                }
              >
                <X size={14} />
              </Button>
            )}
          </div>
        ))}
        {!context.machines.length && (
          <p className="integration-empty">
            No machines are paired with this project.
          </p>
        )}
        {project.role === 'owner' && (
          <div className="integration-connect">
            <Field label="Machine name">
              <Input
                value={machineLabel}
                maxLength={120}
                onChange={(event) => setMachineLabel(event.target.value)}
              />
            </Field>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !machineLabel.trim()}
              onClick={() =>
                void task(async () => {
                  const value = await api(
                    `/projects/${project.id}/machines/pairing`,
                    'POST',
                    { label: machineLabel.trim() },
                  );
                  setPairing(value);
                  setCopied(false);
                })
              }
            >
              <Plus size={13} />
              Pair a machine
            </Button>
          </div>
        )}
        {!readOnly && (
          <form
            className="integration-form"
            onSubmit={(event) => {
              event.preventDefault();
              void task(async () => {
                await api(`/artifacts/${artifact.id}/machine-work`, 'POST', {
                  version: artifact.version,
                  kind: workKind,
                  brief: machineBrief.trim(),
                });
                setMachineBrief('');
              });
            }}
          >
            <Field label="Work type">
              <Select
                value={workKind}
                onChange={(event) =>
                  setWorkKind(event.target.value as typeof workKind)
                }
              >
                <option value="implementation">Implementation</option>
                <option value="investigation">Investigation</option>
              </Select>
            </Field>
            <Field label="Approved brief">
              <Textarea
                value={machineBrief}
                maxLength={20000}
                onChange={(event) => setMachineBrief(event.target.value)}
                placeholder="Describe the work this machine may perform."
              />
            </Field>
            <p className="integration-note">
              This approves work against revision {artifact.version}.{' '}
              {context.machines.some((machine) => machine.connected)
                ? 'A connected machine can claim it.'
                : 'It waits until a paired machine connects.'}
            </p>
            <Button size="sm" disabled={busy || !machineBrief.trim()}>
              Approve machine work
            </Button>
          </form>
        )}
        {context.work.slice(0, 20).map((work) => (
          <div className="integration-record" key={work.id}>
            <div className="integration-row">
              <strong>{label(work.kind)}</strong>
              <Badge tone={tone(work.status)}>{label(work.status)}</Badge>
            </div>
            <p>{work.brief}</p>
            <span className="integration-meta">
              Based on revision {work.version}
            </span>
            {work.error && <p className="integration-note">{work.error}</p>}
            {work.result && (
              <>
                <p>{work.result.summary}</p>
                <p className="integration-note">
                  Supplied by {work.result.suppliedBy}. External results do
                  not verify a server test run.
                </p>
                {external(work.result.pullRequestUrl) && (
                  <a
                    href={external(work.result.pullRequestUrl)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open pull request <ExternalLink size={12} />
                  </a>
                )}
                {work.result.content && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      download(
                        `machine-proposal-${artifact.kind}.json`,
                        JSON.stringify(work.result.content, null, 2),
                      )
                    }
                  >
                    Download full proposal
                  </Button>
                )}
              </>
            )}
            {!readOnly && work.status === 'awaiting-review' && (
              <>
                {work.version !== artifact.version && (
                  <p className="integration-note">
                    The artifact is now at revision {artifact.version}. This
                    result must be compared with the current work before it
                    can be applied.
                  </p>
                )}
                <label className="integration-check">
                  <input
                    type="checkbox"
                    checked={!!reviewed[work.id]}
                    onChange={(event) =>
                      setReviewed((value) => ({
                        ...value,
                        [work.id]: event.target.checked,
                      }))
                    }
                  />
                  I reviewed this result.
                </label>
                <div className="integration-actions">
                  <Button
                    size="sm"
                    disabled={
                      busy ||
                      !reviewed[work.id] ||
                      work.version !== artifact.version
                    }
                    onClick={() =>
                      void task(async () => {
                        await api(
                          `/artifacts/${artifact.id}/machine-work/${work.id}/review`,
                          'POST',
                          { accept: true },
                        );
                      })
                    }
                  >
                    {work.result?.content
                      ? 'Apply proposal'
                      : 'Accept findings'}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void task(async () => {
                        await api(
                          `/artifacts/${artifact.id}/machine-work/${work.id}/review`,
                          'POST',
                          { accept: false },
                        );
                      })
                    }
                  >
                    Reject
                  </Button>
                </div>
              </>
            )}
            {!readOnly && active(work.status) && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void task(async () => {
                    await api(
                      `/artifacts/${artifact.id}/machine-work/${work.id}/cancel`,
                      'POST',
                    );
                  })
                }
              >
                Cancel work
              </Button>
            )}
          </div>
        ))}
      </section>
      <section
        className="integration-section"
        aria-labelledby={`open-design-${artifact.id}`}
      >
        <div className="integration-row">
          <h4 id={`open-design-${artifact.id}`}>Open Design</h4>
          <Badge>
            {context.capabilities.openDesign.configured
              ? 'Configured'
              : 'Not connected'}
          </Badge>
        </div>
        {!context.capabilities.openDesign.configured ? (
          <p className="integration-note">
            Connect the official signed local Open Design application to
            enable its design workflows.{' '}
            <a
              href="https://open-design.ai/download/"
              target="_blank"
              rel="noopener noreferrer"
            >
              Official installation
            </a>
          </p>
        ) : (
          !readOnly && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                void task(async () => {
                  const schemas = await api(
                    `/artifacts/${artifact.id}/open-design/schema`,
                  );
                  setBriefSchema(schemas[0]?.inputSchema ?? {});
                  setNewBrief(true);
                })
              }
            >
              <Plus size={13} />
              New design brief
            </Button>
          )
        )}
        {newBrief && (
          <form className="integration-form" onSubmit={beginDesign}>
            <Field label="Design execution">
              <Select
                value={designMode}
                onChange={(event) =>
                  setDesignMode(event.target.value as DesignMode)
                }
              >
                <option value="cloud">Open Design Cloud</option>
                <option value="local-codex">Local Codex</option>
                <option value="byok">Secure BYOK</option>
              </Select>
            </Field>
            <p className="integration-note">
              {designMode === 'cloud'
                ? 'Usage is billed to your Open Design Cloud account.'
                : designMode === 'byok'
                  ? 'Choose a provider profile already saved securely in Open Design. Your provider account owns usage costs.'
                  : 'Uses the Codex installation already authenticated on the connected machine.'}
            </p>
            <SchemaFields
              schema={briefSchema}
              values={briefValues}
              onChange={(key, value) =>
                setBriefValues((current) => ({ ...current, [key]: value }))
              }
            />
            <div className="integration-actions">
              <Button size="sm" disabled={busy}>
                Collect design brief
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setNewBrief(false)}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
        {context.design.slice(0, 10).map((flow) => {
          const selected = { ...flow.submission, ...selection[flow.id] },
            questions = flow.brief?.questionForm?.questions ?? [],
            information = login[flow.id];
          const destination =
              external(flow.studioUrl) ?? external(flow.previewUrl),
            activation = external(
              information?.activationUrl ??
                information?.verificationUrl ??
                information?.verificationUri,
            );
          return (
            <div className="integration-record" key={flow.id}>
              <div className="integration-row">
                <strong>
                  {flow.mode === 'cloud'
                    ? 'Open Design Cloud'
                    : flow.mode === 'byok'
                      ? 'Secure BYOK'
                      : 'Local Codex'}
                </strong>
                <Badge tone={tone(flow.status)}>{label(flow.status)}</Badge>
              </div>
              {typeof flow.brief?.summary === 'string' && (
                <p>{flow.brief.summary}</p>
              )}
              {flow.submission?.artifactVersion && (
                <span className="integration-meta">
                  Artifact revision {flow.submission.artifactVersion}
                </span>
              )}
              {flow.canContinue &&
                !readOnly &&
                flow.status === 'awaiting-brief' && (
                  <form
                    className="integration-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void task(async () => {
                        await api(
                          `/artifacts/${artifact.id}/open-design/${flow.id}/confirm`,
                          'POST',
                          { answers: answers[flow.id] ?? {} },
                        );
                      });
                    }}
                  >
                    {questions.map((question: any, index: number) => (
                      <Field
                        key={question.id ?? index}
                        label={
                          question.label ??
                          question.question ??
                          `Design detail ${index + 1}`
                        }
                      >
                        <Select
                          required
                          value={answers[flow.id]?.[question.id] ?? ''}
                          onChange={(event) =>
                            setAnswers((value) => ({
                              ...value,
                              [flow.id]: {
                                ...value[flow.id],
                                [question.id]: event.target.value,
                              },
                            }))
                          }
                        >
                          <option value="">Choose an answer</option>
                          {(question.options ?? question.choices ?? []).map(
                            (option: any, optionIndex: number) => (
                              <option
                                key={optionIndex}
                                value={
                                  typeof option === 'string'
                                    ? option
                                    : (option.value ?? option.id)
                                }
                              >
                                {typeof option === 'string'
                                  ? option
                                  : (option.label ??
                                    option.title ??
                                    `Choice ${optionIndex + 1}`)}
                              </option>
                            ),
                          )}
                        </Select>
                      </Field>
                    ))}
                    {!questions.length && (
                      <p className="integration-note">
                        The service returned no additional brief questions in
                        this view.
                      </p>
                    )}
                    <Button size="sm" disabled={busy}>
                      Confirm brief
                    </Button>
                  </form>
                )}
              {flow.canContinue &&
                !readOnly &&
                ['brief-confirmed', 'starting', 'needs-recharge'].includes(
                  flow.status,
                ) && (
                  <div className="integration-form">
                    {flow.mode === 'cloud' && (
                      <>
                        <div className="integration-actions">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              void task(() =>
                                inspect(flow.id, 'login-status'),
                              )
                            }
                          >
                            Check sign-in
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              void task(() => inspect(flow.id, 'start-login'))
                            }
                          >
                            Sign in to Cloud
                          </Button>
                        </div>
                        {information && (
                          <p className="integration-note">
                            {information.authenticated ||
                            information.loggedIn ||
                            information.signedIn ||
                            information.status === 'authenticated'
                              ? 'Open Design Cloud account is signed in.'
                              : 'Complete sign-in before generating.'}
                          </p>
                        )}
                        {activation && (
                          <a
                            href={activation}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Activate Open Design Cloud{' '}
                            <ExternalLink size={12} />
                          </a>
                        )}
                        {information?.userCode && (
                          <p className="integration-note">
                            Activation code:{' '}
                            <strong>{String(information.userCode)}</strong>
                          </p>
                        )}
                      </>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void task(() => inspect(flow.id, 'projects'))
                      }
                    >
                      Load design projects
                    </Button>
                    <Field label="Design project">
                      <Select
                        value={selected.projectId ?? ''}
                        onChange={(event) =>
                          setSelection((value) => ({
                            ...value,
                            [flow.id]: {
                              ...value[flow.id],
                              projectId: event.target.value,
                            },
                          }))
                        }
                      >
                        <option value="">Choose a design project</option>
                        {selected.projectId &&
                          !projects[flow.id]?.some(
                            (project: any) =>
                              (project.id ?? project.projectId) ===
                              selected.projectId,
                          ) && (
                            <option value={selected.projectId}>
                              Previously selected project
                            </option>
                          )}
                        {(projects[flow.id] ?? []).map(
                          (project: any, index: number) => (
                            <option
                              key={project.id ?? project.projectId}
                              value={project.id ?? project.projectId}
                            >
                              {project.title ??
                                project.name ??
                                `Project ${index + 1}`}
                            </option>
                          ),
                        )}
                      </Select>
                    </Field>
                    {flow.mode === 'byok' && (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            void task(() => inspect(flow.id, 'profiles'))
                          }
                        >
                          Load saved provider profiles
                        </Button>
                        <Field label="Secure provider profile">
                          <Select
                            value={selected.byokProfile ?? ''}
                            onChange={(event) =>
                              setSelection((value) => ({
                                ...value,
                                [flow.id]: {
                                  ...value[flow.id],
                                  byokProfile: event.target.value,
                                },
                              }))
                            }
                          >
                            <option value="">Choose a saved profile</option>
                            {selected.byokProfile &&
                              !profiles[flow.id]?.some(
                                (profile: any) =>
                                  (profile.id ?? profile.profileId) ===
                                  selected.byokProfile,
                              ) && (
                                <option value={selected.byokProfile}>
                                  Previously selected provider
                                </option>
                              )}
                            {(profiles[flow.id] ?? []).map(
                              (profile: any, index: number) => (
                                <option
                                  key={profile.id ?? profile.profileId}
                                  value={profile.id ?? profile.profileId}
                                >
                                  {profile.label ??
                                    profile.name ??
                                    `Profile ${index + 1}`}
                                </option>
                              ),
                            )}
                          </Select>
                        </Field>
                      </>
                    )}
                    <Field label="Generation request">
                      <Textarea
                        value={selected.prompt ?? ''}
                        onChange={(event) =>
                          setSelection((value) => ({
                            ...value,
                            [flow.id]: {
                              ...value[flow.id],
                              prompt: event.target.value,
                            },
                          }))
                        }
                        maxLength={20000}
                        placeholder="Describe the design to create from this artifact."
                      />
                    </Field>
                    <p className="integration-note">
                      Shares the selected artifact’s bounded source with this
                      execution mode. Uploaded files remain private
                      references.
                    </p>
                    <Button
                      size="sm"
                      disabled={
                        busy ||
                        !selected.projectId ||
                        !selected.prompt?.trim() ||
                        (flow.mode === 'byok' && !selected.byokProfile)
                      }
                      onClick={() =>
                        void task(async () => {
                          await api(
                            `/artifacts/${artifact.id}/open-design/${flow.id}/start`,
                            'POST',
                            {
                              projectId: selected.projectId,
                              prompt: selected.prompt,
                              ...(selected.byokProfile
                                ? { byokProfile: selected.byokProfile }
                                : {}),
                              resume: flow.status === 'needs-recharge',
                            },
                          );
                        })
                      }
                    >
                      {flow.status === 'needs-recharge'
                        ? 'Resume after completed recharge'
                        : flow.status === 'starting'
                          ? 'Retry the same request'
                          : 'Generate design'}
                    </Button>
                  </div>
                )}
              {flow.status === 'needs-recharge' &&
                external(flow.result?.rechargeUrl) && (
                  <a
                    href={external(flow.result.rechargeUrl)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open account recharge <ExternalLink size={12} />
                  </a>
                )}
              {destination && (
                <a
                  href={destination}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open in Open Design <ExternalLink size={12} />
                </a>
              )}
              {flow.status === 'succeeded' && !destination && (
                <p className="integration-note">
                  The design completed, but the service returned no usable
                  delivery link.
                </p>
              )}
              {flow.canContinue &&
                ['queued', 'running'].includes(flow.status) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void task(async () => {
                        await api(
                          `/artifacts/${artifact.id}/open-design/${flow.id}/poll`,
                          'POST',
                        );
                      })
                    }
                  >
                    Refresh generation
                  </Button>
                )}
              {flow.canContinue &&
                !readOnly &&
                ['queued', 'running'].includes(flow.status) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void task(async () => {
                        await api(
                          `/artifacts/${artifact.id}/open-design/${flow.id}/cancel`,
                          'POST',
                        );
                      })
                    }
                  >
                    Cancel generation
                  </Button>
                )}
            </div>
          );
        })}
      </section>
      <Modal
        open={!!pairing}
        onOpenChange={(open) => {
          if (!open) setPairing(null);
        }}
        title="Pair your machine"
        description="This one-time code connects a coding agent you control to this project. Keep it private."
      >
        {pairing && (
          <div className="integration-form">
            <Field label="One-time pairing code">
              <Input
                value={pairing.code}
                readOnly
                type="password"
                autoComplete="off"
              />
            </Field>
            <p className="integration-note">
              Expires {date(pairing.expiresAt)}. Enter it through the local
              worker’s secret environment, then use the private saved
              credential for later connections.
            </p>
            <Button
              onClick={() => {
                void navigator.clipboard.writeText(pairing.code).then(
                  () => setCopied(true),
                  () =>
                    setError(
                      'The browser could not copy this code. Select and copy it from the field.',
                    ),
                );
              }}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? 'Copied' : 'Copy pairing code'}
            </Button>
          </div>
        )}
      </Modal>
    </div>
  );
}
