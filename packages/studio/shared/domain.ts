import { z } from 'zod';
import {
  layerAppearanceSchema,
  fontDesignSchema,
  type LayerAppearance,
} from './visual-design.ts';
import {
  cadFeatureSchema,
  sceneImportSchema,
  sceneEnvironmentSchema,
} from './cad-domain.ts';
import {
  documentBlockSchemas,
  isDocumentBlockKind,
  documentBlockText,
} from './document-blocks.ts';
import { videoContentSchema } from './video.ts';
import {
  richVisualSchemas,
  richVisualText,
  type RichVisualKind,
} from './rich-blocks.ts';

export const artifactKinds = [
  'design',
  'document',
  'code',
  'image',
  'video',
  'scene',
  'cad',
  'brand',
  'ui',
] as const;
export const kindSchema = z.enum(artifactKinds);
export type ArtifactKind = z.infer<typeof kindSchema>;
export const kindLabels: Record<ArtifactKind, string> = {
  design: 'Design document',
  document: 'Document',
  code: 'Code',
  image: 'Image',
  video: 'Video',
  scene: '3D scene',
  cad: 'CAD model',
  brand: 'Brand design',
  ui: 'Generated UI',
};
export const roleSchema = z.enum(['owner', 'editor', 'viewer']);
export type Role = z.infer<typeof roleSchema>;
export type User = { id: string; email: string; name: string; color: string };
export type Project = {
  id: string;
  title: string;
  description: string;
  repository: string;
  mainArtifactId: string;
  role: Role;
  updatedAt: string;
};
export type RichNode = {
  type: string;
  attrs?: Record<string, unknown>;
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: RichNode[];
};
export type Artifact = {
  id: string;
  projectId: string;
  kind: ArtifactKind;
  title: string;
  content: Record<string, any>;
  version: number;
  updatedAt: string;
  createdAt: string;
  createdBy: string;
  archived: boolean;
};
export type Decision = {
  id: string;
  artifactId: string;
  title: string;
  context: string;
  decision: string;
  consequences: string;
  status: 'proposed' | 'accepted' | 'superseded';
  version: number;
  author: string;
  updatedAt: string;
};
export type Message = {
  id: string;
  artifactId: string;
  threadId: string;
  author: string;
  authorId: string;
  role: 'user' | 'assistant' | 'system';
  body: string;
  createdAt: string;
  proposal?: Record<string, any> | null;
};
export type Thread = {
  id: string;
  artifactId: string;
  anchor: string | null;
  quote: string;
  resolved: boolean;
  createdAt: string;
};
export type Run = {
  id: string;
  artifactId: string;
  artifactVersion: number;
  status:
    | 'queued'
    | 'running'
    | 'passed'
    | 'failed'
    | 'error'
    | 'interrupted';
  result: Record<string, any> | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
};
export type AuditEntry = {
  id: number;
  artifactId: string | null;
  actor: string;
  action: string;
  detail: string;
  createdAt: string;
};
export type Layer = {
  id: string;
  type: 'rect' | 'ellipse' | 'text' | 'image' | 'path';
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  text: string;
  fontSize: number;
  fontFamily: string;
  start: number;
  duration: number;
  rotation: number;
  src?: string;
  fontUrl?: string;
} & LayerAppearance;
export type Solid = {
  id: string;
  shape: 'box' | 'sphere' | 'cylinder';
  position: [number, number, number];
  rotation: [number, number, number];
  dimensions: [number, number, number];
  color: string;
  operation?: 'union' | 'subtract' | 'intersect';
  name?: string;
  visible?: boolean;
  roughness?: number;
  metalness?: number;
};
const nodeSchema: z.ZodType<RichNode> = z.lazy(
  () =>
    z
      .object({
        type: z.enum([
          'doc',
          'paragraph',
          'text',
          'heading',
          'bulletList',
          'orderedList',
          'listItem',
          'blockquote',
          'codeBlock',
          'hardBreak',
          'horizontalRule',
          'table',
          'tableRow',
          'tableHeader',
          'tableCell',
          'inlineMath',
          'blockMath',
          'image',
          'testBlock',
          'researchBlock',
          'chartBlock',
          'diagramBlock',
          'tabsBlock',
          'calloutBlock',
          'columnsBlock',
          'questionnaireBlock',
          'artifactReferenceBlock',
          'evidenceBlock',
        ]),
        text: z.string().max(200000).optional(),
        attrs: z.record(z.string().max(80), z.json()).optional(),
        marks: z
          .array(
            z
              .object({
                type: z.enum([
                  'bold',
                  'italic',
                  'strike',
                  'code',
                  'link',
                  'underline',
                ]),
                attrs: z.record(z.string(), z.json()).optional(),
              })
              .strict(),
          )
          .max(10)
          .optional(),
        content: z.array(nodeSchema).max(5000).optional(),
      })
      .strict()
      .superRefine((node, context) => {
        if (isDocumentBlockKind(node.type)) {
          const result = documentBlockSchemas[node.type].safeParse(
            node.attrs?.data,
          );
          if (!result.success)
            for (const issue of result.error.issues)
              context.addIssue({
                code: 'custom',
                path: ['attrs', 'data', ...issue.path],
                message: issue.message,
              });
        }
        if (['chartBlock', 'diagramBlock', 'tabsBlock'].includes(node.type)) {
          const parsed = richVisualSchemas[
            node.type as RichVisualKind
          ].safeParse(node.attrs?.data);
          if (!parsed.success)
            for (const issue of parsed.error.issues)
              context.addIssue({
                code: 'custom',
                path: ['attrs', 'data', ...issue.path],
                message: issue.message,
              });
        }
      }) as z.ZodType<RichNode>,
);
const finite = z.number().finite().min(-100000).max(100000);
const localFile = z.string().regex(/^\/api\/files\/[0-9a-f-]{36}$/);
export const layerSchema = z
  .object({
    id: z.string().uuid(),
    type: z.enum(['rect', 'ellipse', 'text', 'image', 'path']),
    x: finite,
    y: finite,
    width: finite.min(1),
    height: finite.min(1),
    fill: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    text: z.string().max(10000),
    fontSize: finite.min(1).max(500),
    fontFamily: z.enum([
      'Inter',
      'Georgia',
      'monospace',
      'Custom',
      'Generated',
    ]),
    start: finite.min(0),
    duration: finite.min(0.1).max(600),
    rotation: finite,
    src: localFile.optional(),
    fontUrl: localFile.optional(),
    ...layerAppearanceSchema.shape,
  })
  .strict()
  .refine(
    (l) => (l.type !== 'path' && l.mask !== 'path') || !!l.path,
    'Vector paths and path masks require bounded path geometry',
  )
  .refine(
    (l) => l.type !== 'image' || !!l.src,
    'Image layers require an uploaded image',
  )
  .refine(
    (l) => l.fontFamily !== 'Custom' || !!l.fontUrl,
    'Custom fonts require an uploaded WOFF2 file',
  );
