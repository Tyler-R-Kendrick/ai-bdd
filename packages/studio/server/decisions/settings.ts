import { DEFAULT_LOCAL_MODEL_ID } from '../local/catalog.ts';
import { z } from 'zod';
import {
  decisionProfileSchema,
  type DecisionProfile,
} from '../../shared/decision-profile.ts';
import { trustedEndpoint } from '../integrations/settings.ts';
import type { DecisionSettings } from './contracts.ts';
const modelList = z.array(z.string().min(1).max(120)).max(100);
export function decisionSettingsFromEnv(
  env: NodeJS.ProcessEnv,
  production = env.NODE_ENV === 'production',
): DecisionSettings {
  const openaiKey = env.STUDIO_OPENAI_DECISIONS_KEY ?? env.OPENAI_API_KEY,
    jevKey = env.JEV_API_KEY ?? env.TYPESAFE_API_KEY;
  const structuredModels = modelList.parse(
    JSON.parse(env.STUDIO_DECISION_SDK_MODELS_JSON ?? '[]'),
  );
  const provider = env.STUDIO_DECISION_PROVIDER ?? 'llama-cpp-cpu';
  const defaultModel =
    provider === 'llama-cpp-cpu'
      ? DEFAULT_LOCAL_MODEL_ID
      : provider === 'jev'
        ? 'jev-latest'
        : provider === 'vercel-structured'
          ? (structuredModels[0] ?? 'unconfigured')
          : 'gpt-6-luna';
  const defaultProfile: DecisionProfile = decisionProfileSchema.parse({
    provider,
    model: env.STUDIO_DECISION_MODEL ?? defaultModel,
    minimumConfidence: Number(env.STUDIO_DECISION_MIN_CONFIDENCE ?? 0.7),
  });
  const timeoutMs = Number(env.STUDIO_DECISION_TIMEOUT_MS ?? 30000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000)
    throw new Error(
      'Decision provider timeout must be between 100 and 60000 milliseconds',
    );
  const bounded = (key: string, fallback: number, max: number) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isInteger(value) || value < 1 || value > max)
      throw new Error(key + ' must be a positive bounded integer');
    return value;
  };
  return {
    budget: {
      principalPerHour: bounded(
        'STUDIO_DECISION_PRINCIPAL_HOURLY',
        120,
        10000,
      ),
      projectPerHour: bounded('STUDIO_DECISION_PROJECT_HOURLY', 600, 50000),
      principalConcurrent: bounded(
        'STUDIO_DECISION_PRINCIPAL_CONCURRENT',
        4,
        100,
      ),
      projectConcurrent: bounded(
        'STUDIO_DECISION_PROJECT_CONCURRENT',
        8,
        200,
      ),
    },
    ...(env.STUDIO_LOCAL_MODEL_DIR
      ? { local: { directory: env.STUDIO_LOCAL_MODEL_DIR } }
      : {}),
    configRevision: env.STUDIO_DECISION_CONFIG_REVISION ?? 'v1',
    production,
    timeoutMs,
    defaultProfile,
    ...(openaiKey
      ? {
          openai: {
            apiKey: openaiKey,
            baseUrl: trustedEndpoint(
              env.STUDIO_OPENAI_DECISIONS_BASE_URL ??
                'https://api.openai.com/v1',
              production,
            ),
            models: ['gpt-6-luna'],
          },
        }
      : {}),
    ...(jevKey
      ? {
          jev: {
            apiKey: jevKey,
            baseUrl: trustedEndpoint(
              env.STUDIO_JEV_BASE_URL ?? 'https://api.typesafe.ai',
              production,
            ),
            models: modelList.parse(
              JSON.parse(env.STUDIO_JEV_MODELS_JSON ?? '["jev-latest"]'),
            ),
          },
        }
      : {}),
    ...(structuredModels.length
      ? {
          structured: {
            models: structuredModels,
            ...(env.STUDIO_DECISION_SDK_BASE_URL
              ? {
                  baseUrl: trustedEndpoint(
                    env.STUDIO_DECISION_SDK_BASE_URL,
                    production,
                  ),
                }
              : {}),
            ...(env.AI_GATEWAY_API_KEY
              ? { apiKey: env.AI_GATEWAY_API_KEY }
              : {}),
          },
        }
      : {}),
  };
}
