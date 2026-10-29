import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  prosemirrorJSONToYDoc,
  yXmlFragmentToProsemirrorJSON,
} from 'y-prosemirror';
import { editorSchema } from '../shared/editor.ts';
import { docText, validateContent, type RichNode } from '../shared/domain.ts';
import {
  assertRichVisualUnchanged,
  chartDataSchema,
  chartRange,
  diagramDataSchema,
  richVisualDefaults,
  tabsDataSchema,
} from '../shared/rich-blocks.ts';

describe('bounded interactive document blocks', () => {
  it('refuses an edit based on stale visual block data while accepting unchanged data', () => {
    const opening = structuredClone(richVisualDefaults.chartBlock);
    expect(() =>
      assertRichVisualUnchanged(
        'chartBlock',
        opening,
        structuredClone(opening),
      ),
    ).not.toThrow();
    expect(() =>
      assertRichVisualUnchanged('chartBlock', opening, {
        ...opening,
        title: 'A teammate’s newer chart',
      }),
    ).toThrow('Your typed source is retained');
    expect(() =>
      assertRichVisualUnchanged('chartBlock', opening, {
        ...opening,
        points: [{ label: 'Updated evidence', value: 20 }],
      }),
    ).toThrow('A teammate changed this block');
  });
  it('round-trips charts, diagrams, and tabs through the collaborative document format', () => {
    const schema = editorSchema(),
      nodes = ['chartBlock', 'diagramBlock', 'tabsBlock'] as const;
    const doc = {
      type: 'doc',
      content: nodes.map((type) => ({
        type,
        attrs: { data: richVisualDefaults[type] },
      })),
    };
    const first = prosemirrorJSONToYDoc(schema, doc, 'default'),
      second = new Y.Doc();
    Y.applyUpdate(second, Y.encodeStateAsUpdate(first));
    const result = yXmlFragmentToProsemirrorJSON(
      second.getXmlFragment('default'),
    );
    schema.nodeFromJSON(result).check();
    expect(result.content.map((node: any) => node.type)).toEqual(nodes);
    for (let index = 0; index < nodes.length; index++)
      expect(result.content[index].attrs.data).toEqual(
        richVisualDefaults[nodes[index]!],
      );
    first.destroy();
    second.destroy();
  });
  it('validates bounded values and node references before accepting content imports', () => {
    expect(() =>
      validateContent('document', {
        doc: {
          type: 'doc',
          content: [
            {
              type: 'chartBlock',
              attrs: {
                data: {
                  ...richVisualDefaults.chartBlock,
                  points: [{ label: 'unbounded', value: 1e100 }],
                },
              },
            },
          ],
        },
      }),
    ).toThrow();
    const invalidDiagram = {
      ...richVisualDefaults.diagramBlock,
      edges: [{ from: 'intent', to: 'missing', label: '' }],
    };
    expect(diagramDataSchema.safeParse(invalidDiagram).success).toBe(false);
    expect(() =>
      validateContent('document', {
        doc: {
          type: 'doc',
          content: [{ type: 'diagramBlock', attrs: { data: invalidDiagram } }],
        },
      }),
    ).toThrow();
    const invalidTabs = {
      title: 'Tabs',
      tabs: [
        { id: 'x', label: 'A', body: '' },
        { id: 'x', label: 'B', body: '' },
      ],
    };
    expect(tabsDataSchema.safeParse(invalidTabs).success).toBe(false);
    expect(
      chartDataSchema.safeParse({
        ...richVisualDefaults.chartBlock,
        component: 'eval',
      }).success,
    ).toBe(false);
  });
  it('rejects overlarge arrays and duplicate or out-of-bounds diagram nodes', () => {
    expect(
      chartDataSchema.safeParse({
        ...richVisualDefaults.chartBlock,
        points: Array.from({ length: 31 }, () => ({ label: 'x', value: 1 })),
      }).success,
    ).toBe(false);
    expect(
      diagramDataSchema.safeParse({
        ...richVisualDefaults.diagramBlock,
        nodes: [
          richVisualDefaults.diagramBlock.nodes[0],
          richVisualDefaults.diagramBlock.nodes[0],
        ],
      }).success,
    ).toBe(false);
    expect(
      diagramDataSchema.safeParse({
        ...richVisualDefaults.diagramBlock,
        nodes: [{ id: 'x', label: 'Outside viewport', x: 1000, y: 0 }],
        edges: [],
      }).success,
    ).toBe(false);
  });
  it('enforces visual attribute schemas inside ProseMirror as well as API import validation', () => {
    expect(() =>
      editorSchema().nodeFromJSON({
        type: 'doc',
        content: [
          { type: 'chartBlock', attrs: { data: { title: 'Missing points' } } },
        ],
      }),
    ).toThrow();
    const schema = editorSchema(),
      node = schema.nodeFromJSON({
        type: 'chartBlock',
        attrs: {
          data: {
            ...richVisualDefaults.chartBlock,
            title: '<script>alert(1)</script>',
          },
        },
      });
    const rendered = schema.nodes.chartBlock!.spec.toDOM!(
      node,
    ) as unknown as any[];
    expect(rendered[1]).not.toHaveProperty('onclick');
    expect(rendered[1]).not.toHaveProperty('data');
    expect(rendered[2][2]).toContain('<script>alert(1)</script>');
    // The export is a DOM output spec whose only dynamic output is escaped text, never raw HTML.
    expect(rendered[2][0]).toBe('pre');
    expect(typeof rendered[2][2]).toBe('string');
  });
  it('preserves visual content in source documents used by ai-bdd and Markdown exports', () => {
    const doc: RichNode = {
      type: 'doc',
      content: [
        { type: 'chartBlock', attrs: { data: richVisualDefaults.chartBlock } },
        {
          type: 'diagramBlock',
          attrs: { data: richVisualDefaults.diagramBlock },
        },
        { type: 'tabsBlock', attrs: { data: richVisualDefaults.tabsBlock } },
      ],
    };
    const source = docText(doc);
    expect(source).toContain('Planned: 12');
    expect(source).toContain('Design document → Artifact');
    expect(source).toContain('Chosen approach');
    expect(source).toContain('Record risks');
  });
  it('defines finite ranges for zero-only and negative chart data', () => {
    expect(chartRange([{ label: 'Zero', value: 0 }])).toEqual({
      min: 0,
      max: 1,
    });
    expect(
      chartRange([
        { label: 'Loss', value: -5 },
        { label: 'Gain', value: 3 },
      ]),
    ).toEqual({ min: -5, max: 3 });
  });
});
