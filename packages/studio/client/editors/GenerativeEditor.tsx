import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import Editor from '@monaco-editor/react';
import { z } from 'zod';
import { defineCatalog, validateSpec } from '@json-render/core';
import {
  defineRegistry,
  JSONUIProvider,
  Renderer as JsonRenderer,
  schema as jsonSchema,
} from '@json-render/react';
import {
  createLibrary,
  createParser,
  defineComponent,
  Renderer as OpenRenderer,
  useRenderNode,
  type ParseResult,
} from '@openuidev/react-lang';
import {
  Braces,
  Check,
  ClipboardCopy,
  Code2,
  Download,
  LayoutTemplate,
  Monitor,
  Save,
  Sparkles,
} from 'lucide-react';
import type { MediaProps } from '../App.tsx';
import { api, download } from '../lib.ts';
import {
  Badge,
  Button,
  ErrorBoundary,
  IconButton,
  Input,
  Select,
  Spinner,
} from '../components/ui.tsx';
import { localMonaco } from './CodeEditor.tsx';
import './GenerativeEditor.css';

const NotifyContext = createContext<(message: string) => void>(() => {});
const text = z.string().max(20000);
const propertySchemas = {
  Stack: z
    .object({
      direction: z.enum(['vertical', 'horizontal']).default('vertical'),
      gap: z.enum(['sm', 'md', 'lg']).default('md'),
    })
    .strict(),
  Card: z
    .object({ title: text.optional(), description: text.optional() })
    .strict(),
  Heading: z
    .object({ text, level: z.enum(['h1', 'h2', 'h3']).default('h2') })
    .strict(),
  Text: z.object({ text }).strict(),
  Badge: z
    .object({
      text,
      tone: z.enum(['neutral', 'green', 'amber', 'purple']).default('neutral'),
    })
    .strict(),
  Button: z
    .object({ label: text, message: text.default('Preview action completed') })
    .strict(),
  Input: z.object({ label: text, placeholder: text.default('') }).strict(),
  Metric: z.object({ label: text, value: text }).strict(),
  Progress: z
    .object({ label: text, value: z.number().min(0).max(100) })
    .strict(),
  Separator: z.object({}).strict(),
};
type ComponentName = keyof typeof propertySchemas;
const catalog = defineCatalog(jsonSchema, {
  components: {
    Stack: {
      props: propertySchemas.Stack,
      slots: ['default'],
      description: 'Horizontal or vertical content layout.',
    },
    Card: {
      props: propertySchemas.Card,
      slots: ['default'],
      description: 'Groups related content.',
    },
    Heading: {
      props: propertySchemas.Heading,
      description: 'A document heading.',
    },
    Text: {
      props: propertySchemas.Text,
      description: 'A plain text paragraph.',
    },
    Badge: {
      props: propertySchemas.Badge,
      description: 'A small status indicator.',
    },
    Button: {
      props: propertySchemas.Button,
      description:
        'Local preview action displaying its message; never calls a live backend.',
    },
    Input: {
      props: propertySchemas.Input,
      description: 'A locally editable text field.',
    },
    Metric: {
      props: propertySchemas.Metric,
      description: 'A labelled numeric or text value.',
    },
    Progress: {
      props: propertySchemas.Progress,
      description: 'Progress from zero to one hundred.',
    },
    Separator: {
      props: propertySchemas.Separator,
      description: 'A content divider.',
    },
  },
  actions: {},
});
function PreviewButton({ label, message }: { label: string; message: string }) {
  const notify = useContext(NotifyContext);
  return <Button onClick={() => notify(message)}>{label}</Button>;
}
function PreviewInput({
  label,
  placeholder,
}: {
  label: string;
  placeholder: string;
}) {
  return (
    <label className="generated-input">
      <span>{label}</span>
      <Input placeholder={placeholder} />
    </label>
  );
}
function PreviewHeading({ text, level }: { text: string; level: string }) {
  return level === 'h1' ? (
    <h1>{text}</h1>
  ) : level === 'h3' ? (
    <h3>{text}</h3>
  ) : (
    <h2>{text}</h2>
  );
}
const { registry } = defineRegistry(catalog, {
  components: {
    Stack: ({ props, children }) => (
      <div
        className={`generated-stack generated-stack-${props.direction} generated-gap-${props.gap}`}
      >
        {children}
      </div>
    ),
    Card: ({ props, children }) => (
      <section className="generated-card">
        {props.title && <h3>{props.title}</h3>}
        {props.description && <p>{props.description}</p>}
        {children}
      </section>
    ),
    Heading: ({ props }) => (
      <PreviewHeading
        text={String(props.text)}
        level={String(props.level ?? 'h2')}
      />
    ),
    Text: ({ props }) => <p>{String(props.text)}</p>,
    Badge: ({ props }) => <Badge tone={props.tone}>{String(props.text)}</Badge>,
    Button: ({ props }) => (
      <PreviewButton
        label={String(props.label)}
        message={String(props.message ?? 'Preview action completed')}
      />
    ),
    Input: ({ props }) => (
      <PreviewInput
        label={String(props.label)}
        placeholder={String(props.placeholder ?? '')}
      />
    ),
    Metric: ({ props }) => (
      <div className="generated-metric">
        <span>{String(props.label)}</span>
        <strong>{String(props.value)}</strong>
      </div>
    ),
    Progress: ({ props }) => (
      <label className="generated-progress">
        <span>
          {String(props.label)} · {Number(props.value)}%
        </span>
        <progress value={Number(props.value)} max={100} />
      </label>
    ),
    Separator: () => <hr />,
  },
});
const OpenStack = defineComponent({
  name: 'Stack',
  description: 'Layout for nested UI components.',
  props: z.object({
    children: z.array(z.any()).max(100),
    direction: z.enum(['vertical', 'horizontal']).default('vertical'),
    gap: z.enum(['sm', 'md', 'lg']).default('md'),
  }),
  component: ({ props }) => {
    const render = useRenderNode();
    return (
      <div
        className={`generated-stack generated-stack-${props.direction} generated-gap-${props.gap}`}
      >
        {props.children.map((child, index) => (
          <div key={index}>{render(child)}</div>
        ))}
      </div>
    );
  },
});
const OpenCard = defineComponent({
  name: 'Card',
  description: 'Groups related content in a surface.',
  props: z.object({
    title: text,
    children: z.array(z.any()).max(100),
    description: text.default(''),
  }),
  component: ({ props }) => {
    const render = useRenderNode();
    return (
      <section className="generated-card">
        <h3>{props.title}</h3>
        {props.description && <p>{props.description}</p>}
        {props.children.map((child, index) => (
          <div key={index}>{render(child)}</div>
        ))}
      </section>
    );
  },
});
const openLibrary = createLibrary({
  root: 'Stack',
  components: [
    OpenStack,
    OpenCard,
    defineComponent({
      name: 'Heading',
      description: 'A document heading.',
      props: propertySchemas.Heading,
      component: ({ props }) => <PreviewHeading {...props} />,
    }),
    defineComponent({
      name: 'Text',
      description: 'Plain text paragraph.',
      props: propertySchemas.Text,
      component: ({ props }) => <p>{props.text}</p>,
    }),
    defineComponent({
      name: 'Badge',
      description: 'Small status indicator.',
      props: propertySchemas.Badge,
      component: ({ props }) => <Badge tone={props.tone}>{props.text}</Badge>,
    }),
    defineComponent({
      name: 'Button',
      description: 'Local preview button displaying its message.',
      props: propertySchemas.Button,
      component: ({ props }) => <PreviewButton {...props} />,
    }),
    defineComponent({
      name: 'Input',
      description: 'A locally editable text input.',
      props: propertySchemas.Input,
      component: ({ props }) => <PreviewInput {...props} />,
    }),
    defineComponent({
      name: 'Metric',
      description: 'Labelled numeric or text value.',
      props: propertySchemas.Metric,
      component: ({ props }) => (
        <div className="generated-metric">
          <span>{props.label}</span>
          <strong>{props.value}</strong>
        </div>
      ),
    }),
    defineComponent({
      name: 'Progress',
      description: 'Progress from zero to one hundred.',
      props: propertySchemas.Progress,
      component: ({ props }) => (
        <label className="generated-progress">
          <span>
            {props.label} · {props.value}%
          </span>
          <progress value={props.value} max={100} />
        </label>
      ),
    }),
    defineComponent({
      name: 'Separator',
      description: 'Content divider.',
      props: propertySchemas.Separator,
      component: () => <hr />,
    }),
  ],
});
type GeneratedContent = { engine: 'json-render' | 'openui'; source: string };
const jsonExample = JSON.stringify(
  {
    root: 'root',
    elements: {
      root: {
        type: 'Stack',
        props: { direction: 'vertical', gap: 'lg' },
        children: ['heading', 'description', 'card'],
      },
      heading: {
        type: 'Heading',
        props: { text: 'Ready for your next idea.', level: 'h1' },
      },
      description: {
        type: 'Text',
        props: {
          text: 'A small, editable interface built from a bounded component catalog.',
        },
      },
      card: {
        type: 'Card',
        props: {
          title: 'Project details',
          description: 'This form works locally without a backend connection.',
        },
        children: ['input', 'action'],
      },
      input: {
        type: 'Input',
        props: {
          label: 'Project name',
          placeholder: 'Give your project a name',
        },
      },
      action: {
        type: 'Button',
        props: {
          label: 'Try the preview',
          message: 'Your local preview action completed.',
        },
      },
    },
  },
  null,
  2,
);
const openExample =
  'root = Stack([Heading("Ready for your next idea.", "h1"), Text("A small, editable interface built from a bounded component catalog."), Card("Project details", [Input("Project name", "Give your project a name"), Button("Try the preview", "Your local preview action completed.")], "This form works locally without a backend connection.")], "vertical", "lg")';
