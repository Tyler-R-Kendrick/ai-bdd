import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

export type IntegrationSettings = {
  gatewayBaseUrl?: string;
  searchUrl?: string;
  searchToken?: string;
  remotePlanner?: boolean;
  plannerVisuals?: boolean;
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
  return {
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
