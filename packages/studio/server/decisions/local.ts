import type { LocalInferenceObserver } from '../local/local-diagnostics.ts';
import type { DecisionProvider, DecisionSettings } from './contracts.ts';
import { DecisionProviderError } from './providers.ts';
import { evaluateLocalDecisions, LocalModelError } from '../local/model.ts';
import {
  localModelFingerprint,
  localModelPresent,
} from '../local/catalog.ts';

/** Native option likelihoods, not generated/self-reported ratings or calibrated correctness. */
export function localDecisionProvider(
  config: NonNullable<DecisionSettings['local']>,
  onEvent?: LocalInferenceObserver,
): DecisionProvider {
  return {
    id: 'llama-cpp-cpu',
    version: 'node-llama-cpp@3.22.2/chat-option-likelihood-v2',
    mode: 'native-decision',
    async evaluate(input) {
      if (!localModelPresent(config, input.profile.model))
        throw new DecisionProviderError('provider-error', false);
      try {
        const result = await evaluateLocalDecisions(
          { directory: config.directory, modelId: input.profile.model, onEvent },
          { input: input.input, questions: input.questions },
          input.signal,
        );
        const answers = result.answers.map((answer) => {
          const top = answer.probabilities?.length
            ? Math.max(
                ...answer.probabilities.map((item) => item.probability),
              )
            : undefined;
          const native =
            answer.probability === undefined
              ? answer.confidence
              : Math.max(answer.probability, 1 - answer.probability);
          // Confidence is conditional label mass, not calibrated correctness. Require a concentrated eligible-option distribution.
          return {
            ...answer,
            abstained:
              native === undefined ||
              native < input.profile.minimumConfidence ||
              top === undefined ||
              top < input.profile.minimumConfidence,
          };
        });
        return {
          model: input.profile.model,
          answers,
          providerRequestId: null,
          usage: {
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            totalTokens: result.inputTokens + result.outputTokens,
          },
          localInference: {
            probabilityKind: result.probabilityKind,
            calibrated: false,
            runtimeFingerprint: localModelFingerprint(input.profile.model),
            sampledPeakRssBytes: result.rss,
            contextTokens: 4096,
            inputPreserved: true,
          },
        };
      } catch (error) {
        if (input.signal.aborted) throw input.signal.reason;
        if (error instanceof LocalModelError && error.code === 'context')
          throw new DecisionProviderError('context-overflow', false);
        throw new DecisionProviderError('provider-error', false);
      }
    },
  };
}
