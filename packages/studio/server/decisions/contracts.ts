import type { LocalModelSettings } from '../local/catalog.ts';
import type { GatewayFetch } from '@ai-bdd/models-ai-sdk';
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
  /** Every actual vendor attempt consumes one admission; cached receipts do not. */
  budget?: {
    principalPerHour: number;
    projectPerHour: number;
    principalConcurrent: number;
    projectConcurrent: number;
  };
  defaultProfile: DecisionProfile;
  openai?: { baseUrl: string; apiKey: string; models: string[] };
  jev?: { baseUrl: string; apiKey: string; models: string[] };
  local?: LocalModelSettings;
  structured?: { baseUrl?: string; apiKey?: string; models: string[]; metadataFetch?: GatewayFetch };
  evaluation?: { apiKey?: string; models: string[]; metadataFetch?: GatewayFetch };
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
  localInference?: DecisionEvaluation['provenance']['localInference'];
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
