import type {
  DecisionEvaluation,
  DecisionAnswer,
  DecisionProfile,
} from './decision-profile.ts';
import { z } from 'zod';
const title = z.string().trim().min(1).max(180);
export const conversationOfferSchema = z
  .object({
    kind: z.enum(['decision', 'research']),
    title,
    rationale: z.string().trim().min(1).max(1200),
    question: title,
    options: z.array(title).min(2).max(6),
    brief: z.string().trim().min(1).max(4000),
    evidenceMessageIds: z.array(z.string().uuid()).min(1).max(5),
    sourceQuote: z.string().trim().min(1).max(500),
  })
  .strict();
/** A single fixed object schema also works with providers without discriminated-union output support. */
export const conversationExtractionSchema = z
  .object({ offers: z.array(conversationOfferSchema).max(4) })
  .strict();
export type ConversationOffer = z.infer<typeof conversationOfferSchema>;
export type ConversationSnapshot = {
  artifactId: string;
  artifactVersion: number;
  artifactTitle: string;
  contentHash: string;
  threadId: string;
  messages: {
    id: string;
    author: string;
    role: string;
    body: string;
    bodyHash: string;
    truncated: boolean;
  }[];
  decisions: { id: string; version: number; title: string; status: string }[];
};
export type ConversationCard = ConversationOffer & {
  id: string;
  artifactId: string;
  threadId: string;
  snapshotId: string;
  sourceHash: string;
  artifactVersion: number;
  version: number;
  status: 'proposed' | 'dismissed' | 'published' | 'starting' | 'started';
  createdBy: string;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string;
  publishedId: string | null;
  jobId: string | null;
  stale: boolean;
  error: string | null;
};
export type ConversationEligibility = {
  evaluationId: string;
  status: DecisionEvaluation['status'];
  answerStatus: DecisionAnswer['status'];
  value: boolean | null;
  candidate: boolean | null;
  probability: number | null;
  confidence: number | null;
  error: DecisionAnswer['error'] | null;
  provider: DecisionProfile['provider'];
  model: string;
};
export type ConversationView = {
  enabled: boolean;
  modelConfigured: boolean;
  cards: ConversationCard[];
  jobs: {
    id: string;
    status: string;
    error: string | null;
    createdAt: string;
    eligibility?: ConversationEligibility;
  }[];
};
