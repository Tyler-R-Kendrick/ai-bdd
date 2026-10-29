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
  buildPreviewDocument,
  parsePreviewContracts,
  samplePreviewContract,
} from '../../shared/preview.ts';
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
type CodeContent = { files: Record<string, string>; entry: string };

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
    [newFile, setNewFile] = useState(false);
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
      setReady(false);
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
      return {
        html: buildPreviewDocument(
          previewFiles.files,
          previewFiles.entry,
          channel,
        ),
        error: '',
      };
    } catch (error) {
      return { html: '', error: (error as Error).message };
    }
  }, [previewFiles, channel]);
  useEffect(() => {
    if (tab !== 'preview' || !preview.html || preview.error) return;
    const controller = new AbortController();
    setReady(false);
    setPreviewError('');
    fetch(`/api/artifacts/${artifact.id}/previews`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: preview.html }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok)
          throw new Error(result.error ?? 'The preview could not be prepared');
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
  }, [artifact.id, preview.html, preview.error, reload, tab]);
  const contractState = useMemo(() => {
    try {
      const fixture = parsePreviewContracts(draft.files['contracts.json']);
      return { count: fixture?.interactions.length ?? 0, error: '' };
    } catch (error) {
      return { count: 0, error: (error as Error).message };
    }
  }, [draft.files]);
  const stale = dirty && artifact.version !== baseVersion;
  const mutate = (next: CodeContent) => {
    if (readOnly) return;
    setDraft(next);
    setDirty(true);
  };
  async function save() {
    setSaving(true);
    try {
      await onSave(draft, baseVersion);
      setBaseVersion(baseVersion + 1);
      setDirty(false);
    } catch {
      /* The shared save handler presents conflicts without replacing the local draft. */
    } finally {
      setSaving(false);
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
          <Button
            variant="outline"
            size="sm"
            onClick={addContract}
            disabled={readOnly}
          >
            <Braces size={14} />
            Contracts <span className="code-count">{contractState.count}</span>
          </Button>
          <IconButton
            label="Download code bundle"
            onClick={() =>
              download(
                `${artifact.title}.json`,
                JSON.stringify({ schemaVersion: 1, ...draft }, null, 2),
              )
            }
          >
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
                  onClick={() => setNewFile(true)}
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
              <p>HTML, CSS, and JavaScript run inside an isolated preview.</p>
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
                  .filter((name) => /\.html?$/i.test(name))
                  .map((name) => (
                    <option value={name} key={name}>
                      {name}
                    </option>
                  ))}
              </Select>
            </label>
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
                <p>{preview.error || previewError}</p>
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
        open={newFile}
        onOpenChange={setNewFile}
        title="Create file"
        description="The preview runs HTML, CSS, and plain JavaScript. Use contracts.json for Pact-shaped service fixtures."
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const name = String(
              new FormData(event.currentTarget).get('name') ?? '',
            ).trim();
            if (
              !/^[a-zA-Z0-9_./-]{1,200}$/.test(name) ||
              name.includes('..') ||
              name.startsWith('/')
            ) {
              onError(
                'Use a relative file path containing letters, numbers, dots, dashes, and underscores.',
              );
              return;
            }
            if (draft.files[name] !== undefined) {
              onError('A file with this name already exists.');
              return;
            }
            mutate({ ...draft, files: { ...draft.files, [name]: '' } });
            setFile(name);
            setNewFile(false);
          }}
        >
          <Field label="File path">
            <Input
              name="name"
              placeholder="e.g. components.js"
              autoFocus
              required
              maxLength={200}
            />
          </Field>
          <div className="dialog-footer">
            <Button
              type="button"
              variant="outline"
              onClick={() => setNewFile(false)}
            >
              Cancel
            </Button>
            <Button>Create file</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
