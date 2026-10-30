import type { LanguageModel } from 'ai';
import { createFreeGateway } from '@ai-bdd/models-ai-sdk';
import type { IdentityExecutionContext } from './identity-context.ts';

/** Enter the identity boundary at each actual SDK attempt, including AI SDK's v2/v3→v4 adapters. */
export function identityLanguageModel(
  model: LanguageModel,
  context?: IdentityExecutionContext,
): LanguageModel {
  const concrete = typeof model === 'string' ? createFreeGateway()(model) : model;
  if (!context) return concrete;
  return new Proxy(concrete, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === 'doGenerate' || property === 'doStream')
        return (...args: unknown[]) =>
          context.run(async () => Reflect.apply(value, target, args));
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