const vec = z.tuple([finite, finite, finite]);
export const solidSchema = z
  .object({
    id: z.string().uuid(),
    shape: z.enum(['box', 'sphere', 'cylinder']),
    position: vec,
    rotation: vec,
    dimensions: z.tuple([
      finite.min(0.01),
      finite.min(0.01),
      finite.min(0.01),
    ]),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    operation: z.enum(['union', 'subtract', 'intersect']).optional(),
    name: z.string().max(120).optional(),
    visible: z.boolean().optional(),
    roughness: z.number().min(0).max(1).optional(),
    metalness: z.number().min(0).max(1).optional(),
  })
  .strict();
export function contentSchema(kind: ArtifactKind) {
  if (kind === 'design' || kind === 'document')
    return z
      .object({
        doc: nodeSchema.refine(
          (node) => node.type === 'doc',
          'The document root must have type doc',
        ),
      })
      .strict();
  if (kind === 'code')
    return z
      .object({
        files: z
          .record(
            z
              .string()
              .regex(/^[a-zA-Z0-9_./-]{1,200}$/)
              .refine((s) => !s.includes('..') && !s.startsWith('/')),
            z.string().max(500000),
          )
          .refine(
            (v) => Object.keys(v).length > 0 && Object.keys(v).length <= 50,
          ),
        entry: z.string().max(200),
      })
      .strict();
  if (kind === 'video') return videoContentSchema;
  if (kind === 'image' || kind === 'brand')
    return z
      .object({
        width: finite.min(64).max(4096),
        height: finite.min(64).max(4096),
        background: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        layers: z.array(layerSchema).max(200),
        fontDesign: fontDesignSchema.optional(),
        duration: z.number().min(1).max(600),
      })
      .strict();
  if (kind === 'scene' || kind === 'cad')
    return z
      .object({
        solids: z.array(solidSchema).max(200),
        unit: z.enum(['m', 'mm']),
        grid: z.boolean(),
        features: z.array(cadFeatureSchema).max(40).optional(),
        imports: z.array(sceneImportSchema).max(30).optional(),
        environment: sceneEnvironmentSchema.optional(),
      })
      .strict();
  return z
    .object({
      engine: z.enum(['json-render', 'openui']),
      source: z.string().max(200000),
    })
    .strict();
}
export function validateContent(
  kind: ArtifactKind,
  value: unknown,
): Record<string, any> {
  const serialized = JSON.stringify(value);
  if (serialized.length > 2_000_000)
    throw new Error('Artifact exceeds the 2 MB content limit');
  let depth = 0;
  let maxDepth = 0;
  // Bound nesting before recursive parsing. Quotes and escaped braces are excluded by JSON tokenization.
  for (const token of serialized.match(/"(?:\\.|[^"\\])*"|[[\]{}]/g) ?? []) {
    if (token === '{' || token === '[')
      maxDepth = Math.max(maxDepth, ++depth);
    if (token === '}' || token === ']') depth--;
  }
  if (maxDepth > 40) throw new Error('Artifact exceeds the nesting limit');
  return contentSchema(kind).parse(value) as Record<string, any>;
}
export const paragraph = (text: string): RichNode => ({
  type: 'paragraph',
  content: text ? [{ type: 'text', text }] : [],
});
export function initialContent(
  kind: ArtifactKind,
  title: string,
): Record<string, any> {
  if (kind === 'design')
    return {
      doc: {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { level: 1 },
            content: [{ type: 'text', text: title }],
          },
          paragraph(
            'Describe the problem, the people it affects, and what success looks like.',
          ),
          {
            type: 'heading',
            attrs: { level: 2 },
            content: [{ type: 'text', text: 'Intent and scope' }],
          },
          paragraph(
            'What should this project make possible? Record requirements here, then attach executable acceptance tests to the relevant paragraphs.',
          ),
          {
            type: 'heading',
            attrs: { level: 2 },
            content: [{ type: 'text', text: 'Acceptance criteria' }],
          },
          paragraph(
            'Given a project with artifacts, when a teammate opens an artifact, then its document, discussion, and decisions stay together.',
          ),
          {
            type: 'testBlock',
            attrs: {
              label: 'Artifact context stays together',
              scenarioId: '',
            },
          },
          {
            type: 'heading',
            attrs: { level: 2 },
            content: [{ type: 'text', text: 'Decisions and evidence' }],
          },
          paragraph(
            'Capture decisions in the ADR panel. Link pull requests and inspect test evidence from the Tests panel.',
          ),
        ],
      },
    };
  if (kind === 'document')
    return {
      doc: {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { level: 1 },
            content: [{ type: 'text', text: title }],
          },
          paragraph(''),
        ],
      },
    };
  if (kind === 'code')
    return {
      files: {
        'index.html':
          '<!doctype html>\n<html lang="en">\n<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Preview</title></head>\n<body><main><h1>Your next idea.</h1><p>A live preview, independent of your integrations.</p><button id="action">Try it</button><p id="result"></p></main></body>\n</html>',
        'style.css':
          'body { font: 16px system-ui; margin: 0; background: #faf9f6; color: #24292e; }\nmain { max-width: 580px; margin: 15vh auto; padding: 32px; }\nh1 { font-size: 48px; letter-spacing: -.04em; }\nbutton { background: #24292e; color: white; padding: 12px 20px; border: 0; border-radius: 6px; cursor: pointer; }',
        'script.js':
          "document.querySelector('#action').addEventListener('click', () => { document.querySelector('#result').textContent = 'It works.'; });",
      },
      entry: 'index.html',
    };
  if (kind === 'image' || kind === 'brand' || kind === 'video')
    return {
      width: 1280,
      height: 720,
      background: '#f4f1e9',
      duration: 10,
      layers: [
        {
          id: crypto.randomUUID(),
          type: 'text',
          text: title,
          x: 100,
          y: 230,
          width: 1080,
          height: 150,
          fill: '#24292e',
          fontSize: 78,
          fontFamily: 'Inter',
          start: 0,
          duration: 10,
          rotation: 0,
        },
      ],
    };
  if (kind === 'scene' || kind === 'cad')
    return {
      solids: [
        {
          id: crypto.randomUUID(),
          shape: 'box',
          position: [0, 0.5, 0],
          rotation: [0, 0, 0],
          dimensions: [1, 1, 1],
          color: '#6b73d1',
        },
      ],
      unit: kind === 'cad' ? 'mm' : 'm',
      grid: true,
    };
  return {
    engine: 'json-render',
    source: JSON.stringify(
      {
        root: 'root',
        elements: {
          root: { type: 'Stack', props: {}, children: ['title', 'copy'] },
          title: { type: 'Heading', props: { text: title } },
          copy: {
            type: 'Text',
            props: {
              text: 'Generate an interface from a bounded component catalog.',
            },
          },
        },
      },
      null,
      2,
    ),
  };
}
export function docText(node: RichNode): string {
  if (node.text) return node.text;
  if (isDocumentBlockKind(node.type))
    return documentBlockText(node.type, node.attrs?.data);
  if (['chartBlock', 'diagramBlock', 'tabsBlock'].includes(node.type))
    return richVisualText(node.type as RichVisualKind, node.attrs?.data);
  const children = (node.content ?? [])
    .map(docText)
    .join(node.type === 'paragraph' || node.type === 'heading' ? '' : '\n');
  if (node.type === 'heading')
    return `${'#'.repeat(Number(node.attrs?.level) || 2)} ${children}\n`;
  return children;
}
export function capability(
  role: Role,
  action: 'read' | 'write' | 'admin',
): boolean {
  return (
    action === 'read' ||
    (action === 'write' && role !== 'viewer') ||
    (action === 'admin' && role === 'owner')
  );
}
