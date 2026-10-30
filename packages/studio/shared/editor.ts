import { Node, getSchema, mergeAttributes } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import Mathematics from '@tiptap/extension-mathematics';
import Image from '@tiptap/extension-image';
import UniqueID from '@tiptap/extension-unique-id';
import { documentBlockSchemas, documentBlockText, type DocumentBlockKind } from './document-blocks.ts';
import {
  richVisualDefaults,
  richVisualText,
  validateRichVisual,
  type RichVisualKind,
} from './rich-blocks.ts';
export const TestBlock = Node.create({
  name: 'testBlock',
  group: 'block',
  atom: true,
  addAttributes: () => ({
    label: { default: 'Acceptance test' },
    scenarioId: { default: '' },
  }),
  parseHTML: () => [{ tag: 'div[data-test-block]' }],
  renderHTML: ({ HTMLAttributes }) => [
    'div',
    mergeAttributes(HTMLAttributes, {
      'data-test-block': '',
      class: 'test-node',
    }),
    ['span', {}, 'Acceptance test'],
    ['strong', {}, String(HTMLAttributes.label)],
    ['small', {}, 'Open Tests to run and inspect evidence'],
  ],
});
export const ResearchBlock = Node.create({
  name: 'researchBlock',
  group: 'block',
  atom: true,
  addAttributes: () => ({
    brief: { default: 'Research question' },
    artifactId: { default: '' },
    status: { default: 'pending' },
  }),
  parseHTML: () => [{ tag: 'div[data-research-block]' }],
  renderHTML: ({ HTMLAttributes }) => [
    'div',
    mergeAttributes(HTMLAttributes, {
      'data-research-block': '',
      class: 'research-node',
    }),
    ['span', {}, 'Research'],
    ['strong', {}, String(HTMLAttributes.brief)],
    ['small', {}, String(HTMLAttributes.status)],
  ],
});
function visualBlock(name: RichVisualKind) {
  return Node.create({
    name,
    group: 'block',
    atom: true,
    draggable: true,
    addAttributes: () => ({
      data: {
        default: richVisualDefaults[name],
        validate: (value: unknown) => {
          validateRichVisual(name, value);
        },
        renderHTML: () => ({}),
      },
    }),
    parseHTML: () => [],
    // Export readable, escaped prose. Pasted HTML cannot inject executable block attributes.
    renderHTML: ({ node, HTMLAttributes }) => [
      'div',
      {
        'data-rich-block': name,
        class: 'rich-visual-export',
        ...(HTMLAttributes.id ? { id: HTMLAttributes.id } : {}),
      },
      ['pre', {}, richVisualText(name, node.attrs.data)],
    ],
  });
}
export const ChartBlock = visualBlock('chartBlock');
export const DiagramBlock = visualBlock('diagramBlock');
export const TabsBlock = visualBlock('tabsBlock');
export const DocumentBlocks = Object.keys(documentBlockSchemas).map((kind) => {
  const name = kind as DocumentBlockKind;
  return Node.create({
    name,
    group: 'block',
    atom: true,
    draggable: true,
    addAttributes: () => ({ data: { default: null, validate: (value: unknown) => { documentBlockSchemas[name].parse(value); }, renderHTML: () => ({}) } }),
    parseHTML: () => [],
    renderHTML: ({ node, HTMLAttributes }) => ['section', { 'data-document-component': name, ...(HTMLAttributes.id ? { id: HTMLAttributes.id } : {}) }, ['pre', {}, documentBlockText(name, node.attrs.data)]],
  });
});
export const baseExtensions = () => [
  StarterKit.configure({
    undoRedo: false,
    link: {
      openOnClick: false,
      protocols: ['https', 'http', 'mailto'],
      isAllowedUri: (url: string) =>
        /^(https?:\/\/|mailto:|\/api\/files\/|#)/i.test(url),
    },
  }),
  TableKit.configure({ table: { resizable: true } }),
  Mathematics.configure({
    katexOptions: { throwOnError: false, trust: false },
  }),
  Image.configure({ allowBase64: false }),
  TestBlock,
  ResearchBlock,
  ChartBlock,
  DiagramBlock,
  TabsBlock,
  ...DocumentBlocks,
  UniqueID.configure({
    types: [
      'heading',
      'paragraph',
      'testBlock',
      'researchBlock',
      'chartBlock',
      'diagramBlock',
      'tabsBlock',
      'table',
      'blockquote',
      'codeBlock',
      ...Object.keys(documentBlockSchemas),
    ],
  }),
];
export const editorSchema = () => getSchema(baseExtensions());
