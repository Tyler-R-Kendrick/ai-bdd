import { z } from 'zod';

const label = z.string().trim().min(1).max(180);
export const chartDataSchema = z
  .object({
    title: label,
    description: z.string().max(1000).default(''),
    kind: z.enum(['bar', 'line']),
    points: z
      .array(
        z
          .object({
            label: z.string().trim().min(1).max(60),
            value: z.number().finite().min(-1e9).max(1e9),
          })
          .strict(),
      )
      .min(1)
      .max(30),
  })
  .strict();
export const diagramDataSchema = z
  .object({
    title: label,
    description: z.string().max(1000).default(''),
    nodes: z
      .array(
        z
          .object({
            id: z.string().regex(/^[A-Za-z0-9_-]{1,50}$/),
            label: z.string().trim().min(1).max(100),
            x: z.number().finite().min(0).max(640),
            y: z.number().finite().min(0).max(320),
          })
          .strict(),
      )
      .min(1)
      .max(30),
    edges: z
      .array(
        z
          .object({
            from: z.string().max(50),
            to: z.string().max(50),
            label: z.string().max(80).default(''),
          })
          .strict(),
      )
      .max(60),
  })
  .strict()
  .superRefine((data, context) => {
    const ids = new Set(data.nodes.map((node) => node.id));
    if (ids.size !== data.nodes.length)
      context.addIssue({
        code: 'custom',
        message: 'Diagram node IDs must be unique',
        path: ['nodes'],
      });
    data.edges.forEach((edge, index) => {
      if (!ids.has(edge.from) || !ids.has(edge.to))
        context.addIssue({
          code: 'custom',
          message: 'Every edge must reference existing node IDs',
          path: ['edges', index],
        });
      if (edge.from === edge.to)
        context.addIssue({
          code: 'custom',
          message:
            'Connect two different nodes; self-loop edges are not supported',
          path: ['edges', index],
        });
    });
  });
export const tabsDataSchema = z
  .object({
    title: label,
    tabs: z
      .array(
        z
          .object({
            id: z.string().regex(/^[A-Za-z0-9_-]{1,50}$/),
            label: z.string().trim().min(1).max(60),
            body: z.string().max(12000),
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict()
  .superRefine((data, context) => {
    if (new Set(data.tabs.map((tab) => tab.id)).size !== data.tabs.length)
      context.addIssue({
        code: 'custom',
        message: 'Tab IDs must be unique',
        path: ['tabs'],
      });
  });
export type ChartData = z.infer<typeof chartDataSchema>;
export type DiagramData = z.infer<typeof diagramDataSchema>;
export type TabsData = z.infer<typeof tabsDataSchema>;
export type RichVisualKind = 'chartBlock' | 'diagramBlock' | 'tabsBlock';
export const richVisualSchemas = {
  chartBlock: chartDataSchema,
  diagramBlock: diagramDataSchema,
  tabsBlock: tabsDataSchema,
};
export const richVisualDefaults = {
  chartBlock: {
    title: 'Acceptance coverage',
    description: 'Illustrative values. Replace with your project data.',
    kind: 'bar',
    points: [
      { label: 'Planned', value: 12 },
      { label: 'Implemented', value: 8 },
      { label: 'Verified', value: 5 },
    ],
  } satisfies ChartData,
  diagramBlock: {
    title: 'Artifact workflow',
    description:
      'A proposed flow. Edit the nodes and connections to match your system.',
    nodes: [
      { id: 'intent', label: 'Design document', x: 20, y: 130 },
      { id: 'artifact', label: 'Artifact', x: 290, y: 130 },
      { id: 'evidence', label: 'Tests & evidence', x: 560, y: 130 },
    ],
    edges: [
      { from: 'intent', to: 'artifact', label: 'composes' },
      { from: 'artifact', to: 'evidence', label: 'verifies' },
    ],
  } satisfies DiagramData,
  tabsBlock: {
    title: 'Implementation approaches',
    tabs: [
      {
        id: 'chosen',
        label: 'Chosen approach',
        body: 'Describe the proposed implementation and the constraints it satisfies.',
      },
      {
        id: 'alternatives',
        label: 'Alternatives',
        body: 'Compare viable alternatives and record why they were accepted or declined.',
      },
      {
        id: 'risks',
        label: 'Risks',
        body: 'Record risks, validation steps, and evidence still needed.',
      },
    ],
  } satisfies TabsData,
};
export function validateRichVisual(
  kind: RichVisualKind,
  value: unknown,
): ChartData | DiagramData | TabsData {
  return richVisualSchemas[kind].parse(value);
}
export function chartRange(points: ChartData['points']): {
  min: number;
  max: number;
} {
  const min = Math.min(0, ...points.map((point) => point.value)),
    max = Math.max(0, ...points.map((point) => point.value));
  return min === max ? { min: 0, max: 1 } : { min, max };
}
export function richVisualText(kind: RichVisualKind, value: unknown): string {
  const data = validateRichVisual(kind, value);
  if (kind === 'chartBlock') {
    const chart = data as ChartData;
    return `${chart.title}\n${chart.description}\n${chart.points.map((point) => `${point.label}: ${point.value}`).join('\n')}`;
  }
  if (kind === 'diagramBlock') {
    const diagram = data as DiagramData;
    const labels = new Map(diagram.nodes.map((node) => [node.id, node.label]));
    return `${diagram.title}\n${diagram.description}\n${diagram.edges.map((edge) => `${labels.get(edge.from)} → ${labels.get(edge.to)}${edge.label ? ` (${edge.label})` : ''}`).join('\n')}`;
  }
  const tabs = data as TabsData;
  return `${tabs.title}\n${tabs.tabs.map((tab) => `${tab.label}\n${tab.body}`).join('\n\n')}`;
}
