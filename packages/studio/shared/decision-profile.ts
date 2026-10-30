import { z } from 'zod';
const identifier = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/);
const instructions = z.string().trim().min(1).max(6000);
export const decisionProviderIds = [
  'openai-decisions',
  'jev',
  'vercel-structured',
] as const;
export const decisionProfileSchema = z
  .object({
    provider: z.enum(decisionProviderIds),
    model: identifier,
    minimumConfidence: z.number().finite().min(0.5).max(1).default(0.7),
  })
  .strict();
export type DecisionProfile = z.infer<typeof decisionProfileSchema>;
export const decisionPurposes = [
  'conversation-offer',
  'research-offer',
  'visual-possibility',
  'visual-comprehension',
  'visual-type',
  'spike-worthiness',
  'semantic-design-gap',
  'harness-suggestion',
  'implementation-readiness',
] as const;
export type DecisionPurpose = (typeof decisionPurposes)[number];
const choice = z
  .object({
    value: z.union([z.string().min(1).max(200), z.boolean()]),
    description: z.string().max(2000).optional(),
  })
  .strict();
const level = z
  .object({
    label: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
  })
  .strict();
export const decisionQuestionSchema = z
  .discriminatedUnion('kind', [
    z
      .object({ id: identifier, kind: z.literal('boolean'), instructions })
      .strict(),
    z
      .object({
        id: identifier,
        kind: z.literal('choice'),
        instructions,
        choices: z.array(choice).min(2).max(255),
      })
      .strict(),
    z
      .object({
        id: identifier,
        kind: z.literal('score'),
        instructions,
        levels: z.array(level).min(2).max(10),
      })
      .strict(),
  ])
  .superRefine((question, ctx) => {
    if (
      question.kind === 'choice' &&
      new Set(question.choices.map((value) => JSON.stringify(value.value)))
        .size !== question.choices.length
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Decision choices must be typed unique values',
      });
    if (
      question.kind === 'score' &&
      new Set(question.levels.map((value) => value.label)).size !==
        question.levels.length
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Decision rubric labels must be unique',
      });
  });
export type DecisionQuestion = z.infer<typeof decisionQuestionSchema>;
export const decisionQuestionsSchema = z
  .array(decisionQuestionSchema)
  .min(1)
  .max(64)
  .superRefine((questions, ctx) => {
    if (new Set(questions.map((q) => q.id)).size !== questions.length)
      ctx.addIssue({
        code: 'custom',
        message: 'Decision question IDs must be unique',
      });
  });
export type DecisionAnswer = {
  questionId: string;
  kind: DecisionQuestion['kind'];
  status: 'answered' | 'abstained' | 'refused' | 'error';
  value: string | boolean | number | null;
  candidate: string | boolean | number | null;
  /** Native predicate/noul probability that the statement is true, never a made-up confidence. */
  probability: number | null;
  /** Native reported confidence for choice/score; unavailable values remain null. */
  confidence: number | null;
  probabilities: {
    value: string | boolean | number;
    label?: string;
    probability: number;
  }[];
  error?:
    | 'low-confidence'
    | 'provider-refusal'
    | 'provider-error'
    | 'invalid-response'
    | 'cancelled'
    | 'access-revoked';
};
export type DecisionEvaluation = {
  id: string;
  status:
    | 'answered'
    | 'partial'
    | 'abstained'
    | 'refused'
    | 'error'
    | 'cancelled';
  answers: DecisionAnswer[];
  provenance: {
    provider: DecisionProfile['provider'];
    model: string;
    requestedModel: string;
    adapterVersion: string;
    promptVersion: string;
    inputHash: string;
    requestHash: string;
    artifactVersion: number;
    minimumConfidence: number;
    startedAt: string;
    finishedAt: string;
    latencyMs: number;
    providerRequestId: string | null;
    usage: {
      inputTokens: number | null;
      outputTokens: number | null;
      totalTokens: number | null;
    };
    cachedFrom: string | null;
    mode: 'native-decision' | 'structured-generation';
  };
};
export type DecisionProfileView = {
  profile: DecisionProfile;
  independentOfChat: true;
  requiresExplicitFallback: true;
  providers: {
    id: DecisionProfile['provider'];
    label: string;
    configured: boolean;
    reason: string | null;
    models: string[];
    mode: 'native-decision' | 'structured-generation';
  }[];
};
export type DecisionRequest = {
  profile: DecisionProfile;
  artifactVersion: number;
  purpose: DecisionPurpose;
  input: string;
  questions: DecisionQuestion[];
  idempotencyKey: string;
  signal?: AbortSignal;
};
