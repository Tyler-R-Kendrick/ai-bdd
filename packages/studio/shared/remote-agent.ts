import { z } from 'zod';
const id = z.string().min(1).max(128),
  note = z.string().max(4000),
  name = z.string().min(1).max(128);
export const remoteFeatures = [
  'stream-parts',
  'questions',
  'run-cards',
  'run-stage-deltas',
] as const;
export type RemoteFeature = (typeof remoteFeatures)[number];
export const remoteRepositoryTools = [
  'repository_tree',
  'repository_file',
  'repository_pull_request',
  'repository_search',
  'repository_history',
] as const;
const finishReason = z
  .object({
    unified: z.enum([
      'stop',
      'length',
      'content-filter',
      'tool-calls',
      'error',
      'other',
    ]),
    raw: z.string().max(128).optional(),
  })
  .strict();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const usage = z
  .object({
    inputTokens: z
      .object({
        total: count.optional(),
        noCache: count.optional(),
        cacheRead: count.optional(),
        cacheWrite: count.optional(),
      })
      .strict()
      .optional(),
    outputTokens: z
      .object({
        total: count.optional(),
        text: count.optional(),
        reasoning: count.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const remoteStreamPartSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('stream-start'), modelId: name.optional() })
    .strict(),
  ...(['text', 'reasoning'] as const).flatMap((kind) => [
    z.object({ type: z.literal(`${kind}-start`), id }).strict(),
    z
      .object({
        type: z.literal(`${kind}-delta`),
        id,
        delta: z.string().max(20000),
      })
      .strict(),
    z.object({ type: z.literal(`${kind}-end`), id }).strict(),
  ]),
  z
    .object({
      type: z.literal('tool-input-start'),
      id,
      toolName: name,
      providerExecuted: z.literal(true).optional(),
      dynamic: z.literal(true).optional(),
      title: note.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('tool-input-delta'),
      id,
      delta: z.string().max(20000),
    })
    .strict(),
  z.object({ type: z.literal('tool-input-end'), id }).strict(),
  z
    .object({
      type: z.literal('tool-call'),
      toolCallId: id,
      toolName: name,
      input: z.json(),
      providerExecuted: z.literal(true),
      dynamic: z.literal(true).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('tool-result'),
      toolCallId: id,
      toolName: name,
      result: z.json(),
      isError: z.literal(true).optional(),
      preliminary: z.literal(true).optional(),
      dynamic: z.literal(true).optional(),
    })
    .strict(),
  z.object({ type: z.literal('finish-step'), finishReason, usage }).strict(),
  z
    .object({ type: z.literal('finish'), finishReason, totalUsage: usage })
    .strict(),
  z.object({ type: z.literal('error'), error: note }).strict(),
]);
export type RemoteStreamPart = z.infer<typeof remoteStreamPartSchema>;
const option = z
  .object({
    label: z.string().min(1).max(4000),
    description: note,
    preview: z.string().max(16000).optional(),
  })
  .strict();
