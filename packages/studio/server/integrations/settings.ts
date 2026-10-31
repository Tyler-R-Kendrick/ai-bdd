import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { localModelById, type LocalModelSettings } from '../local/catalog.ts';
import { managedT3SettingsFromEnv, type ManagedT3Settings } from '../local/managed-t3-settings.ts';
import type { GatewayFetch } from '@ai-bdd/models-ai-sdk';

export type IntegrationSettings = {
  localModel?: LocalModelSettings;
  managedT3?: ManagedT3Settings;
  gatewayBaseUrl?: string;
  /** Trusted server-only metadata transport for owned protocol fixtures. Never loaded from an environment or artifact. */
  gatewayMetadataFetch?: GatewayFetch;
  searchUrl?: string;
  searchToken?: string;
  remotePlanner?: boolean;
  plannerVisuals?: boolean;
  fxModels?: string[];
  t3?: {
    /** Legacy registration metadata; generation never starts a CLI subprocess. */
    command?: string;
    args: string[];
    project: string;
    providers: { id: string; label: string; models: string[] }[];
    mcp?: { url: string; accessToken?: string };
  };
  openDesign?: { command: string; args: string[]; envNames: string[] };
};
const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
export function trustedEndpoint(value: string, production: boolean) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        localHosts.has(url.hostname) &&
        !production
      ))
  )
    throw new Error(
      'Integration endpoints require HTTPS, without URL credentials; HTTP is permitted only for local development fixtures',
    );
  return url.toString().replace(/\/$/, '');
}
/** These settings belong to the operator. Artifact text can never supply a command or API host. */
export function integrationSettingsFromEnv(
  env: NodeJS.ProcessEnv,
): IntegrationSettings {
  const production = env.NODE_ENV === 'production';
  if (production && (env.STUDIO_T3_MCP_URL || env.STUDIO_REMOTE_PLANNER === 'on' || env.STUDIO_OPEN_DESIGN_REGISTRATION))
    throw new Error('The free-model policy cannot verify externally selected agent or design models. Use managed local T3 or verified free Gateway models.');
  let openDesign: IntegrationSettings['openDesign'];
  if (env.STUDIO_OPEN_DESIGN_REGISTRATION) {
    if (!isAbsolute(env.STUDIO_OPEN_DESIGN_REGISTRATION))
      throw new Error('Open Design registration path must be absolute');
    const raw = JSON.parse(
      readFileSync(env.STUDIO_OPEN_DESIGN_REGISTRATION, 'utf8'),
    );
    const parsed = z
      .object({
        command: z
          .string()
          .refine(isAbsolute, 'Use the resolved signed packaged executable'),
        args: z.array(z.string().max(2000)).max(30).default([]),
        envNames: z
          .array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/))
          .max(30)
          .default([]),
      })
      .strict()
      .parse(raw);
    openDesign = parsed;
  }
  let t3: IntegrationSettings['t3'];
  if (
    env.STUDIO_T3_COMMAND ||
    env.STUDIO_T3_PROJECT ||
    env.STUDIO_T3_MCP_URL ||
    env.STUDIO_T3_MCP_ACCESS_TOKEN ||
    env.STUDIO_T3_PROVIDERS_JSON ||
    env.STUDIO_T3_ARGS
  ) {
    if (
      (env.STUDIO_T3_COMMAND && !isAbsolute(env.STUDIO_T3_COMMAND)) ||
      (!env.STUDIO_T3_COMMAND && !env.STUDIO_T3_MCP_URL) ||
      !env.STUDIO_T3_PROJECT ||
      !isAbsolute(env.STUDIO_T3_PROJECT)
    )
      throw new Error(
        'T3 requires an operator-selected absolute STUDIO_T3_PROJECT and native MCP endpoint; legacy CLI-only registration requires an absolute command but cannot generate',
      );
    const providers = z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            label: z.string().min(1).max(200),
            models: z.array(z.string().min(1).max(200)).min(1).max(100),
          })
          .strict(),
      )
      .max(30)
      .parse(JSON.parse(env.STUDIO_T3_PROVIDERS_JSON ?? '[]'));
    t3 = {
      ...(env.STUDIO_T3_COMMAND ? { command: env.STUDIO_T3_COMMAND } : {}),
      project: env.STUDIO_T3_PROJECT,
      args: z
        .array(z.string().max(2000))
        .max(30)
        .parse(JSON.parse(env.STUDIO_T3_ARGS ?? '[]')),
      providers,
      ...(env.STUDIO_T3_MCP_URL
        ? {
            mcp: {
              url: trustedEndpoint(env.STUDIO_T3_MCP_URL, production),
              accessToken: env.STUDIO_T3_MCP_ACCESS_TOKEN,
            },
          }
        : {}),
    };
  }
  const localDirectory = env.STUDIO_LOCAL_MODEL_DIR;
  if (localDirectory && !isAbsolute(localDirectory)) throw new Error('STUDIO_LOCAL_MODEL_DIR must be an absolute operator-selected directory');
  const modelId = env.STUDIO_LOCAL_MODEL_ID;
  if (modelId && !localModelById(modelId))
    throw new Error('STUDIO_LOCAL_MODEL_ID must select an operator-registered local model');
  const managedT3 = managedT3SettingsFromEnv(env, !!localDirectory);
  if (managedT3 && t3?.providers.some(provider => provider.id === 'studioLocal'))
    throw new Error('studioLocal is reserved for the managed native T3 provider');
  return {
    ...(localDirectory ? { localModel: { directory: localDirectory, ...(modelId ? { modelId } : {}) } } : {}),
    ...(managedT3 ? { managedT3 } : {}),
    t3,
    fxModels: z
      .array(z.string().min(1).max(200))
      .max(100)
      .parse(JSON.parse(env.STUDIO_FX_MODELS_JSON ?? '[]')),
    remotePlanner: env.STUDIO_REMOTE_PLANNER === 'on',
    plannerVisuals:
      env.PLANNER_VISUALS === 'on' || env.STUDIO_PLANNER_VISUALS === 'on',
    ...(env.STUDIO_GATEWAY_BASE_URL
      ? {
          gatewayBaseUrl: trustedEndpoint(
            env.STUDIO_GATEWAY_BASE_URL,
            production,
          ),
        }
      : {}),
    ...(env.STUDIO_SEARCH_URL
      ? { searchUrl: trustedEndpoint(env.STUDIO_SEARCH_URL, production) }
      : {}),
    searchToken: env.STUDIO_SEARCH_TOKEN,
    openDesign,
  };
}
