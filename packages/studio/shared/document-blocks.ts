import { z } from 'zod';

const label = z.string().trim().min(1).max(180);
const text = z.string().max(20000);
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
export const documentBlockSchemas = {
  calloutBlock: z.object({ title: label, body: text, tone: z.enum(['note', 'tip', 'warning', 'important']) }).strict(),
  columnsBlock: z.object({ title: label, columns: z.array(z.object({ title: label, body: text }).strict()).min(2).max(4) }).strict(),
  questionnaireBlock: z.object({ title: label, description: text, questions: z.array(z.object({ id: identifier, question: label, options: z.array(z.object({ id: identifier, label: label }).strict()).min(2).max(8), allowText: z.boolean().default(true) }).strict()).min(1).max(20) }).strict().superRefine((data, context) => {
    if (new Set(data.questions.map(q => q.id)).size !== data.questions.length) context.addIssue({ code: 'custom', path: ['questions'], message: 'Question IDs must be unique' });
    for (const [index, question] of data.questions.entries()) if (new Set(question.options.map(o => o.id)).size !== question.options.length) context.addIssue({ code: 'custom', path: ['questions', index, 'options'], message: 'Option IDs must be unique' });
  }),
  artifactReferenceBlock: z.object({ title: label, artifactId: z.string().uuid(), description: text }).strict(),
  evidenceBlock: z.object({ title: label, runId: z.string().uuid().or(z.literal('')), scenarioId: z.string().max(300), description: text }).strict(),
};
export type DocumentBlockKind = keyof typeof documentBlockSchemas;
export type QuestionnaireData = z.infer<typeof documentBlockSchemas.questionnaireBlock>;
export const documentBlockDefaults = {
  calloutBlock: { title: 'Planning note', body: 'Capture the context your team needs to make this decision.', tone: 'note' },
  columnsBlock: { title: 'Compare approaches', columns: [{ title: 'Approach A', body: 'Describe its behavior, benefits, and tradeoffs.' }, { title: 'Approach B', body: 'Describe the alternative and how you will evaluate it.' }] },
  questionnaireBlock: { title: 'Choose an approach', description: 'Record each teammate’s answer before accepting a decision.', questions: [{ id: 'approach', question: 'Which approach should we take?', options: [{ id: 'a', label: 'Approach A' }, { id: 'b', label: 'Approach B' }], allowText: true }] },
  artifactReferenceBlock: { title: 'Related artifact', artifactId: '00000000-0000-4000-8000-000000000000', description: 'Select an artifact in this project.' },
  evidenceBlock: { title: 'Verification evidence', runId: '', scenarioId: '', description: 'Link a real executed scenario. Unlinked evidence never implies a pass.' },
} satisfies { [K in DocumentBlockKind]: z.infer<typeof documentBlockSchemas[K]> };
export function isDocumentBlockKind(value: string): value is DocumentBlockKind { return Object.hasOwn(documentBlockSchemas, value); }
export function documentBlockText(kind: DocumentBlockKind, value: unknown): string {
  const data = documentBlockSchemas[kind].parse(value);
  if (kind === 'calloutBlock') { const d = data as z.infer<typeof documentBlockSchemas.calloutBlock>; return `${d.title}\n${d.body}`; }
  if (kind === 'columnsBlock') { const d = data as z.infer<typeof documentBlockSchemas.columnsBlock>; return `${d.title}\n${d.columns.map(c => `${c.title}\n${c.body}`).join('\n\n')}`; }
  if (kind === 'questionnaireBlock') { const d = data as QuestionnaireData; return `${d.title}\n${d.description}\n${d.questions.map(q => `${q.question}\n${q.options.map(o => `- ${o.label}`).join('\n')}`).join('\n\n')}`; }
  const d = data as z.infer<typeof documentBlockSchemas.artifactReferenceBlock>; return `${d.title}\n${d.description}`;
}