export const remoteQuestionInputSchema = z.discriminatedUnion('method', [
  z
    .object({
      method: z.literal('questionnaire'),
      params: z
        .object({
          questions: z
            .array(
              z
                .object({
                  question: z.string().min(1).max(4000),
                  header: z.string().max(128),
                  options: z
                    .array(option)
                    .min(1)
                    .max(32)
                    .refine(
                      (options) =>
                        new Set(options.map((item) => item.label)).size ===
                        options.length,
                      'Option labels must be unique',
                    ),
                  multiSelect: z.boolean().optional(),
                })
                .strict(),
            )
            .min(1)
            .max(16),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      method: z.literal('confirm'),
      title: z.string().min(1).max(4000),
      message: note,
    })
    .strict(),
  z
    .object({
      method: z.literal('select'),
      title: z.string().min(1).max(4000),
      choices: z
        .array(z.string().min(1).max(4000))
        .min(1)
        .max(32)
        .refine(
          (choices) => new Set(choices).size === choices.length,
          'Choices must be unique',
        ),
    })
    .strict(),
  z
    .object({
      method: z.literal('input'),
      title: z.string().min(1).max(4000),
      placeholder: note.optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal('editor'),
      title: z.string().min(1).max(4000),
      initial: z.string().max(50000).optional(),
    })
    .strict(),
]);
export type RemoteQuestionInput = z.infer<typeof remoteQuestionInputSchema>;
export const remoteQuestionAnswerSchema = z
  .object({
    questionIndex: z.number().int().min(0).max(15),
    kind: z.enum(['option', 'multi', 'custom', 'chat']),
    answer: z.string().max(20000).nullable(),
    selected: z.array(z.string().max(4000)).max(32).optional(),
  })
  .strict();
export type RemoteQuestionAnswer = z.infer<typeof remoteQuestionAnswerSchema>;
export const remoteAnswerActionSchema = z
  .object({
    idempotencyKey: z.string().uuid(),
    expectedRevision: z.number().int().positive(),
    action: z.enum(['answer', 'cancel']),
    value: z.json().optional(),
    customValue: z.string().min(1).max(20000).optional(),
    answers: z.array(remoteQuestionAnswerSchema).max(16).optional(),
  })
  .strict();
export const remoteStageSchema = z
  .object({
    id,
    name: note,
    status: z.enum([
      'pending',
      'running',
      'awaiting_input',
      'paused',
      'blocked',
      'completed',
      'failed',
      'skipped',
      'stopped',
    ]),
    parentIds: z.array(id).max(64).optional(),
    kind: name.optional(),
    started: count.optional(),
    ended: count.optional(),
  })
  .strict();
export type RemoteStage = z.infer<typeof remoteStageSchema>;
export const remoteRunSchema = z
  .object({
    id,
    name: note,
    status: z.enum([
      'running',
      'waiting',
      'paused',
      'finished',
      'blocked',
      'failed',
      'stopped',
    ]),
    started: count,
    updated: count,
    ended: count.optional(),
    waiting: count,
    stages: z.array(remoteStageSchema),
    earlierStages: count.optional(),
    stagesDelta: z.literal(true).optional(),
  })
  .strict()
  .superRefine((run, ctx) => {
    if (run.stagesDelta && run.earlierStages !== undefined)
      ctx.addIssue({
        code: 'custom',
        message: 'Delta cards cannot replace earlier stage counts',
      });
    if (!run.stagesDelta && run.stages.length > 64)
      ctx.addIssue({
        code: 'custom',
        message:
          'Full cards include at most 64 stages; use negotiated stage deltas',
      });
  });
export type RemoteRun = z.infer<typeof remoteRunSchema>;
export const remoteRunsSchema = z
  .object({
    cards: z.array(remoteRunSchema).max(64),
    active: z.array(id).max(64),
    paused: z.array(id).max(64),
  })
  .strict();
export type RemoteRuns = z.infer<typeof remoteRunsSchema>;
export const remoteOutputSchema = z
  .object({
    text: z.string().max(50000),
    content: z.record(z.string(), z.json()).nullable(),
  })
  .strict();
const request = { requestId: id },
  event = { ...request, eventId: z.string().uuid() };
export const remoteIncomingSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('attach'),
      version: z.literal(1),
      artifactId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      type: z.literal('result'),
      ...request,
      output: remoteOutputSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('tool'),
      ...request,
      callId: id,
      name: z.enum(remoteRepositoryTools),
      input: z.record(z.string(), z.json()),
    })
    .strict(),
  z.object({ type: z.literal('ping') }).strict(),
  z
    .object({ type: z.literal('failed'), ...request, message: note.optional() })
    .strict(),
  z
    .object({
      type: z.literal('tools'),
      ...event,
      names: z
        .array(name)
        .max(256)
        .refine((values) => new Set(values).size === values.length),
    })
    .strict(),
  z
    .object({ type: z.literal('part'), ...event, part: remoteStreamPartSchema })
    .strict(),
  z
    .object({
      type: z.literal('input-request'),
      ...event,
      questionId: id,
      input: remoteQuestionInputSchema,
      runId: id.optional(),
      stageId: id.optional(),
      rootRunId: id.optional(),
      block: z
        .object({
          index: z.number().int().nonnegative().max(10000),
          digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({ type: z.literal('input-cancel'), ...event, questionId: id })
    .strict(),
  z
    .object({ type: z.literal('runs'), ...event, ...remoteRunsSchema.shape })
    .strict(),
  z
    .object({
      type: z.literal('control-result'),
      ...request,
      controlId: z.string().uuid(),
      ok: z.boolean(),
      message: note.optional(),
    })
    .strict(),
]);
export type RemoteIncoming = z.infer<typeof remoteIncomingSchema>;
export type RemoteStreamState = {
  started: boolean;
  modelId?: string;
  names: string[];
  blocks: {
    id: string;
    kind: 'text' | 'reasoning' | 'tool-input';
    text: string;
    name?: string;
    ended: boolean;
  }[];
  calls: {
    id: string;
    name: string;
    input: unknown;
    result?: unknown;
    status: 'running' | 'completed' | 'failed';
    preliminary?: boolean;
    source: 'remote' | 'server';
  }[];
  finishReason?: z.infer<typeof finishReason>;
  usage?: z.infer<typeof usage>;
  error?: string;
};
export type RemoteRunState = {
  cards: RemoteRun[];
  reported: string[];
  active: string[];
  paused: string[];
};
export type RemoteQuestion = {
  id: string;
  input: RemoteQuestionInput;
  status: 'open' | 'answered' | 'cancelled' | 'stale';
  revision: number;
  answers: RemoteQuestionAnswer[];
  value: unknown;
  customAnswer?: string;
  cancelledByHuman?: boolean;
  answeredBy?: string;
  runId?: string;
  stageId?: string;
  rootRunId?: string;
  anchor?: { index: number; nodeId?: string; digest: string };
  createdAt: string;
};
export type RemoteControl = {
  id: string;
  action: 'pause' | 'resume';
  runId?: string;
  status: 'pending' | 'accepted' | 'failed';
  message?: string;
  createdAt: string;
};
/** One wire value for fresh delivery and reconnect replay. Written select answers remain member-visible while its runtime result is null. */
export function remoteQuestionValue(question: RemoteQuestion): unknown {
  const input = question.input;
  if (input.method !== 'questionnaire')
    return question.status === 'answered'
      ? question.value
      : input.method === 'confirm'
        ? false
        : null;
  const answers =
    question.status === 'answered' || question.cancelledByHuman
      ? question.answers
      : [];
  return {
    answers: answers.map((answer) => {
      const prompt = input.params.questions[answer.questionIndex];
      const option =
        answer.kind === 'option'
          ? prompt.options.find((option) => option.label === answer.answer)
          : undefined;
      return {
        ...answer,
        question: prompt.question,
        ...(option?.preview !== undefined ? { preview: option.preview } : {}),
      };
    }),
    cancelled: question.status !== 'answered',
  };
}
export type RemoteActivity = {
  id: string;
  historyOrdinal?: number;
  jobId: string;
  threadId: string;
  artifactVersion: number;
  sourceSha256: string | null;
  status: string;
  jobStatus: string;
  cursor: number;
  stream: RemoteStreamState;
  runs: RemoteRunState;
  questions: RemoteQuestion[];
  controls: RemoteControl[];
  canAnswer: boolean;
  canControl: boolean;
  createdAt: string;
};
export type RemoteActivityPage = {
  requests: RemoteActivity[];
  nextCursor: number | null;
};
export function emptyRemoteStream(): RemoteStreamState {
  return { started: false, names: [], blocks: [], calls: [] };
}
export function emptyRemoteRuns(): RemoteRunState {
  return { cards: [], reported: [], active: [], paused: [] };
}
/** Run reports are external observations. They never approve a graph or establish server-run test evidence. */
export function mergeRemoteRuns(
  previous: RemoteRunState,
  report: RemoteRuns,
  deltas: boolean,
): RemoteRunState {
  const existing = new Map(previous.cards.map((card) => [card.id, card]));
  for (const card of report.cards) {
    const old = existing.get(card.id);
    if (card.stagesDelta && !deltas)
      throw new Error('Stage deltas were not negotiated');
    let stages = card.stages;
    if (card.stagesDelta) {
      const all = new Map(old?.stages.map((stage) => [stage.id, stage]));
      for (const stage of stages) all.set(stage.id, stage);
      stages = [...all.values()];
    } else if (!stages.length && old?.stages.length) stages = old.stages;
    existing.set(card.id, {
      ...card,
      stages,
      earlierStages:
        card.stagesDelta || (!card.stages.length && old?.stages.length)
          ? old?.earlierStages
          : card.earlierStages,
      stagesDelta: undefined,
    });
  }
  const current = new Set(report.cards.map((card) => card.id));
  const cards = [...existing.values()];
  for (let i = 0; cards.length > 64 && i < cards.length; i++)
    if (
      !current.has(cards[i].id) &&
      ['finished', 'failed', 'stopped'].includes(cards[i].status)
    ) {
      cards.splice(i--, 1);
    }
  if (cards.length > 64)
    throw new Error('The persisted run card budget is exhausted');
  return {
    cards,
    reported: [...current],
    active: [...new Set(report.active)],
    paused: [...new Set(report.paused)],
  };
}
export function displayRemoteStages(card: RemoteRun): RemoteStage[] {
  const terminal = new Set(['completed', 'failed', 'skipped', 'stopped']);
  const stops = new Set(['failed', 'blocked', 'skipped', 'stopped']);
  const children = new Map<string, string[]>(),
    descendants = new Set<string>(),
    queue = card.stages
      .filter((stage) => stops.has(stage.status))
      .map((stage) => stage.id),
    queued = new Set(queue);
  for (const stage of card.stages)
    for (const parent of stage.parentIds ?? []) {
      const group = children.get(parent) ?? [];
      group.push(stage.id);
      children.set(parent, group);
    }
  // Each stage and parent edge is visited once, including deep or cyclic external reports.
  for (let cursor = 0; cursor < queue.length; cursor++)
    for (const child of children.get(queue[cursor]) ?? []) {
      descendants.add(child);
      if (!queued.has(child)) {
        queued.add(child);
        queue.push(child);
      }
    }
  return card.stages.map((stage) =>
    terminal.has(stage.status)
      ? stage
      : ['failed', 'blocked', 'stopped'].includes(card.status) ||
          descendants.has(stage.id)
        ? { ...stage, status: 'stopped' }
        : stage,
  );
}
