import { useEffect, useMemo, useRef, useState } from 'react';
import Editor, { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import 'monaco-editor/language/typescript/monaco.contribution.js';
import 'monaco-editor/language/json/monaco.contribution.js';
import 'monaco-editor/language/css/monaco.contribution.js';
import 'monaco-editor/language/html/monaco.contribution.js';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker.js?worker';
import CssWorker from 'monaco-editor/language/css/css.worker.js?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker.js?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';
import {
  Braces,
  Code2,
  Download,
  Copy,
  FilePenLine,
  FolderOpen,
  Package,
  Upload,
  FileCode2,
  FileJson2,
  Monitor,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Smartphone,
  Trash2,
  X,
} from 'lucide-react';
import type { MediaProps } from '../App.tsx';
import { download } from '../lib.ts';
import {
  Badge,
  Button,
  Field,
  IconButton,
  Input,
  Modal,
  Select,
  Spinner,
} from '../components/ui.tsx';
import {
  parsePreviewContracts,
  samplePreviewContract,
} from '../../shared/preview.ts';
import {
  checkCodeProject,
  entryFile,
  reactStarter,
  renameCodeFile,
  validCodePath,
  type CodeProject,
} from '../../shared/code-project.ts';
import { exportCodeZip, importCodeZip } from '../../shared/code-archive.ts';
import { CodePrompt } from './code/CodePrompt.tsx';
import './CodeEditor.css';

(
  self as unknown as {
    MonacoEnvironment: {
      getWorker: (_moduleId: string, label: string) => Worker;
    };
  }
).MonacoEnvironment = {
  getWorker(_moduleId, label) {
    if (label === 'json') return new JsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less')
      return new CssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor')
      return new HtmlWorker();
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    return new EditorWorker();
  },
};
loader.config({ monaco });
export const localMonaco = monaco;
const languageFor = (path: string) =>
  /\.html?$/i.test(path)
    ? 'html'
    : /\.css$/i.test(path)
      ? 'css'
      : /\.json$/i.test(path)
        ? 'json'
        : /\.tsx?$/i.test(path)
          ? 'typescript'
          : /\.jsx?$/i.test(path)
            ? 'javascript'
            : /\.md$/i.test(path)
              ? 'markdown'
              : 'plaintext';
type ConsoleLine = { level: string; text: string };
type CodeContent = CodeProject;
type CompileInfo = {
  diagnostics: {
    text: string;
    file?: string;
    line?: number;
    column?: number;
    severity: string;
  }[];
  dependencies: { name: string; version: string }[];
  availableDependencies?: { name: string; version: string }[];
  modules: string[];
};

export default function CodeEditor({
  artifact,
  readOnly,
  onSave,
  onDirty,
  onError,
}: MediaProps) {
  const [draft, setDraft] = useState<CodeContent>(
    () => structuredClone(artifact.content) as CodeContent,
  );
  const [baseVersion, setBaseVersion] = useState(artifact.version),
    [dirty, setDirty] = useState(false),
    [saving, setSaving] = useState(false);
  const [file, setFile] = useState(artifact.content.entry as string),
    [tab, setTab] = useState<'code' | 'preview'>('preview'),
    [showFiles, setShowFiles] = useState(true),
    [fileAction, setFileAction] = useState<
      'create' | 'rename' | 'duplicate' | null
    >(null),
    [projectAction, setProjectAction] = useState<'starter' | 'import' | null>(
      null,
    ),
    [incoming, setIncoming] = useState<CodeProject | null>(null),
    [packagesOpen, setPackagesOpen] = useState(false),
    [providerState, setProviderState] = useState(''),
    [compileInfo, setCompileInfo] = useState<CompileInfo>({
      diagnostics: [],
      dependencies: [],
      modules: [],
    });
  const [viewport, setViewport] = useState<'desktop' | 'mobile'>('desktop'),
    [reload, setReload] = useState(0),
    [consoleLines, setConsoleLines] = useState<ConsoleLine[]>([]),
    [consoleOpen, setConsoleOpen] = useState(false);
  const [previewFiles, setPreviewFiles] = useState(draft),
    [ready, setReady] = useState(false),
    [previewUrl, setPreviewUrl] = useState(''),
    [previewError, setPreviewError] = useState('');
  const iframe = useRef<HTMLIFrameElement>(null),
    channel = useMemo(() => crypto.randomUUID(), [artifact.id]);
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(() => {
    if (!dirty && artifact.version !== baseVersion) {
      setDraft(structuredClone(artifact.content) as CodeContent);
      setBaseVersion(artifact.version);
    }
  }, [artifact.version, artifact.content, dirty, baseVersion]);
  useEffect(() => {
    const timer = setTimeout(() => {
      setPreviewFiles(draft);
    }, 450);
    return () => clearTimeout(timer);
  }, [draft]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.source !== iframe.current?.contentWindow ||
        event.data?.studioPreview !== channel ||
        typeof event.data?.text !== 'string'
      )
        return;
      setConsoleLines((previous) =>
        [
          ...previous,
          {
            level: String(event.data.level).slice(0, 20),
            text: event.data.text.slice(0, 4000),
          },
        ].slice(-100),
      );
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [channel]);
  useEffect(
    () => () => {
      for (const model of monaco.editor.getModels())
        if (model.uri.toString().includes(`/studio/${artifact.id}/`))
          model.dispose();
    },
    [artifact.id],
  );
  const preview = useMemo(() => {
    try {
      checkCodeProject(previewFiles);
      parsePreviewContracts(previewFiles.files['contracts.json']);
      return { error: '' };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }, [previewFiles]);
  useEffect(() => {
    if (tab !== 'preview' || preview.error) return;
    const controller = new AbortController();
    setReady(false);
    setPreviewError('');
    fetch(`/api/artifacts/${artifact.id}/previews`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...previewFiles,
        files: previewFiles.files['contracts.json']
          ? {
              ...previewFiles.files,
              'contracts.json': JSON.stringify({
                ...JSON.parse(previewFiles.files['contracts.json']),
                metadata: {
                  ...JSON.parse(previewFiles.files['contracts.json']).metadata,
                  studioPreview: { providerState },
                },
              }),
            }
          : previewFiles.files,
        channel,
      }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const result = await response.json();
        if (!controller.signal.aborted)
          setCompileInfo({
            diagnostics: result.diagnostics ?? [],
            dependencies: result.dependencies ?? [],
            availableDependencies: result.availableDependencies ?? [],
            modules: result.modules ?? [],
          });
        if (!response.ok)
          throw new Error(result.error ?? 'The preview could not be compiled');
        return result;
      })
      .then((result) => {
        if (!controller.signal.aborted) setPreviewUrl(result.url);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setPreviewUrl('');
          setPreviewError(error.message);
        }
      });
    return () => controller.abort();
  }, [
    artifact.id,
    previewFiles,
    preview.error,
    channel,
    reload,
    tab,
    providerState,
  ]);
  const contractState = useMemo(() => {
    try {
      const fixture = parsePreviewContracts(draft.files['contracts.json']);
      return {
        count: fixture?.interactions.length ?? 0,
        states: [
          ...new Set(
            fixture?.interactions.flatMap(
              (value) => value.providerStates?.map((state) => state.name) ?? [],
            ) ?? [],
          ),
        ],
        error: '',
      };
    } catch (error) {
      return {
        count: 0,
        states: [] as string[],
        error: (error as Error).message,
      };
    }
  }, [draft.files]);
  useEffect(() => {
    if (providerState && !contractState.states.includes(providerState))
      setProviderState('');
  }, [providerState, contractState.states]);
  const stale = dirty && artifact.version !== baseVersion;
  const mutate = (next: CodeContent) => {
    if (readOnly) return;
    setDraft(next);
    setDirty(true);
  };
  async function save() {
    if (readOnly || !dirty || saving) return;
    setSaving(true);
    try {
      checkCodeProject(draft);
      parsePreviewContracts(draft.files['contracts.json']);
      await onSave(draft, baseVersion);
      setBaseVersion(baseVersion + 1);
      setDirty(false);
    } catch (error) {
      onError((error as Error).message);
      /* Keep the local draft on validation or revision conflicts. */
    } finally {
      setSaving(false);
    }
  }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [draft, baseVersion, dirty, saving, readOnly]);
  function exportZip() {
    try {
      download(
        `${artifact.title}.zip`,
        new Uint8Array(exportCodeZip(draft)).buffer,
        'application/zip',
      );
    } catch (error) {
      onError((error as Error).message);
    }
  }
  async function importProject(file: File | undefined) {
    setIncoming(null);
    if (!file) return;
    try {
      if (file.size > 4_000_000)
        throw new Error('Choose a ZIP or JSON project smaller than 4 MB');
      const next = /\.zip$/i.test(file.name)
        ? await importCodeZip(new Uint8Array(await file.arrayBuffer()))
        : checkCodeProject(JSON.parse(await file.text()));
      setIncoming(next);
    } catch (error) {
      onError((error as Error).message);
    }
  }
  function addContract() {
    if (draft.files['contracts.json'] === undefined)
      mutate({
        ...draft,
        files: {
          ...draft.files,
          'contracts.json': JSON.stringify(samplePreviewContract, null, 2),
        },
      });
    setFile('contracts.json');
    setTab('code');
  }
  function removeFile() {
    if (file === draft.entry) {
      onError('Choose a different preview entry before deleting this file.');
      return;
    }
    const files = { ...draft.files };
    delete files[file];
    mutate({ ...draft, files });
    setFile(draft.entry);
  }
  return (
    <div className="code-editor">
      <div className="media-toolbar code-toolbar">
        <div className="media-tabs" role="tablist" aria-label="Code canvas">
          <button
            role="tab"
            aria-selected={tab === 'preview'}
            onClick={() => setTab('preview')}
          >
            <Monitor size={14} />
            Preview
          </button>
          <button
            role="tab"
            aria-selected={tab === 'code'}
            onClick={() => setTab('code')}
          >
            <Code2 size={14} />
            Code
          </button>
        </div>
        <div className="code-toolbar-actions">
          <IconButton
            label="Start React project"
            onClick={() => setProjectAction('starter')}
            disabled={readOnly}
          >
            <FolderOpen />
          </IconButton>
          <IconButton
            label="Import code project"
            onClick={() => {
              setIncoming(null);
              setProjectAction('import');
            }}
            disabled={readOnly}
          >
            <Upload />
          </IconButton>
          <IconButton
            label="Installed packages"
            aria-expanded={packagesOpen}
            onClick={() => setPackagesOpen((value) => !value)}
          >
            <Package />
          </IconButton>
          <Button
            variant="outline"
            size="sm"
            onClick={addContract}
            disabled={readOnly}
          >
            <Braces size={14} />
            Contracts <span className="code-count">{contractState.count}</span>
          </Button>
          <IconButton label="Download code project ZIP" onClick={exportZip}>
            <Download />
          </IconButton>
          <Button
            size="sm"
            onClick={save}
            disabled={readOnly || !dirty || saving}
          >
            <Save size={14} />
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </div>
      {packagesOpen && (
        <section
          className="code-package-panel"
          aria-label="Installed browser packages"
        >
          <div>
            <strong>Installed browser packages</strong>
            <p>
              These versions are bundled locally. Preview compilation never runs
              install scripts or contacts a package registry.
            </p>
          </div>
          <div className="code-package-list">
            {(compileInfo.availableDependencies?.length
              ? compileInfo.availableDependencies
              : compileInfo.dependencies
            ).map((value) => (
              <code key={value.name}>
                {value.name} <span>{value.version}</span>
              </code>
            ))}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (!draft.files['package.json'])
                mutate({
                  ...draft,
                  files: {
                    ...draft.files,
                    'package.json': JSON.stringify(
                      {
                        private: true,
                        dependencies: Object.fromEntries(
                          compileInfo.dependencies.map((value) => [
                            value.name,
                            value.version,
                          ]),
                        ),
                      },
                      null,
                      2,
                    ),
                  },
                });
              setFile('package.json');
              setTab('code');
            }}
            disabled={readOnly}
          >
            Edit package manifest
          </Button>
        </section>
      )}
      {stale && (
        <div className="draft-notice" role="alert">
          <span>
            A teammate saved a newer version. Your local changes are retained.
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              download(
                `${artifact.title}-local-draft.json`,
                JSON.stringify(draft, null, 2),
              );
            }}
          >
            Download my draft
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setDraft(structuredClone(artifact.content) as CodeContent);
              setBaseVersion(artifact.version);
              setDirty(false);
            }}
          >
            Load latest
          </Button>
        </div>
      )}
      {tab === 'code' ? (
        <div
          className={'code-layout ' + (!showFiles ? 'code-files-hidden' : '')}
        >
          {showFiles && (
            <aside className="file-tree" aria-label="Artifact files">
              <div className="file-tree-heading">
                <span>Files</span>
                <IconButton
                  label="Create file"
                  onClick={() => setFileAction('create')}
                  disabled={readOnly || Object.keys(draft.files).length >= 50}
                >
                  <Plus size={14} />
                </IconButton>
              </div>
              <div className="file-tree-list">
                {Object.keys(draft.files)
                  .sort()
                  .map((name) => (
                    <button
                      key={name}
                      onClick={() => setFile(name)}
                      className={file === name ? 'active' : ''}
                      title={name}
                    >
                      {/\.json$/i.test(name) ? (
                        <FileJson2 size={14} />
                      ) : (
                        <FileCode2 size={14} />
                      )}
                      <span>{name}</span>
                    </button>
                  ))}
              </div>
              <p>
                HTML, React, TypeScript and JSX compile locally into an isolated
                preview.
              </p>
            </aside>
          )}
          <section className="source-pane">
            <div className="source-heading">
              <IconButton
                label={showFiles ? 'Hide files' : 'Show files'}
                onClick={() => setShowFiles((value) => !value)}
              >
                {showFiles ? (
                  <PanelLeftClose size={14} />
                ) : (
                  <PanelLeftOpen size={14} />
                )}
              </IconButton>
              <span>{file}</span>
              {file === draft.entry && <Badge>Entry</Badge>}
              <span className="source-heading-spacer" />
              <IconButton
                label="Rename selected file"
                onClick={() => setFileAction('rename')}
                disabled={readOnly}
              >
                <FilePenLine size={14} />
              </IconButton>
              <IconButton
                label="Duplicate selected file"
                onClick={() => setFileAction('duplicate')}
                disabled={readOnly || Object.keys(draft.files).length >= 50}
              >
                <Copy size={14} />
              </IconButton>
              <IconButton
                label="Delete selected file"
                onClick={removeFile}
                disabled={readOnly || file === draft.entry}
              >
                <Trash2 size={14} />
              </IconButton>
            </div>
            <Editor
              height="100%"
              path={`inmemory://studio/${artifact.id}/${file}`}
              language={languageFor(file)}
              value={draft.files[file] ?? ''}
              onChange={(value) => {
                if (value !== draft.files[file])
                  mutate({
                    ...draft,
                    files: { ...draft.files, [file]: value ?? '' },
                  });
              }}
              loading={<Spinner label="Loading local editor…" />}
              beforeMount={(editor) => {
                editor.editor.defineTheme('studio-light', {
                  base: 'vs',
                  inherit: true,
                  rules: [],
                  colors: {
                    'editor.background': '#ffffff',
                    'editorLineNumber.foreground': '#a6aba6',
                    'editorLineNumber.activeForeground': '#5f665f',
                    'editor.selectionBackground': '#e5e7f7',
                  },
                });
              }}
              theme="studio-light"
              options={{
                readOnly,
                minimap: { enabled: false },
                fontSize: 13,
                fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
                padding: { top: 18 },
                lineNumbersMinChars: 3,
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                automaticLayout: true,
                tabSize: 2,
                ariaLabel: `${file} source code`,
              }}
            />
          </section>
        </div>
      ) : (
        <section className="preview-pane" aria-label="Live code preview">
          <div className="preview-toolbar">
            <div className="preview-address">
              <ShieldCheck size={13} />
              <span>Isolated preview</span>
            </div>
            <label className="preview-entry">
              Entry
              <Select
                value={draft.entry}
                onChange={(e) => mutate({ ...draft, entry: e.target.value })}
                disabled={readOnly}
                aria-label="Preview entry file"
              >
                {Object.keys(draft.files)
                  .filter(entryFile)
                  .map((name) => (
                    <option value={name} key={name}>
                      {name}
                    </option>
                  ))}
              </Select>
            </label>
            {contractState.states.length > 0 && (
              <label className="preview-entry">
                Provider state
                <Select
                  aria-label="Preview provider state"
                  value={providerState}
                  onChange={(event) => setProviderState(event.target.value)}
                >
                  <option value="">All examples</option>
                  {contractState.states.map((state) => (
                    <option key={state}>{state}</option>
                  ))}
                </Select>
              </label>
            )}
            <div className="viewport-switch">
              <IconButton
                label="Desktop viewport"
                aria-pressed={viewport === 'desktop'}
                onClick={() => setViewport('desktop')}
              >
                <Monitor size={15} />
              </IconButton>
              <IconButton
                label="Mobile viewport"
                aria-pressed={viewport === 'mobile'}
                onClick={() => setViewport('mobile')}
              >
                <Smartphone size={15} />
              </IconButton>
              <IconButton
                label="Reload preview"
                onClick={() => {
                  setReload((value) => value + 1);
                  setConsoleLines([]);
                  setReady(false);
                }}
              >
                <RefreshCw size={15} />
              </IconButton>
            </div>
          </div>
          <div
            className={
              'preview-frame-wrap ' +
              (viewport === 'mobile' ? 'preview-mobile' : '')
            }
          >
            {preview.error || previewError ? (
              <div className="code-preview-error" role="alert">
                <strong>Preview needs attention</strong>
                <p>
                  {compileInfo.diagnostics.some(
                    (value) => value.severity === 'error' && value.file,
                  )
                    ? 'Select a diagnostic to edit its source file.'
                    : preview.error || previewError}
                </p>
                {compileInfo.diagnostics
                  .filter((value) => value.severity === 'error' && value.file)
                  .map((value, index) => (
                    <button
                      className="code-diagnostic"
                      key={index}
                      onClick={() => {
                        if (
                          value.file &&
                          draft.files[value.file] !== undefined
                        ) {
                          setFile(value.file);
                          setTab('code');
                        }
                      }}
                    >
                      {value.file}:{value.line ?? 1} {value.text}
                    </button>
                  ))}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setTab('code')}
                >
                  Open source
                </Button>
              </div>
            ) : previewUrl ? (
              <iframe
                key={reload}
                ref={iframe}
                title="Live artifact preview"
                className="preview-frame"
                sandbox="allow-scripts"
                referrerPolicy="no-referrer"
                src={previewUrl}
                onLoad={() => setReady(true)}
              />
            ) : (
              <Spinner label="Preparing isolated preview…" />
            )}
          </div>
        </section>
      )}
      <CodePrompt
        artifactId={artifact.id}
        readOnly={readOnly}
        dirty={dirty}
        onError={onError}
      />
      <div className="editor-statusbar">
        <span>
          <span
            className={'status-dot ' + (contractState.error ? 'error' : '')}
          />
          {tab === 'preview'
            ? preview.error || previewError
              ? 'Preview unavailable'
              : ready
                ? 'Preview ready'
                : 'Loading preview…'
            : languageFor(file)}
        </span>
        <span>
          {contractState.error ? (
            <button
              onClick={() => {
                setFile('contracts.json');
                setTab('code');
              }}
            >
              Invalid contracts
            </button>
          ) : (
            `${contractState.count} contract ${contractState.count === 1 ? 'response' : 'responses'}`
          )}
        </span>
        <button
          onClick={() => setConsoleOpen((value) => !value)}
          aria-expanded={consoleOpen}
        >
          Console{' '}
          {consoleLines.filter((line) => line.level === 'error').length > 0 && (
            <span className="console-error-count">
              {consoleLines.filter((line) => line.level === 'error').length}
            </span>
          )}
        </button>
        <span className="statusbar-spacer" />
        <span>No production integrations required</span>
      </div>
      {consoleOpen && (
        <div className="preview-console">
          <div>
            <strong>Preview console</strong>
            <IconButton
              label="Close preview console"
              onClick={() => setConsoleOpen(false)}
            >
              <X size={13} />
            </IconButton>
          </div>
          {consoleLines.length ? (
            consoleLines.map((line, index) => (
              <pre
                key={index}
                className={line.level === 'error' ? 'error-text' : ''}
              >
                <span>{line.level}</span>
                {line.text}
              </pre>
            ))
          ) : (
            <p>
              No console messages. Unmatched requests are rejected, never sent
              to a live service.
            </p>
          )}
        </div>
      )}
      <Modal
        open={projectAction !== null}
        onOpenChange={(open) => {
          if (!open) setProjectAction(null);
        }}
        title={
          projectAction === 'starter'
            ? 'Start a React project'
            : 'Import a code project'
        }
        description="Review before replacing this local draft. The saved artifact remains unchanged until you save."
      >
        {projectAction === 'import' ? (
          <>
            <Field label="Project ZIP or JSON">
              <Input
                type="file"
                accept=".zip,.json,application/zip,application/json"
                onChange={(event) => {
                  void importProject(event.target.files?.[0]);
                }}
              />
            </Field>
            {incoming && (
              <div className="code-import-review">
                <strong>
                  {Object.keys(incoming.files).length}{' '}
                  {Object.keys(incoming.files).length === 1 ? 'file' : 'files'}{' '}
                  ready to import
                </strong>
                <Field label="Imported preview entry">
                  <Select
                    value={incoming.entry}
                    onChange={(event) =>
                      setIncoming({ ...incoming, entry: event.target.value })
                    }
                  >
                    {Object.keys(incoming.files)
                      .filter(entryFile)
                      .map((path) => (
                        <option key={path}>{path}</option>
                      ))}
                  </Select>
                </Field>
                <pre>{Object.keys(incoming.files).sort().join('\n')}</pre>
              </div>
            )}
          </>
        ) : (
          <p className="code-project-description">
            Create a complete TypeScript/React project with a working counter,
            local stylesheet and installed Lucide icons. You can export it as
            ordinary source files in a ZIP.
          </p>
        )}
        <div className="dialog-footer">
          <Button variant="outline" onClick={exportZip}>
            Download current draft
          </Button>
          <Button variant="outline" onClick={() => setProjectAction(null)}>
            Cancel
          </Button>
          <Button
            disabled={projectAction === 'import' && !incoming}
            onClick={() => {
              const next =
                projectAction === 'starter' ? reactStarter() : incoming;
              if (next) {
                mutate(next);
                setFile(next.entry);
                setTab('preview');
                setProjectAction(null);
              }
            }}
          >
            {projectAction === 'starter' ? 'Use React starter' : 'Import files'}
          </Button>
        </div>
      </Modal>
      <Modal
        open={fileAction !== null}
        onOpenChange={(open) => {
          if (!open) setFileAction(null);
        }}
        title={
          fileAction === 'rename'
            ? 'Rename file'
            : fileAction === 'duplicate'
              ? 'Duplicate file'
              : 'Create file'
        }
        description={
          fileAction === 'rename'
            ? 'Local imports and HTML references are updated. Your unsaved changes stay in this draft.'
            : 'Use HTML, TypeScript, JSX, CSS or JSON. Service boundaries belong in contracts.json.'
        }
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const name = String(
              new FormData(event.currentTarget).get('name') ?? '',
            ).trim();
            if (!validCodePath(name)) {
              onError(
                'Use a relative file path containing letters, numbers, dots, dashes, and underscores.',
              );
              return;
            }
            if (
              draft.files[name] !== undefined &&
              !(fileAction === 'rename' && name === file)
            ) {
              onError('A file with this name already exists.');
              return;
            }
            try {
              mutate(
                fileAction === 'rename'
                  ? renameCodeFile(draft, file, name)
                  : {
                      ...draft,
                      files: {
                        ...draft.files,
                        [name]:
                          fileAction === 'duplicate' ? draft.files[file]! : '',
                      },
                    },
              );
              setFile(name);
              setFileAction(null);
            } catch (error) {
              onError((error as Error).message);
            }
          }}
        >
          <Field label="File path">
            <Input
              name="name"
              placeholder="e.g. src/components/Counter.tsx"
              defaultValue={
                fileAction === 'rename'
                  ? file
                  : fileAction === 'duplicate'
                    ? file.replace(/(\.[^./]+)?$/, '-copy$1')
                    : ''
              }
              autoFocus
              required
              maxLength={200}
            />
          </Field>
          <div className="dialog-footer">
            <Button
              type="button"
              variant="outline"
              onClick={() => setFileAction(null)}
            >
              Cancel
            </Button>
            <Button>
              {fileAction === 'rename'
                ? 'Rename file'
                : fileAction === 'duplicate'
                  ? 'Duplicate file'
                  : 'Create file'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
