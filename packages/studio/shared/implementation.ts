import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max);
const taskId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
export const implementationPointerSchema = z
  .object({
    planRevision: z.number().int().positive(),
    graphVersion: z.number().int().positive(),
    draftRevision: z.number().int().positive(),
  })
  .strict();
export const implementationDefinitionSchema = z
  .object({
    tasks: z
      .array(
        z
          .object({
            id: taskId,
            title: text(240),
            description: text(5000),
            acceptanceCriteria: z.array(text(2000)).min(1).max(30),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    edges: z.array(z.object({ from: taskId, to: taskId }).strict()).max(1000),
  })
  .strict()
  .superRefine((definition, ctx) => {
    const ids = new Set(definition.tasks.map((task) => task.id));
    if (ids.size !== definition.tasks.length)
      ctx.addIssue({ code: 'custom', message: 'Task IDs must be unique' });
    const edges = new Set<string>();
    const outgoing = new Map<string, string[]>();
    for (const edge of definition.edges) {
      const key = edge.from + ':' + edge.to;
      if (
        !ids.has(edge.from) ||
        !ids.has(edge.to) ||
        edge.from === edge.to ||
        edges.has(key)
      )
        ctx.addIssue({
          code: 'custom',
          message:
            'Dependencies must be unique edges between distinct existing tasks',
        });
      edges.add(key);
      outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
    }
    const visiting = new Set<string>(),
      visited = new Set<string>();
    const cycle = (id: string): boolean => {
      if (visiting.has(id)) return true;
      if (visited.has(id)) return false;
      visiting.add(id);
      if ((outgoing.get(id) ?? []).some(cycle)) return true;
      visiting.delete(id);
      visited.add(id);
      return false;
    };
    if ([...ids].some(cycle))
      ctx.addIssue({
        code: 'custom',
        message: 'Dependencies must form an acyclic graph',
      });
  });
export type ImplementationDefinition = z.infer<
  typeof implementationDefinitionSchema
>;
export type ImplementationPointer = z.infer<typeof implementationPointerSchema>;
export const implementationEditSchema = z
  .object({
    expected: implementationPointerSchema.nullable(),
    planRevision: z.number().int().positive(),
    definition: implementationDefinitionSchema,
  })
  .strict();
export const implementationClaimSchema = z
  .object({
    expected: implementationPointerSchema,
    repository: z.string().url().max(300),
    branch: text(200).refine(
      (value) =>
        !/[\s~^:?*[\\]/.test(value) &&
        !Array.from(value).some(
          (character) =>
            character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ) &&
        !value.includes('..') &&
        !value.includes('@{') &&
        !value.startsWith('/') &&
        !value.endsWith('/') &&
        !value.endsWith('.') &&
        value !== '@' &&
        value
          .split('/')
          .every(
            (part) =>
              !!part && !part.startsWith('.') && !part.endsWith('.lock'),
          ),
      'A valid checkout branch is required',
    ),
    commit: z
      .string()
      .regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/)
      .transform((value) => value.toLowerCase()),
  })
  .strict();
export const implementationPullRequestSchema = z
  .object({
    url: z.string().url().max(500),
    state: z.enum(['open', 'merged', 'closed']),
    title: text(240).optional(),
  })
  .strict();
export const implementationNoChangeSchema = z
  .object({ reason: text(1000), evidence: text(5000) })
  .strict();
const criterionResult = z
  .object({
    index: z.number().int().min(0).max(29),
    passed: z.boolean(),
    evidence: text(5000),
  })
  .strict();
export const implementationVerificationSchema = z
  .object({
    summary: text(5000),
    tasks: z
      .array(
        z
          .object({ taskId, criteria: z.array(criterionResult).min(1).max(30) })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
const command = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('start_task'), taskId }).strict(),
  z
    .object({ kind: z.literal('block_task'), taskId, reason: text(5000) })
    .strict(),
  z
    .object({
      kind: z.literal('report_pr'),
      taskId,
      pullRequest: implementationPullRequestSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('complete_task'),
      taskId,
      summary: text(5000),
      noChange: implementationNoChangeSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('report_verification'),
      verification: implementationVerificationSchema,
    })
    .strict(),
  z
    .object({ kind: z.literal('request_revision'), reason: text(5000) })
    .strict(),
]);
export const implementationReportSchema = z
  .object({
    runId: z.string().uuid(),
    idempotencyKey: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/),
    command,
  })
  .strict();
export type ImplementationReport = z.infer<typeof implementationReportSchema>;
export type ImplementationActor = {
  user: { id: string; email: string; name: string; color: string };
  kind: 'human' | 'agent';
  agentId?: string;
};
export type ImplementationAttribution = {
  userId: string;
  name: string;
  kind: 'human' | 'agent';
  agentId?: string;
  key: string;
};
export type ImplementationGraph = ImplementationPointer & {
  artifactId: string;
  status: 'draft' | 'approved' | 'locked' | 'superseded';
  definition: ImplementationDefinition;
  authoredBy: ImplementationAttribution;
  approvedBy?: ImplementationAttribution;
  approvedAt?: string;
  createdAt: string;
  updatedAt: string;
};
export type ImplementationTaskProgress = {
  taskId: string;
  status: 'queued' | 'in_progress' | 'blocked' | 'complete';
  blocker?: string;
  startedAt?: string;
  completedAt?: string;
  summary?: string;
  noChange?: z.infer<typeof implementationNoChangeSchema>;
  pullRequest?: z.infer<typeof implementationPullRequestSchema>;
  contributors: ImplementationAttribution[];
};
export type ImplementationRun = {
  id: string;
  artifactId: string;
  graphVersion: number;
  planRevision: number;
  draftRevision: number;
  status: 'running' | 'implemented' | 'delivered' | 'revision_requested';
  checkout: { repository: string; branch: string; commit: string };
  claimedBy: ImplementationAttribution;
  startedAt: string;
  finishedAt?: string;
  revisionReason?: string;
  tasks: ImplementationTaskProgress[];
  verification?: z.infer<typeof implementationVerificationSchema> & {
    passed: boolean;
    reviewedBy: ImplementationAttribution;
    reviewedAt: string;
    returnedTaskIds: string[];
  };
};
export type ImplementationEditingLock = {
  runId: string;
  graphVersion: number;
  claimedBy: ImplementationAttribution;
  startedAt: string;
};
export type ImplementationSnapshot = {
  artifactId: string;
  planRevision: number;
  repository: string;
  revision: number;
  graph: ImplementationGraph | null;
  activeRun: ImplementationRun | null;
  runs: ImplementationRun[];
  versions: ImplementationGraph[];
  editingLock: ImplementationEditingLock | null;
};
export type ImplementationEvent = {
  revision: number;
  kind:
    | 'draft_edited'
    | 'approved'
    | 'claimed'
    | 'interrupted'
    | ImplementationReport['command']['kind'];
  actor: ImplementationAttribution;
  at: string;
  runId?: string;
  detail: Record<string, unknown>;
};
export function implementationPointer(
  graph: ImplementationPointer,
): ImplementationPointer {
  return {
    planRevision: graph.planRevision,
    graphVersion: graph.graphVersion,
    draftRevision: graph.draftRevision,
  };
}
export function dependencyReady(
  definition: ImplementationDefinition,
  tasks: ImplementationTaskProgress[],
  taskId: string,
): boolean {
  return definition.edges
    .filter((edge) => edge.to === taskId)
    .every(
      (edge) =>
        tasks.find((task) => task.taskId === edge.from)?.status === 'complete',
    );
}