function parseJson(source: string) {
  const raw = JSON.parse(source);
  const envelope = z
    .object({
      root: z.string().min(1).max(100),
      elements: z.record(
        z.string().max(100),
        z
          .object({
            type: z.enum(
              Object.keys(propertySchemas) as [
                ComponentName,
                ...ComponentName[],
              ],
            ),
            props: z.record(z.string(), z.json()),
            children: z.array(z.string().max(100)).max(100).optional(),
          })
          .strict(),
      ),
    })
    .strict()
    .parse(raw);
  if (Object.keys(envelope.elements).length > 300)
    throw new Error('The preview supports up to 300 components');
  const resolved = {
    root: envelope.root,
    elements: Object.fromEntries(
      Object.entries(envelope.elements).map(([key, element]) => [
        key,
        {
          ...element,
          props: propertySchemas[element.type].parse(element.props),
          children: element.children ?? [],
        },
      ]),
    ),
  };
  const current = new Set<string>();
  let renderedCount = 0;
  const visit = (key: string, depth: number) => {
    if (depth > 20)
      throw new Error('The preview supports up to 20 nested component levels');
    if (++renderedCount > 1000)
      throw new Error(
        'The preview supports up to 1000 rendered component instances',
      );
    if (current.has(key)) throw new Error('Components cannot contain a cycle');
    if (!Object.hasOwn(envelope.elements, key))
      throw new Error(`Component ${key} is missing`);
    const element = envelope.elements[key]!;
    current.add(key);
    for (const child of element.children ?? []) visit(child, depth + 1);
    current.delete(key);
  };
  visit(envelope.root, 0);
  const validated = catalog.validate(resolved);
  if (!validated.success)
    throw new Error(
      validated.error?.issues.map((issue) => issue.message).join('; ') ??
        'Invalid component catalog data',
    );
  const structure = validateSpec(resolved);
  if (!structure.valid)
    throw new Error(structure.issues.map((issue) => issue.message).join('; '));
  return validated.data as any;
}
function parseOpen(source: string): ParseResult {
  const result = createParser(
    openLibrary.toJSONSchema(),
    openLibrary.root,
  ).parse(source);
  if (
    !result.root ||
    result.meta.errors.length ||
    result.meta.unresolved.length ||
    result.meta.incomplete
  )
    throw new Error(
      result.meta.errors
        .map((error) => `${error.component}: ${error.message}`)
        .join('; ') ||
        (result.meta.unresolved.length
          ? `Unresolved components: ${result.meta.unresolved.join(', ')}`
          : 'Complete the root Stack expression'),
    );
  if (
    result.queryStatements.length ||
    result.mutationStatements.length ||
    Object.keys(result.stateDeclarations).length
  )
    throw new Error(
      'This preview uses local components; remote Query, Mutation, and reactive declarations are disabled',
    );
  let count = 0;
  const walk = (value: unknown, depth: number) => {
    if (depth > 35 || ++count > 10000)
      throw new Error('The OpenUI preview is too deeply nested or too large');
    if (Array.isArray(value)) value.forEach((child) => walk(child, depth + 1));
    else if (value && typeof value === 'object')
      Object.values(value).forEach((child) => walk(child, depth + 1));
  };
  walk(result.root, 0);
  return result;
}

