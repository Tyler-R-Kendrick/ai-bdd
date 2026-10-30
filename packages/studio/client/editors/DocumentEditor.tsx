import { createContext, useContext, useEffect, useState } from 'react';
import {
  EditorContent,
  useEditor,
  ReactNodeViewRenderer,
  NodeViewWrapper,
  type NodeViewProps,
} from '@tiptap/react';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  List,
  ListOrdered,
  Quote,
  Code2,
  Table2,
  MessageSquarePlus,
  FlaskConical,
  Undo2,
  Redo2,
  Link2,
  Download,
  Sigma,
  ImagePlus,
  CheckCircle2,
  Clock3,
  ChartColumn,
  GitBranch,
  LayoutPanelTop,
  ArrowUpRight,
} from 'lucide-react';
import {
  baseExtensions,
  TestBlock,
  ChartBlock,
  DiagramBlock,
  TabsBlock,
  ResearchBlock,
  DocumentBlocks,
} from '../../shared/editor.ts';
import {
  richVisualDefaults,
  type RichVisualKind,
} from '../../shared/rich-blocks.ts';
import { RichVisualView, RichVisualProvider } from './rich/Blocks.tsx';
import { type Artifact, type User } from '../../shared/domain.ts';
import { IconButton, Badge, Spinner } from '../components/ui.tsx';
import { api, download } from '../lib.ts';
import { inlineTestStatus } from './test-status.ts';
import { DocumentWorkspaceProvider } from './document/Workspace.tsx';
import { DocumentBlockView, ResearchView } from './document/Blocks.tsx';
import { DocumentTools, DocumentReviewPane } from './document/Tools.tsx';
import { exportMarkdown } from '../../shared/document-interchange.ts';
import { isDocumentBlockKind } from '../../shared/document-blocks.ts';
import './document/document.css';
import { DocumentSearch } from './document/Search.tsx';
const TestContext = createContext<{
  runs: any[];
  version: number;
  readOnly: boolean;
  onTests: () => void;
}>({ runs: [], version: 0, readOnly: true, onTests: () => {} });
function TestView({ node, updateAttributes }: NodeViewProps) {
  const { runs, version, readOnly, onTests } = useContext(TestContext);
  const { scenarios, scenario, linked, stale, status, passed } =
    inlineTestStatus(runs[0], version, node.attrs.scenarioId);
  return (
    <NodeViewWrapper className="inline-test" contentEditable={false}>
      <div className="inline-test-heading">
        <FlaskConical size={17} />
        <strong>{node.attrs.label}</strong>
        <Badge
          tone={
            passed
              ? 'green'
              : stale
                ? 'amber'
                : scenario?.status === 'failed'
                  ? 'red'
                  : 'neutral'
          }
        >
          {passed ? <CheckCircle2 size={11} /> : <Clock3 size={11} />} {status}
        </Badge>
      </div>
      <p>
        {linked
          ? 'This criterion is linked to a specific executed scenario. Evidence verifies only the document revision it ran against.'
          : 'Choose an executed scenario to link this criterion. An unrelated passing run does not verify this block.'}
      </p>
      <label className="inline-test-scenario">
        <span>Acceptance scenario</span>
        <select
          aria-label={`Acceptance scenario for ${node.attrs.label}`}
          value={node.attrs.scenarioId ?? ''}
          disabled={readOnly || scenarios.length === 0}
          onChange={(event) => {
            if (!readOnly) updateAttributes({ scenarioId: event.target.value });
          }}
        >
          <option value="">Not linked</option>
          {linked && !scenario && (
            <option value={node.attrs.scenarioId}>
              Linked scenario · not in the latest run
            </option>
          )}
          {scenarios.map((result) => (
            <option key={result.scenarioId} value={result.scenarioId}>
              {result.title}
            </option>
          ))}
        </select>
      </label>
      <button onClick={onTests}>
        View tests & evidence <ArrowUpRight size={12} />
      </button>
    </NodeViewWrapper>
  );
}
const LiveTest = TestBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(TestView);
  },
});
const LiveChart = ChartBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(RichVisualView);
  },
});
const LiveDiagram = DiagramBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(RichVisualView);
  },
});
const LiveDocumentBlocks = DocumentBlocks.map((block) =>
  block.extend({
    addNodeView() {
      return ReactNodeViewRenderer(DocumentBlockView);
    },
  }),
);
const LiveResearch = ResearchBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(ResearchView);
  },
});
const LiveTabs = TabsBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(RichVisualView);
  },
});
export function DocumentEditor(props: {
  artifact: Artifact;
  user: User;
  readOnly: boolean;
  runs: any[];
  onTests: () => void;
  onDecisions?: () => void;
  onComment: (id: string, quote: string) => void;
  onError: (message: string) => void;
}) {
  const [session, setSession] = useState<{
      doc: Y.Doc;
      provider: WebsocketProvider;
    } | null>(null),
    [status, setStatus] = useState('connecting'),
    [people, setPeople] = useState<any[]>([]);
  useEffect(() => {
    setSession(null);
    setPeople([]);
    setStatus('connecting');
    let disposed = false;
    const doc = new Y.Doc(),
      provider = new WebsocketProvider(
        `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/collaboration`,
        props.artifact.id,
        doc,
        { connect: false, maxBackoffTime: 10000 },
      );
    provider.awareness.setLocalStateField('user', {
      id: props.user.id,
      name: props.user.name,
      color: props.user.color,
    });
    const change = () => {
      if (!disposed)
        setPeople(
          [...provider.awareness.getStates().values()]
            .map((s) => s.user)
            .filter(Boolean)
            .filter((u, i, a) => a.findIndex((v) => v.id === u.id) === i),
        );
    };
    const statusChanged = ({ status }: { status: string }) => {
        if (!disposed) setStatus(status);
      },
      failed = () => {
        if (!disposed) setStatus('disconnected');
      };
    // Mount ProseMirror only after the initial CRDT handshake. Initializing it
    // against an empty Y.Doc would create normalization writes before a viewer
    // has received the document and could make a legitimate read look like an edit.
    const synced = (value: boolean) => {
      if (value && !disposed)
        setSession((current) =>
          current?.doc === doc ? current : { doc, provider },
        );
    };
    provider.awareness.on('change', change);
    provider.on('status', statusChanged);
    provider.on('connection-error', failed);
    provider.on('sync', synced);
    provider.connect();
    return () => {
      disposed = true;
      provider.awareness.off('change', change);
      provider.off('status', statusChanged);
      provider.off('connection-error', failed);
      provider.off('sync', synced);
      provider.destroy();
      doc.destroy();
    };
  }, [props.artifact.id, props.user.id]);
  return (
    <div className="document-editor">
      <div className="document-presence">
        <span
          className={'sync-label ' + (status === 'connected' ? '' : 'offline')}
        >
          <span className="status-dot" />
          {status === 'connected'
            ? 'Live collaboration'
            : status === 'connecting'
              ? 'Connecting…'
              : 'Reconnecting · changes pending'}
        </span>
        <div className="presence-avatars">
          {people.map((p) => (
            <span
              className="avatar avatar-small"
              key={p.id}
              style={{ background: p.color }}
              title={p.name}
            >
              {p.name[0]}
            </span>
          ))}
        </div>
      </div>
      {session ? (
        <EditorSession {...props} {...session} />
      ) : (
        <div className="app-loading">
          <Spinner label="Connecting to document…" />
        </div>
      )}
    </div>
  );
}
function EditorSession({
  artifact,
  user,
  readOnly,
  runs,
  onTests,
  onDecisions,
  onComment,
  onError,
  doc,
  provider,
}: {
  artifact: Artifact;
  user: User;
  readOnly: boolean;
  runs: any[];
  onTests: () => void;
  onDecisions?: () => void;
  onComment: (id: string, quote: string) => void;
  onError: (m: string) => void;
  doc: Y.Doc;
  provider: WebsocketProvider;
}) {
  const editor = useEditor(
    {
      extensions: [
        ...baseExtensions()
          .filter(
            (e) =>
              !isDocumentBlockKind(e.name) &&
              ![
                'researchBlock',
                'testBlock',
                'chartBlock',
                'diagramBlock',
                'tabsBlock',
              ].includes(e.name),
          )
          .map((extension) =>
            extension.name === 'uniqueID'
              ? extension.configure({ updateDocument: !readOnly })
              : extension,
          ),
        LiveTest,
        LiveChart,
        LiveDiagram,
        LiveTabs,
        DocumentSearch,
        LiveResearch,
        ...LiveDocumentBlocks,
        Collaboration.configure({ document: doc }),
        CollaborationCaret.configure({
          provider,
          user: { name: user.name, color: user.color },
        }),
      ],
      editable: !readOnly,
      immediatelyRender: false,
      editorProps: {
        attributes: {
          class: 'document-page',
          'aria-label': 'Document editor',
          spellcheck: 'true',
        },
      },
    },
    [doc, readOnly],
  );
  useEffect(() => {
    editor?.setEditable(!readOnly);
  }, [readOnly, editor]);
  function action(fn: () => void) {
    if (!readOnly) fn();
  }
  function insertVisual(kind: RichVisualKind) {
    if (!readOnly)
      editor
        ?.chain()
        .focus()
        .insertContent({
          type: kind,
          attrs: { data: structuredClone(richVisualDefaults[kind]) },
        })
        .run();
  }
  return (
    <TestContext.Provider
      value={{ runs, version: artifact.version, readOnly, onTests }}
    >
      <RichVisualProvider readOnly={readOnly}>
        <DocumentWorkspaceProvider
          key={artifact.id}
          artifact={artifact}
          user={user}
          readOnly={readOnly}
          runs={runs}
          editor={editor}
          onError={onError}
          onTests={onTests}
          onDecisions={onDecisions}
          onComment={onComment}
        >
          <div
            className="document-toolbar"
            role="toolbar"
            aria-label="Document formatting"
          >
            <select
              aria-label="Paragraph style"
              disabled={readOnly || !editor}
              onChange={(e) =>
                action(() => {
                  if (e.target.value === 'paragraph')
                    editor?.chain().focus().setParagraph().run();
                  else
                    editor
                      ?.chain()
                      .focus()
                      .toggleHeading({
                        level: Number(e.target.value) as 1 | 2 | 3,
                      })
                      .run();
                })
              }
              defaultValue="paragraph"
            >
              <option value="paragraph">Normal text</option>
              <option value="1">Heading 1</option>
              <option value="2">Heading 2</option>
              <option value="3">Heading 3</option>
            </select>
            <span className="toolbar-divider" />
            <IconButton
              label="Bold"
              aria-pressed={editor?.isActive('bold')}
              disabled={readOnly}
              onClick={() => editor?.chain().focus().toggleBold().run()}
            >
              <Bold />
            </IconButton>
            <IconButton
              label="Italic"
              aria-pressed={editor?.isActive('italic')}
              disabled={readOnly}
              onClick={() => editor?.chain().focus().toggleItalic().run()}
            >
              <Italic />
            </IconButton>
            <IconButton
              label="Underline"
              disabled={readOnly}
              aria-pressed={editor?.isActive('underline')}
              onClick={() => editor?.chain().focus().toggleUnderline().run()}
            >
              <Underline />
            </IconButton>
            <IconButton
              label="Strikethrough"
              disabled={readOnly}
              aria-pressed={editor?.isActive('strike')}
              onClick={() => editor?.chain().focus().toggleStrike().run()}
            >
              <Strikethrough />
            </IconButton>
            <IconButton
              label="Add link"
              disabled={readOnly}
              onClick={() => {
                const href = window.prompt('Link URL · https://');
                if (href?.startsWith('https://'))
                  editor?.chain().focus().setLink({ href }).run();
              }}
            >
              <Link2 />
            </IconButton>
            <span className="toolbar-divider" />
            <IconButton
              label="Bullet list"
              disabled={readOnly}
              onClick={() => editor?.chain().focus().toggleBulletList().run()}
            >
              <List />
            </IconButton>
            <IconButton
              label="Numbered list"
              disabled={readOnly}
              onClick={() => editor?.chain().focus().toggleOrderedList().run()}
            >
              <ListOrdered />
            </IconButton>
            <IconButton
              label="Quote"
              disabled={readOnly}
              onClick={() => editor?.chain().focus().toggleBlockquote().run()}
            >
              <Quote />
            </IconButton>
            <IconButton
              label="Code block"
              disabled={readOnly}
              onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
            >
              <Code2 />
            </IconButton>
            <IconButton
              label="Insert table"
              disabled={readOnly}
              onClick={() =>
                editor
                  ?.chain()
                  .focus()
                  .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
                  .run()
              }
            >
              <Table2 />
            </IconButton>
            <IconButton
              label="Insert math"
              disabled={readOnly}
              onClick={() => {
                const latex = window.prompt('LaTeX formula', 'E = mc^2');
                if (latex)
                  editor?.chain().focus().insertInlineMath({ latex }).run();
              }}
            >
              <Sigma />
            </IconButton>
            <IconButton
              label="Insert image"
              disabled={readOnly}
              onClick={() => {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = 'image/png,image/jpeg,image/webp';
                input.onchange = async () => {
                  const file = input.files?.[0];
                  if (!file) return;
                  try {
                    const form = new FormData();
                    form.append('file', file);
                    const r = await api(
                      `/artifacts/${artifact.id}/files`,
                      'POST',
                      form,
                    );
                    editor
                      ?.chain()
                      .focus()
                      .setImage({ src: r.url, alt: file.name })
                      .run();
                  } catch (e) {
                    onError((e as Error).message);
                  }
                };
                input.click();
              }}
            >
              <ImagePlus />
            </IconButton>
            <span className="toolbar-divider" />
            <IconButton
              label="Insert chart"
              disabled={readOnly}
              onClick={() => insertVisual('chartBlock')}
            >
              <ChartColumn />
            </IconButton>
            <IconButton
              label="Insert diagram"
              disabled={readOnly}
              onClick={() => insertVisual('diagramBlock')}
            >
              <GitBranch />
            </IconButton>
            <IconButton
              label="Insert tabs"
              disabled={readOnly}
              onClick={() => insertVisual('tabsBlock')}
            >
              <LayoutPanelTop />
            </IconButton>
            <IconButton
              label="Insert acceptance test"
              disabled={readOnly}
              onClick={() => {
                const label = window.prompt(
                  'Acceptance test name',
                  'Expected behavior',
                );
                if (label)
                  editor
                    ?.chain()
                    .focus()
                    .insertContent({
                      type: 'testBlock',
                      attrs: { label, scenarioId: '' },
                    })
                    .run();
              }}
            >
              <FlaskConical />
            </IconButton>
            <IconButton
              label="Comment on selection"
              disabled={readOnly}
              onClick={() => {
                if (!editor) return;
                const { from, to, $from } = editor.state.selection;
                const anchor = String($from.parent.attrs.id ?? 'document');
                onComment(anchor, editor.state.doc.textBetween(from, to, ' '));
              }}
            >
              <MessageSquarePlus />
            </IconButton>
            <div className="toolbar-spacer" />
            <IconButton
              label="Undo"
              disabled={readOnly}
              onClick={() => editor?.commands.undo()}
            >
              <Undo2 />
            </IconButton>
            <IconButton
              label="Redo"
              disabled={readOnly}
              onClick={() => editor?.commands.redo()}
            >
              <Redo2 />
            </IconButton>
            <IconButton
              label="Download Markdown"
              onClick={() =>
                editor &&
                download(
                  artifact.title + '.md',
                  exportMarkdown(editor.getJSON() as any),
                  'text/markdown',
                )
              }
            >
              <Download />
            </IconButton>
          </div>
          <DocumentTools />
          <div className="document-working-area">
            <div className="document-scroll">
              <EditorContent editor={editor} />
              <div className="document-footnote">
                <span>
                  {artifact.kind === 'design'
                    ? 'A living specification · keep intent, tests, and evidence together.'
                    : 'A shared document · changes are saved as you write.'}
                </span>
                <span>v{artifact.version}</span>
              </div>
            </div>
            <DocumentReviewPane />
          </div>
        </DocumentWorkspaceProvider>
      </RichVisualProvider>
    </TestContext.Provider>
  );
}
