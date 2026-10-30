import type {
  DecisionEvaluation,
  DecisionQuestion,
} from './decision-profile.ts';

export type ReviewPassage = { id: string; quote: string; hash: string };
export type ReviewQuestion = DecisionQuestion & {
  label: string;
  blockId?: string;
};
export type DesignReviewResult = {
  policyVersion: 'design-review-v1';
  artifactVersion: number;
  sourceHash: string;
  acceptedDecisionHash: string;
  passages: ReviewPassage[];
  coverage: {
    selected: number;
    available: number;
    acceptedDecisions: number;
    totalAcceptedDecisions: number;
  };
  questions: ReviewQuestion[];
  evaluation: DecisionEvaluation;
};
export type DesignReviewJob = {
  id: string;
  status: string;
  error: string | null;
  createdAt: string;
  stale: boolean;
  result: DesignReviewResult | null;
};
export type DesignReviewView = {
  passages: ReviewPassage[];
  totalPassages: number;
  available: boolean;
  unavailableReason: string | null;
  jobs: DesignReviewJob[];
};
