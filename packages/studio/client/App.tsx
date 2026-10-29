import RepositoryIdentity from './components/RepositoryIdentity.tsx';
import { ArtifactTitle } from './components/ArtifactTitle.tsx';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { STUDIO_LAYOUT, studioLayout } from '../verification/layout.ts';
import {
  PanelsTopLeft,
  Search,
  Plus,
  ChevronDown,
  ChevronRight,
  FileText,
  Code2,
  Image,
  Film,
  Box,
  Ruler,
  Palette,
  LayoutTemplate,
  BookOpen,
  GitBranch,
  Settings,
  LogOut,
  Menu,
  PanelRightClose,
  PanelRightOpen,
  Share2,
  Check,
  Network,
  ArrowUpRight,
  MoreHorizontal,
  Download,
  Archive,
  History,
  ClipboardCheck,
} from 'lucide-react';
import { api, ApiError } from './lib.ts';
import {
  Button,
  IconButton,
  Input,
  Textarea,
  Select,
  Field,
  Modal,
  Badge,
  Spinner,
  ErrorBoundary,
} from './components/ui.tsx';
import { Login } from './components/Login.tsx';
import { DocumentEditor } from './editors/DocumentEditor.tsx';
import { DetailPanel } from './components/DetailPanel.tsx';
import { ProjectCanvas } from './editors/ProjectCanvas.tsx';
import { ShareDialog } from './components/ShareDialog.tsx';
import {
  artifactKinds,
  kindLabels,
  type Artifact,
  type Project,
  type User,
} from '../shared/domain.ts';
const CodeEditor = lazy(() => import('./editors/CodeEditor.tsx'));
const VisualEditor = lazy(() => import('./editors/VisualEditor.tsx'));
const VideoEditor = lazy(() => import('./editors/VideoEditor.tsx'));
const SceneEditor = lazy(() => import('./editors/SceneEditor.tsx'));
const GenerativeEditor = lazy(() => import('./editors/GenerativeEditor.tsx'));
export const kindIcons = {
  design: BookOpen,
  document: FileText,
  code: Code2,
  image: Image,
  video: Film,
  scene: Box,
  cad: Ruler,
  brand: Palette,
  ui: LayoutTemplate,
};
export type Bundle = {
  artifact: Artifact;
  threads: any[];
  messages: any[];
  decisions: any[];
  runs: any[];
  links: any[];
  agentActive: boolean;
  runnerActive: boolean;
};
export type MediaProps = {
  artifact: Artifact;
  readOnly: boolean;
  onSave: (content: Record<string, any>, version: number) => Promise<void>;
  onDirty: (value: boolean) => void;
  onError: (error: string) => void;
};
function locationSelection() {
  const q = new URLSearchParams(window.location.search);
  return {
    project: q.get('project') ?? '',
    artifact: q.get('artifact') ?? '',
    canvas: q.get('view') === 'canvas',
  };
}
export function App() {
  const [user, setUser] = useState<User | null | undefined>(),
    [projects, setProjects] = useState<Project[]>([]),
    [artifacts, setArtifacts] = useState<Artifact[]>([]),
    [bundle, setBundle] = useState<Bundle | null>(null),
    [selection, setSelection] = useState(locationSelection),
    [error, setError] = useState(''),
    [capabilities, setCapabilities] = useState<any>({}),
    [loading, setLoading] = useState(false),
    [dirty, setDirty] = useState(false);
  const [newProject, setNewProject] = useState(false),
    [newArtifact, setNewArtifact] = useState(false),
    [share, setShare] = useState(false),
    [command, setCommand] = useState(false),
    [query, setQuery] = useState(''),
    [rightOpen, setRightOpen] = useState(window.innerWidth >= 1280),
    [sideOpen, setSideOpen] = useState(false),
    [panel, setPanel] = useState('chat'),
    [anchor, setAnchor] = useState<{ id: string; quote: string } | null>(
      null,
    ),
    [settings, setSettings] = useState(false),
    [more, setMore] = useState(false),
    [busy, setBusy] = useState(false);
  const project = projects.find((p) => p.id === selection.project),
    artifact = bundle?.artifact,
    readOnly = project?.role === 'viewer';
  const currentSelection = useRef(selection);
  currentSelection.current = selection;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const selectedURL = useRef(window.location.href);
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  useEffect(() => {
    const resize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  const layout = studioLayout(viewportWidth, rightOpen);
  const detailOverlay = viewportWidth < STUDIO_LAYOUT.detailBreakpoint;
  useEffect(() => {
    if (detailOverlay) setRightOpen(false);
  }, [detailOverlay]);
  const sidebarRef = useRef<HTMLElement>(null),
    navigationToggleRef = useRef<HTMLButtonElement>(null);
  const sidebarOverlay = viewportWidth < STUDIO_LAYOUT.sidebarBreakpoint;
  useEffect(() => {
    if (!sideOpen || !sidebarOverlay) return;
    const first = () =>
      sidebarRef.current?.querySelector<HTMLElement>(
        'button:not(:disabled),a[href]',
      );
    const frame = requestAnimationFrame(() => first()?.focus());
    const key = (event: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"]')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        setSideOpen(false);
        requestAnimationFrame(() => navigationToggleRef.current?.focus());
      }
      if (
        event.key === 'Tab' &&
        sidebarRef.current?.contains(document.activeElement)
      ) {
        const items = [
          ...sidebarRef.current.querySelectorAll<HTMLElement>(
            'button:not(:disabled),a[href]',
          ),
        ].filter((e) => e.getClientRects().length);
        if (event.shiftKey && document.activeElement === items[0]) {
          event.preventDefault();
          items.at(-1)?.focus();
        } else if (
          !event.shiftKey &&
          document.activeElement === items.at(-1)
        ) {
          event.preventDefault();
          items[0]?.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', key);
      if (sidebarRef.current?.contains(document.activeElement))
        navigationToggleRef.current?.focus();
    };
  }, [sideOpen, sidebarOverlay]);
  const report = useCallback((message: string) => setError(message), []);
  const navigate = useCallback(
    (project: string, artifact = '', canvas = false) => {
      if (
        dirty &&
        !window.confirm('You have unsaved changes. Leave this artifact?')
      )
        return;
      setDirty(false);
      setBundle(null);
      setSelection({ project, artifact, canvas });
      const q = new URLSearchParams();
      if (project) q.set('project', project);
      if (artifact) q.set('artifact', artifact);
      if (canvas) q.set('view', 'canvas');
      window.history.pushState({}, '', '?' + q);
      selectedURL.current = window.location.href;
      setSideOpen(false);
      setAnchor(null);
    },
    [dirty],
  );
  useEffect(() => {
    api<User>('/me')
      .then(setUser)
      .catch((e) => {
        if (!(e instanceof ApiError && e.status === 401)) report(e.message);
        setUser(null);
      });
  }, [report]);
  useEffect(() => {
    const pop = () => {
      if (
        dirtyRef.current &&
        !window.confirm('You have unsaved changes. Leave this artifact?')
      ) {
        window.history.pushState({}, '', selectedURL.current);
        return;
      }
      dirtyRef.current = false;
      setDirty(false);
      selectedURL.current = window.location.href;
      setSelection(locationSelection());
      setBundle(null);
    };
    window.addEventListener('popstate', pop);
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommand((v) => !v);
      }
    };
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('popstate', pop);
      window.removeEventListener('keydown', key);
    };
  }, []);
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', before);
    return () => window.removeEventListener('beforeunload', before);
  }, [dirty]);
  const refreshProjects = useCallback(async () => {
    if (!user) return;
    const ps = await api<Project[]>('/projects');
    setProjects(ps);
    return ps;
  }, [user]);
  const refresh = useCallback(async () => {
    if (!selection.project || !user) return;
    const snapshot = selection;
    const [list, b] = await Promise.all([
      api<Artifact[]>(`/projects/${selection.project}/artifacts`),
      selection.artifact
        ? api<Bundle>(`/artifacts/${selection.artifact}`)
        : Promise.resolve(null),
    ]);
    if (
      currentSelection.current.project !== snapshot.project ||
      currentSelection.current.artifact !== snapshot.artifact
    )
      return;
    setArtifacts(list);
    if (b) setBundle(b);
  }, [selection.project, selection.artifact, user]);
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    Promise.all([refreshProjects(), api('/capabilities')])
      .then(([ps, c]) => {
        if (cancelled) return;
        setCapabilities(c);
        if (!selection.project && ps?.length)
          navigate(ps[0]!.id, ps[0]!.mainArtifactId);
      })
      .catch((e) => report(e.message));
    return () => {
      cancelled = true;
    };
  }, [user, refreshProjects]);
  useEffect(() => {
    if (!user || !selection.project) return;
    let active = true;
    setLoading(true);
    refresh()
      .catch((e) => {
        if (active) report(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [refresh, user]);
  useEffect(() => {
    if (!user || !selection.project) return;
    let socket: WebSocket | undefined,
      timer: ReturnType<typeof setTimeout> | undefined,
      refreshTimer: ReturnType<typeof setTimeout> | undefined,
      stopped = false;
    const connect = () => {
      socket = new WebSocket(
        `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/projects/${selection.project}/events`,
      );
      socket.onmessage = () => {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
          void refresh().catch((e) => report(e.message));
        }, 250);
      };
      socket.onclose = () => {
        if (!stopped) timer = setTimeout(connect, 3000);
      };
      socket.onerror = () => socket?.close();
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(refreshTimer);
      socket?.close();
    };
  }, [selection.project, user, refresh, report]);
  async function createProject(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    try {
      const p = await api<Project>(
        '/projects',
        'POST',
        Object.fromEntries(new FormData(e.currentTarget)),
      );
      await refreshProjects();
      setNewProject(false);
      navigate(p.id, p.mainArtifactId);
    } catch (e) {
      report((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function createArtifact(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!project) return;
    setBusy(true);
    try {
      const a = await api<Artifact>(
        `/projects/${project.id}/artifacts`,
        'POST',
        Object.fromEntries(new FormData(e.currentTarget)),
      );
      setNewArtifact(false);
      navigate(project.id, a.id);
    } catch (e) {
      report((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save(content: Record<string, any>, version: number) {
    if (!artifact) return;
    try {
      await api(`/artifacts/${artifact.id}`, 'PATCH', { version, content });
      setDirty(false);
      await refresh();
    } catch (e) {
      report((e as Error).message);
      throw e;
    }
  }
  if (user === undefined)
    return (
      <div className="app-loading">
        <Spinner label="Opening your workspace…" />
      </div>
    );
  if (user === null) return <Login onLogin={setUser} />;
  const KindIcon = artifact ? kindIcons[artifact.kind] : BookOpen;
  const mediaProps = artifact
    ? { artifact, readOnly, onSave: save, onDirty: setDirty, onError: report }
    : null;
  return (
    <div
      className={
        'studio ' +
        (sideOpen ? 'sidebar-open ' : '') +
        (!rightOpen ? 'panel-closed' : '')
      }
      style={
        {
          '--sidebar-width': `${STUDIO_LAYOUT.sidebarWidth}px`,
          '--detail-width': `${STUDIO_LAYOUT.detailWidth}px`,
          gridTemplateColumns: `${layout.sidebarWidth ? layout.sidebarWidth + 'px ' : ''}minmax(0,1fr)${layout.detailWidth ? ' ' + layout.detailWidth + 'px' : ''}`,
        } as React.CSSProperties
      }
    >
      <a className="skip-link" href="#artifact-workspace">
        Skip to artifact
      </a>
      <aside
        className="sidebar"
        id="project-navigation"
        ref={sidebarRef}
        aria-label="Project navigation"
        inert={sidebarOverlay && !sideOpen}
        aria-hidden={sidebarOverlay && !sideOpen ? true : undefined}
      >
        <div className="wordmark">
          <PanelsTopLeft size={22} />
          <strong>ai-bdd</strong>
          <span>Studio</span>
          <IconButton
            label="Search artifacts"
            onClick={() => setCommand(true)}
          >
            <Search size={16} />
          </IconButton>
        </div>
        <button className="workspace-switch" onClick={() => setCommand(true)}>
          <span className="workspace-icon">
            {project?.title.slice(0, 1).toUpperCase() ?? 'W'}
          </span>
          <span>
            {project?.title ?? 'Your workspace'}
            <small>
              {projects.length}{' '}
              {projects.length === 1 ? 'project' : 'projects'}
            </small>
          </span>
          <ChevronDown size={14} />
        </button>
        <div className="nav-group">
          <button
            className={'nav-link ' + (selection.canvas ? 'active' : '')}
            onClick={() => project && navigate(project.id, '', true)}
            disabled={!project}
          >
            <Network size={16} />
            Project canvas
            <ChevronRight size={13} />
          </button>
          <button
            className="nav-link"
            onClick={() => {
              setPanel('tests');
              setRightOpen(true);
              if (project) navigate(project.id, project.mainArtifactId);
            }}
            disabled={!project}
          >
            <ClipboardCheck size={16} />
            Acceptance tests
          </button>
        </div>
        <div className="nav-section">
          <span>Artifacts</span>
          <IconButton
            label="New artifact"
            onClick={() => setNewArtifact(true)}
            disabled={!project || readOnly}
          >
            <Plus size={15} />
          </IconButton>
        </div>
        <nav className="artifact-nav">
          {artifacts.map((a) => {
            const Icon = kindIcons[a.kind];
            return (
              <button
                className={
                  'artifact-link ' +
                  (selection.artifact === a.id && !selection.canvas
                    ? 'active'
                    : '')
                }
                key={a.id}
                onClick={() => navigate(a.projectId, a.id)}
              >
                <Icon size={16} />
                <span>{a.title}</span>
                {a.id === project?.mainArtifactId && (
                  <span className="main-dot" title="Main design document" />
                )}
              </button>
            );
          })}
          {!project && (
            <p className="nav-empty">
              Create a project to start composing artifacts.
            </p>
          )}
        </nav>
        <div className="sidebar-bottom">
          {project?.repository && (
            <a
              className="nav-link"
              href={project.repository}
              target="_blank"
              rel="noreferrer"
            >
              <GitBranch size={16} />
              <span>{project.repository.split('/').slice(-2).join('/')}</span>
              <ArrowUpRight size={13} />
            </a>
          )}
          <button className="nav-link" onClick={() => setNewProject(true)}>
            <Plus size={16} />
            New project
          </button>
          <button className="nav-link" onClick={() => setSettings(true)}>
            <Settings size={16} />
            Workspace settings
          </button>
          <div className="user-row">
            <span className="avatar" style={{ background: user.color }}>
              {user.name
                .split(' ')
                .map((s) => s[0])
                .slice(0, 2)
                .join('')}
            </span>
            <span>
              {user.name}
              <small>{user.email}</small>
            </span>
            <IconButton
              label="Sign out"
              onClick={() =>
                api('/auth/logout', 'POST').then(() => {
                  setUser(null);
                  setProjects([]);
                  setArtifacts([]);
                  setBundle(null);
                })
              }
            >
              <LogOut size={15} />
            </IconButton>
          </div>
        </div>
      </aside>
      {sideOpen && (
        <button
          className="sidebar-scrim"
          aria-label="Close navigation"
          onClick={() => setSideOpen(false)}
        />
      )}
      <main
        className="workspace"
        id="artifact-workspace"
        inert={sidebarOverlay && sideOpen}
      >
        <header className="topbar">
          <IconButton
            ref={navigationToggleRef}
            label="Toggle navigation"
            className="mobile-menu"
            aria-expanded={!sidebarOverlay || sideOpen}
            aria-controls="project-navigation"
            onClick={() => setSideOpen((v) => !v)}
          >
            <Menu />
          </IconButton>
          <span className="breadcrumb">
            {project?.title ?? 'Workspace'}
            <ChevronRight size={13} />
            <span>
              {selection.canvas
                ? 'Canvas'
                : (artifact?.title ?? 'Getting started')}
            </span>
          </span>
          <div className="topbar-actions">
            {project && (
              <>
                <span className="collab-note">
                  <span className="status-dot" />
                  Shared workspace
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setShare(true)}
                >
                  <Share2 size={14} />
                  Share
                </Button>
              </>
            )}
            <IconButton
              label={
                rightOpen ? 'Hide artifact panel' : 'Show artifact panel'
              }
              onClick={() => setRightOpen((v) => !v)}
            >
              {rightOpen ? <PanelRightClose /> : <PanelRightOpen />}
            </IconButton>
          </div>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <Button variant="ghost" size="sm" onClick={() => setError('')}>
              Dismiss
            </Button>
          </div>
        )}
        <div className="workspace-body" inert={detailOverlay && rightOpen}>
          {!project ? (
            <div className="welcome">
              <div className="welcome-symbol">
                <PanelsTopLeft size={34} />
              </div>
              <h1>
                Every artifact.
                <br />
                One shared context.
              </h1>
              <p>
                Start with a design document. Bring the code, visuals, tests,
                and decisions into the same project.
              </p>
              <Button onClick={() => setNewProject(true)}>
                <Plus />
                Create a project
              </Button>
              <div className="welcome-types">
                {[BookOpen, Code2, Image, Film, Box].map((Icon, i) => (
                  <Icon size={22} key={i} />
                ))}
              </div>
            </div>
          ) : selection.canvas ? (
            <ErrorBoundary resetKey={project.id}>
              <ProjectCanvas
                artifacts={artifacts}
                project={project}
                onOpen={(id) => navigate(project.id, id)}
                onCreate={() => setNewArtifact(true)}
              />
            </ErrorBoundary>
          ) : loading && !artifact ? (
            <div className="app-loading">
              <Spinner label="Opening artifact…" />
            </div>
          ) : artifact ? (
            <>
              <div className="artifact-header">
                <div>
                  <div className="artifact-kind">
                    <KindIcon size={14} />
                    {kindLabels[artifact.kind]}
                    {readOnly && <Badge>View only</Badge>}
                  </div>
                  <ArtifactTitle
                    key={artifact.id}
                    artifact={artifact}
                    readOnly={readOnly}
                    refresh={refresh}
                    report={report}
                  />
                </div>
                <div className="artifact-actions">
                  {!['design', 'document'].includes(artifact.kind) && (
                    <span className="save-status">
                      {dirty ? (
                        'Unsaved changes'
                      ) : (
                        <>
                          <Check size={13} />
                          Saved
                        </>
                      )}
                    </span>
                  )}
                  <div className="more-menu">
                    <IconButton
                      label="Artifact actions"
                      onClick={() => setMore((v) => !v)}
                    >
                      <MoreHorizontal />
                    </IconButton>
                    {more && (
                      <div className="menu-popover">
                        <a
                          href={`/api/artifacts/${artifact.id}/export`}
                          download
                          onClick={() => setMore(false)}
                        >
                          <Download size={14} />
                          Export artifact
                        </a>
                        <button
                          onClick={() => {
                            setPanel('history');
                            setRightOpen(true);
                            setMore(false);
                          }}
                        >
                          <History size={14} />
                          Version history
                        </button>
                        {project.role === 'owner' &&
                          artifact.id !== project.mainArtifactId && (
                            <button
                              onClick={() => {
                                setMore(false);
                                api(
                                  `/artifacts/${artifact.id}/archive`,
                                  'POST',
                                )
                                  .then(() =>
                                    navigate(
                                      project.id,
                                      project.mainArtifactId,
                                    ),
                                  )
                                  .catch((e) => report(e.message));
                              }}
                            >
                              <Archive size={14} />
                              Archive artifact
                            </button>
                          )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <div className="artifact-content">
                <ErrorBoundary resetKey={artifact.id}>
                  <Suspense
                    fallback={
                      <div className="app-loading">
                        <Spinner label="Loading editor…" />
                      </div>
                    }
                  >
                    {artifact.kind === 'design' ||
                    artifact.kind === 'document' ? (
                      <DocumentEditor
                        key={artifact.id}
                        artifact={artifact}
                        user={user}
                        readOnly={readOnly}
                        runs={bundle.runs}
                        onDecisions={() => {
                          setPanel('decisions');
                          setRightOpen(true);
                        }}
                        onTests={() => {
                          setPanel('tests');
                          setRightOpen(true);
                        }}
                        onComment={(id, quote) => {
                          setAnchor({ id, quote });
                          setPanel('chat');
                          setRightOpen(true);
                        }}
                        onError={report}
                      />
                    ) : artifact.kind === 'code' ? (
                      <CodeEditor key={artifact.id} {...mediaProps!} />
                    ) : artifact.kind === 'video' ? (
                      <VideoEditor key={artifact.id} {...mediaProps!} />
                    ) : artifact.kind === 'image' ||
                      artifact.kind === 'brand' ? (
                      <VisualEditor key={artifact.id} {...mediaProps!} />
                    ) : artifact.kind === 'scene' ||
                      artifact.kind === 'cad' ? (
                      <SceneEditor key={artifact.id} {...mediaProps!} />
                    ) : (
                      <GenerativeEditor key={artifact.id} {...mediaProps!} />
                    )}
                  </Suspense>
                </ErrorBoundary>
              </div>
            </>
          ) : (
            <div className="empty-state">
              <h2>Choose an artifact</h2>
              <p>Open the main design document to continue.</p>
              <Button
                onClick={() => navigate(project.id, project.mainArtifactId)}
              >
                Open design document
              </Button>
            </div>
          )}
        </div>
      </main>
      {rightOpen && project && (
        <aside className="detail-panel" aria-label="Artifact details">
          {bundle && !selection.canvas ? (
            <DetailPanel
              bundle={bundle}
              project={project}
              user={user}
              capabilities={capabilities}
              panel={panel}
              onPanel={setPanel}
              onRefresh={refresh}
              onError={report}
              anchor={anchor}
              onClearAnchor={() => setAnchor(null)}
              onOpenArtifact={(id) => navigate(project.id, id)}
            />
          ) : (
            <div className="project-notes">
              <Network size={22} />
              <h2>Built together.</h2>
              <p>
                Projects are compositions of artifacts. Open any artifact to
                see its dedicated discussion, decisions, and evidence.
              </p>
              <div className="project-summary">
                <span>{artifacts.length} artifacts</span>
                <span>
                  {
                    artifacts.filter((a) =>
                      ['design', 'document'].includes(a.kind),
                    ).length
                  }{' '}
                  {artifacts.filter((a) =>
                    ['design', 'document'].includes(a.kind),
                  ).length === 1
                    ? 'document'
                    : 'documents'}
                </span>
              </div>
              <p className="small muted">
                {project.description ||
                  'Add project context in workspace settings.'}
              </p>
            </div>
          )}
        </aside>
      )}
      <Modal
        open={newProject}
        onOpenChange={setNewProject}
        title="Create a project"
        description="A design document, dedicated chat, and ADR are created with your project."
      >
        <form onSubmit={createProject}>
          <Field label="Project name">
            <Input
              name="title"
              placeholder="e.g. Customer onboarding"
              autoFocus
              required
              maxLength={180}
            />
          </Field>
          <Field label="What are you building?">
            <Textarea
              name="description"
              placeholder="Give your team a little context."
              maxLength={4000}
            />
          </Field>
          <Field label="GitHub repository · optional">
            <Input
              name="repository"
              type="url"
              placeholder="https://github.com/your-team/your-repo"
            />
          </Field>
          <div className="dialog-footer">
            <Button
              type="button"
              variant="outline"
              onClick={() => setNewProject(false)}
            >
              Cancel
            </Button>
            <Button disabled={busy}>
              {busy ? 'Creating…' : 'Create project'}
            </Button>
          </div>
        </form>
      </Modal>
      <Modal
        open={newArtifact}
        onOpenChange={setNewArtifact}
        title="Create an artifact"
        description="Each artifact gets its own canvas, conversation, ADR, and history."
      >
        <form onSubmit={createArtifact}>
          <Field label="Artifact type">
            <Select name="kind">
              {artifactKinds
                .filter((k) => k !== 'design')
                .map((k) => (
                  <option value={k} key={k}>
                    {kindLabels[k]}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Title">
            <Input
              name="title"
              placeholder="Give this artifact a name"
              required
              maxLength={180}
              autoFocus
            />
          </Field>
          <div className="dialog-footer">
            <Button
              type="button"
              variant="outline"
              onClick={() => setNewArtifact(false)}
            >
              Cancel
            </Button>
            <Button disabled={busy}>
              {busy ? 'Creating…' : 'Create artifact'}
            </Button>
          </div>
        </form>
      </Modal>
      <Modal open={command} onOpenChange={setCommand} title="Jump to…">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search projects and artifacts"
          aria-label="Search projects and artifacts"
          autoFocus
        />
        <div className="command-results">
          {projects
            .filter((p) =>
              p.title.toLowerCase().includes(query.toLowerCase()),
            )
            .map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  navigate(p.id, p.mainArtifactId);
                  setCommand(false);
                }}
              >
                <PanelsTopLeft size={16} />
                <span>
                  {p.title}
                  <small>Project</small>
                </span>
                <ArrowUpRight size={14} />
              </button>
            ))}
          {artifacts
            .filter((a) =>
              a.title.toLowerCase().includes(query.toLowerCase()),
            )
            .map((a) => {
              const Icon = kindIcons[a.kind];
              return (
                <button
                  key={a.id}
                  onClick={() => {
                    navigate(a.projectId, a.id);
                    setCommand(false);
                  }}
                >
                  <Icon size={16} />
                  <span>
                    {a.title}
                    <small>{kindLabels[a.kind]}</small>
                  </span>
                  <ArrowUpRight size={14} />
                </button>
              );
            })}
        </div>
        <p className="small muted">⌘ / Ctrl K to open this menu</p>
      </Modal>
      {project && (
        <ShareDialog
          open={share}
          onOpenChange={setShare}
          project={project}
          onError={report}
        />
      )}
      <Modal
        open={settings}
        onOpenChange={setSettings}
        title="Workspace settings"
      >
        <div className="settings-section">
          <RepositoryIdentity
            onChanged={() => {
              void refreshProjects().catch((error) => report(error.message));
            }}
            onError={report}
          />
        </div>
        {project?.role === 'owner' && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await api(
                  `/projects/${project.id}`,
                  'PATCH',
                  Object.fromEntries(new FormData(e.currentTarget)),
                );
                await refreshProjects();
                setSettings(false);
              } catch (e) {
                report((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Project name">
              <Input name="title" defaultValue={project.title} required />
            </Field>
            <Field label="Description">
              <Textarea
                name="description"
                defaultValue={project.description}
              />
            </Field>
            <Field label="Repository">
              <Input name="repository" defaultValue={project.repository} />
            </Field>
            <Button disabled={busy}>Save project settings</Button>
          </form>
        )}
        <div className="settings-section">
          <h3>Integrations</h3>
          {[
            ['AI assistant', capabilities.agent],
            ['Acceptance runner', capabilities.runner],
            ['Organization sign-in', capabilities.oidc],
          ].map(([name, on]) => (
            <div className="integration-row" key={String(name)}>
              <span>{name}</span>
              <Badge tone={on ? 'green' : 'neutral'}>
                {on ? 'Configured' : 'Not configured'}
              </Badge>
            </div>
          ))}
          <p className="small muted">
            Providers and credentials are configured by the deployment
            operator. Preview remains available without them.
          </p>
          <Button
            disabled={!project}
            variant="outline"
            onClick={() => {
              setSettings(false);
              setShare(true);
            }}
          >
            Manage project access
          </Button>
        </div>
      </Modal>
    </div>
  );
}