export default function GenerativeEditor({
  artifact,
  readOnly,
  onSave,
  onDirty,
  onError,
}: MediaProps) {
  // Importing this binding configures Monaco's bundled workers without a CDN.
  void localMonaco;
  const [draft, setDraft] = useState<GeneratedContent>(
      () => structuredClone(artifact.content) as GeneratedContent,
    ),
    [baseVersion, setBaseVersion] = useState(artifact.version),
    [dirty, setDirty] = useState(false),
    [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<'preview' | 'source'>('preview'),
    [rendered, setRendered] = useState(draft),
    [notice, setNotice] = useState(''),
    [prompt, setPrompt] = useState(''),
    [generating, setGenerating] = useState(false),
    [agentAvailable, setAgentAvailable] = useState(false);
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(() => {
    if (!dirty && artifact.version !== baseVersion) {
      setDraft(structuredClone(artifact.content) as GeneratedContent);
      setBaseVersion(artifact.version);
    }
  }, [artifact.version, artifact.content, dirty, baseVersion]);
  useEffect(() => {
    const timer = setTimeout(() => setRendered(draft), 400);
    return () => clearTimeout(timer);
  }, [draft]);
  useEffect(() => {
    api('/capabilities')
      .then((result) => setAgentAvailable(!!result.agent))
      .catch(() => setAgentAvailable(false));
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 6000);
    return () => clearTimeout(timer);
  }, [notice]);
  const validation = useMemo(() => {
    try {
      if (rendered.source.length > 200000)
        throw new Error('Source exceeds the 200 KB preview limit');
      return {
        value:
          rendered.engine === 'json-render'
            ? parseJson(rendered.source)
            : parseOpen(rendered.source),
        error: '',
      };
    } catch (error) {
      return { value: null, error: (error as Error).message };
    }
  }, [rendered]);
  const mutate = (next: GeneratedContent) => {
    if (!readOnly) {
      setDraft(next);
      setDirty(true);
    }
  };
  async function save() {
    setSaving(true);
    try {
      if (draft.engine === 'json-render') parseJson(draft.source);
      else parseOpen(draft.source);
      await onSave(draft, baseVersion);
      setBaseVersion(baseVersion + 1);
      setDirty(false);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function generate(event: React.FormEvent) {
    event.preventDefault();
    if (!prompt.trim() || !agentAvailable) return;
    setGenerating(true);
    try {
      if (dirty)
        throw new Error(
          'Save your source changes before asking the agent for an edit proposal.',
        );
      const bundle = await api(`/artifacts/${artifact.id}`),
        thread = bundle.threads.find((item: any) => !item.anchor);
      if (!thread) throw new Error('This artifact has no main conversation');
      const instructions =
        draft.engine === 'json-render'
          ? catalog.prompt({
              customRules: [
                'Use only literal props and children. Do not add actions, state, on, slots, expressions, or external resources. Maximum 300 components, 20 levels. Return the whole JSON spec as a serialized string in content.source.',
              ],
            })
          : openLibrary.prompt({
              additionalRules: [
                'Root must be Stack. Use only the provided components and literal props. Do not emit Query, Mutation, state variables, functions, or external resources. Return the whole OpenUI Lang program as content.source.',
              ],
            });
      await api(`/artifacts/${artifact.id}/messages`, 'POST', {
        threadId: thread.id,
        body: `Build a ${draft.engine} UI: ${prompt.trim()}\n\nKeep content.engine = "${draft.engine}". The content object must have only engine and source.\n${instructions}`,
      });
      await api(`/artifacts/${artifact.id}/agent`, 'POST', {
        threadId: thread.id,
        intent: 'edit',
      });
      setNotice(
        'The agent task finished. Open Chat to review its response and any edit proposal.',
      );
      setPrompt('');
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setGenerating(false);
    }
  }
  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(
        draft.engine === 'json-render'
          ? catalog.prompt()
          : openLibrary.prompt(),
      );
      setNotice('Component catalog prompt copied.');
    } catch {
      onError(
        'Clipboard access was denied. Download the catalog prompt instead.',
      );
    }
  }
  return (
    <div className="generated-editor">
      <div className="media-toolbar code-toolbar">
        <div
          className="media-tabs"
          role="tablist"
          aria-label="Generated UI canvas"
        >
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
            aria-selected={tab === 'source'}
            onClick={() => setTab('source')}
          >
            <Code2 size={14} />
            Source
          </button>
        </div>
        <div className="code-toolbar-actions">
          <Select
            aria-label="UI rendering engine"
            value={draft.engine}
            onChange={(event) =>
              mutate({
                ...draft,
                engine: event.target.value as GeneratedContent['engine'],
              })
            }
            disabled={readOnly}
            className="generated-engine"
          >
            <option value="json-render">json-render</option>
            <option value="openui">OpenUI Lang</option>
          </Select>
          <IconButton
            label="Download UI source"
            onClick={() =>
              download(
                artifact.title +
                  (draft.engine === 'json-render' ? '.json' : '.openui'),
                draft.source,
                'text/plain',
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
      {dirty && artifact.version !== baseVersion && (
        <div className="draft-notice" role="alert">
          <span>
            A newer version is available. Your local source is retained.
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              download(
                `${artifact.title}-local-draft.json`,
                JSON.stringify(draft, null, 2),
              )
            }
          >
            Download my draft
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setDraft(structuredClone(artifact.content) as GeneratedContent);
              setBaseVersion(artifact.version);
              setDirty(false);
            }}
          >
            Load latest
          </Button>
        </div>
      )}
      <div className="generated-layout">
        {tab === 'source' ? (
          <section className="generated-source">
            <div className="generated-source-heading">
              <Braces size={14} />
              <span>
                {draft.engine === 'json-render'
                  ? 'interface.json'
                  : 'interface.openui'}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  mutate({
                    ...draft,
                    source:
                      draft.engine === 'json-render'
                        ? jsonExample
                        : openExample,
                  })
                }
                disabled={readOnly}
              >
                Insert example
              </Button>
            </div>
            <Editor
              height="100%"
              path={`inmemory://studio/${artifact.id}/interface.${draft.engine === 'json-render' ? 'json' : 'txt'}`}
              language={draft.engine === 'json-render' ? 'json' : 'plaintext'}
              value={draft.source}
              onChange={(source) => {
                if (source !== draft.source)
                  mutate({ ...draft, source: source ?? '' });
              }}
              loading={<Spinner label="Loading local editor…" />}
              options={{
                readOnly,
                minimap: { enabled: false },
                fontSize: 12,
                padding: { top: 16 },
                wordWrap: 'on',
                automaticLayout: true,
                scrollBeyondLastLine: false,
                ariaLabel: `${draft.engine} UI source`,
              }}
            />
          </section>
        ) : (
          <div className="generated-preview-wrap">
            <div className="generated-preview">
              <ErrorBoundary resetKey={rendered.engine + rendered.source}>
                <NotifyContext.Provider value={setNotice}>
                  {validation.error ? (
                    <div className="code-preview-error" role="alert">
                      <strong>Complete the UI definition</strong>
                      <p>{validation.error}</p>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setTab('source')}
                      >
                        Edit source
                      </Button>
                    </div>
                  ) : rendered.engine === 'json-render' ? (
                    <JSONUIProvider registry={registry}>
                      <JsonRenderer
                        spec={validation.value}
                        registry={registry}
                      />
                    </JSONUIProvider>
                  ) : (
                    <OpenRenderer
                      response={rendered.source}
                      library={openLibrary}
                      isStreaming={false}
                      toolProvider={null}
                    />
                  )}
                </NotifyContext.Provider>
              </ErrorBoundary>
            </div>
          </div>
        )}
        <aside className="generated-catalog">
          <div className="catalog-title">
            <LayoutTemplate size={16} />
            <h3>Component catalog</h3>
          </div>
          <p>
            A bounded set of accessible components. Generated definitions render
            here without executing JavaScript.
          </p>
          <div className="catalog-components">
            {Object.keys(propertySchemas).map((name) => (
              <span key={name}>{name}</span>
            ))}
          </div>
          <div className="catalog-actions">
            <Button variant="outline" size="sm" onClick={copyPrompt}>
              <ClipboardCopy size={13} />
              Copy catalog prompt
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                download(
                  'studio-ui-catalog.txt',
                  draft.engine === 'json-render'
                    ? catalog.prompt()
                    : openLibrary.prompt(),
                  'text/plain',
                )
              }
            >
              Download prompt
            </Button>
          </div>
          <div className="catalog-note">
            <Check size={13} />
            <span>
              Text is escaped. No external URLs, remote tools, or arbitrary
              component imports.
            </span>
          </div>
        </aside>
      </div>
      {notice && (
        <div className="generated-notice" role="status">
          {notice}
        </div>
      )}
      <form className="generated-prompt" onSubmit={generate}>
        <Sparkles size={16} />
        <Input
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={
            agentAvailable
              ? 'Describe the interface you want to create…'
              : 'AI generation needs an operator-configured model'
          }
          aria-label="Describe UI to generate"
          disabled={readOnly || !agentAvailable || generating}
          maxLength={3000}
        />
        <Button
          size="sm"
          disabled={readOnly || !agentAvailable || generating || !prompt.trim()}
        >
          {generating ? <Spinner label="Generating…" /> : 'Propose UI'}
        </Button>
      </form>
      <div className="editor-statusbar">
        <span>
          <span className="status-dot" />
          {draft.engine === 'json-render' ? 'json-render' : 'OpenUI Lang'} · 10
          components
        </span>
        <span>
          {validation.error ? 'Definition needs attention' : 'Definition valid'}
        </span>
        <span className="statusbar-spacer" />
        <span>Buttons and fields use local preview behavior</span>
      </div>
    </div>
  );
}
