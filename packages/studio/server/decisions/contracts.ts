import type { User } from '../../shared/domain.ts';
import type {
  DecisionAnswer,
  DecisionEvaluation,
  DecisionProfile,
  DecisionQuestion,
  DecisionRequest,
} from '../../shared/decision-profile.ts';
export type DecisionSettings = {
  production: boolean;
  timeoutMs: number;
  leaseMs?: number;
  configRevision?: string;
  defaultProfile: DecisionProfile;
  openai?: { baseUrl: string; apiKey: string; models: string[] };
  jev?: { baseUrl: string; apiKey: string; models: string[] };
  structured?: { baseUrl?: string; apiKey?: string; models: string[] };
};
export type ProviderAnswer = {
  kind: DecisionQuestion['kind'];
  questionId: string;
  refused?: boolean;
  abstained?: boolean;
  value?: string | boolean | number;
  probability?: number;
  confidence?: number;
  probabilities?: DecisionAnswer['probabilities'];
};
export type ProviderDecision = {
  model: string;
  answers: ProviderAnswer[];
  providerRequestId: string | null;
  usage: DecisionEvaluation['provenance']['usage'];
};
export type DecisionInvocation = DecisionRequest & {
  user: User;
  artifactId: string;
  policyVersion?: string;
};
export type DecisionProvider = {
  id: DecisionProfile['provider'];
  version: string;
  mode: DecisionEvaluation['provenance']['mode'];
  evaluate(input: {
    profile: DecisionProfile;
    input: string;
    questions: DecisionQuestion[];
    idempotencyKey: string;
    signal: AbortSignal;
  }): Promise<ProviderDecision>;
};
