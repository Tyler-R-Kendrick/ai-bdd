import { createGateway, type LanguageModel } from 'ai';
import type { IdentityExecutionContext } from './identity-context.ts';

/** Enter the identity boundary at each actual SDK attempt, including AI SDK's v2/v3→v4 adapters. */
export function identityLanguageModel(
  model: LanguageModel,
  context?: IdentityExecutionContext,
): LanguageModel {
  if (!context) return model;
  const concrete = typeof model === 'string' ? createGateway()(model) : model;
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
