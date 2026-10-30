import { z } from 'zod';
const prose = z.string().trim().min(1).max(6000);
export const findingsProposalSchema = z
  .object({
    summary: prose,
    edits: z
      .array(
        z
          .object({
            blockId: z.string().min(1).max(200),
            original: z.string().min(1).max(6000),
            replacement: prose,
            evidence: prose,
          })
          .strict(),
      )
      .max(8),
    questions: z
      .array(
        z
          .object({
            question: z.string().trim().min(1).max(180),
            options: z.array(z.string().trim().min(1).max(180)).min(2).max(6),
            context: prose,
          })
          .strict(),
      )
      .max(4),
  })
  .strict();
export type FindingsProposal = z.infer<typeof findingsProposalSchema>;
export type FindingsReview = {
  id: string;
  investigationId: string;
  artifactVersion: number;
  automatic: boolean;
  status: string;
  error: string | null;
  proposal: FindingsProposal | null;
  eligibility: {
    status: string;
    value: boolean | null;
    evaluationId: string;
  } | null;
  stale: boolean;
  acceptedBy: string | null;
  acceptedAt: string | null;
  createdAt: string;
};
export type FindingsReviewView = {
  reviews: FindingsReview[];
  acknowledgements: {
    id: string;
    authorId: string;
    author: string;
    rationale: string;
    resultHash: string;
    sourceVersion: number;
    createdAt: string;
  }[];
  pending: { dueAt: number; error: string | null } | null;
  owner: { userId: string; name: string } | null;
};
