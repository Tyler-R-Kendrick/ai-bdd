import type { DecisionQuestion } from '../../shared/decision-profile.ts';
import type { ProviderAnswer } from '../decisions/contracts.ts';
export type LocalDecisionInput = {
  input: string;
  questions: DecisionQuestion[];
};
export type LocalDecisionResult = {
  answers: ProviderAnswer[];
  inputTokens: number;
  outputTokens: number;
  rss: number;
  probabilityKind: 'conditional-option-likelihood';
  calibrated: false;
};
