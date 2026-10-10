import { notImplemented } from '@ai-bdd/sdk/contracts';
export type AcmeModel = Record<string, never>;
export const acmeModel: AcmeModel = {};
export function startAcmeApp(_opts?: { port?: number; adminPassword?: string; testToken?: string; flags?: string[] }): Promise<{ url: string; close(): Promise<void> }> {
  return notImplemented('testing.startAcmeApp');
}
